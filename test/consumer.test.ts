import { describe, expect, it } from "vitest";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
type AnyCommand = ReceiveMessageCommand | DeleteMessageCommand;
import { createConsumer, type FakeQueueEntry } from "../src/consumer.js";
import type { BreezeClient, BreezeNotification, ProcessedIds, RiderDirectory } from "../src/process-event.js";
import { defaultTenantConfigStore } from "../src/tenant-config.js";
import type { DomainEvent } from "../src/events.js";

/**
 * A minimal in-memory stand-in for SQS, driven at the same seam the consumer
 * uses (the SQSClient's `send` method). Records what was sent so tests can
 * assert on ReceiveMessage/DeleteMessage behavior.
 */
function fakeSqs(initialEntries: FakeQueueEntry[]): {
  client: SQSClient;
  entries: FakeQueueEntry[];
  receives: number;
  deletes: string[];
} {
  const state = {
    entries: [...initialEntries],
    receives: 0,
    deletes: [] as string[],
  };
  const client = {
    send: async (command: AnyCommand): Promise<unknown> => {
      // Real SQS long-poll blocks (network I/O), which yields to the event
      // loop. The in-memory fake must yield too, or the consumer's poll loop
      // becomes a pure microtask spin that starves timers (tests hang).
      await new Promise((resolve) => setImmediate(resolve));
      if (command instanceof ReceiveMessageCommand) {
        state.receives++;
        const count = command.input.MaxNumberOfMessages ?? 1;
        const messages = state.entries.splice(0, count);
        return {
          Messages: messages.map((entry) => ({
            MessageId: entry.messageId,
            ReceiptHandle: entry.receiptHandle,
            Body: entry.body,
          })),
        };
      }
      if (command instanceof DeleteMessageCommand) {
        state.deletes.push(command.input.ReceiptHandle!);
        return {};
      }
      throw new Error("unexpected SQS command");
    },
  } as unknown as SQSClient;
  // Getters (not a spread) so numeric counters like `receives` stay live;
  // a spread would copy the initial value by value.
  return {
    client,
    get entries() {
      return state.entries;
    },
    get receives() {
      return state.receives;
    },
    get deletes() {
      return state.deletes;
    },
  };
}

function recordingBreeze(): { breeze: BreezeClient; delivered: BreezeNotification[] } {
  const delivered: BreezeNotification[] = [];
  return {
    delivered,
    breeze: {
      deliver: async (n) => {
        delivered.push(n);
      },
    },
  };
}

function inMemorySeenIds(): ProcessedIds {
  const ids = new Set<string>();
  return { has: (id) => ids.has(id), add: (id) => ids.add(id) };
}

function staticRiderDirectory(ridersByTenant: Record<string, string[]>): RiderDirectory {
  return { listRiders: async (tenantId) => ridersByTenant[tenantId] ?? [] };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function bookingEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    event_id: "evt-c1",
    transaction_id: "txn-c1",
    tenant_id: "breeze-av",
    rider_id: "rider-1",
    type: "booking_confirmed",
    occurred_at: "2026-02-06T10:00:00Z",
    data: { booking_ref: "B-123" },
    ...overrides,
  };
}

describe("createConsumer", () => {
  it("receives a message, delivers the notification, and deletes the message", async () => {
    const sqs = fakeSqs([
      {
        messageId: "m1",
        receiptHandle: "rh-1",
        body: JSON.stringify(bookingEvent()),
      },
    ]);
    const { breeze, delivered } = recordingBreeze();
    const consumer = createConsumer({
      sqs: sqs.client,
      queueUrl: "https://sqs/test/queue",
      breeze,
      seen: inMemorySeenIds(),
      riders: staticRiderDirectory({}),
      tenantConfigStore: defaultTenantConfigStore(),
    });

    const running = consumer.start();
    await waitFor(() => delivered.length === 1);
    await consumer.stop();
    await running;

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "breeze-av",
        title: "Booking confirmed",
        body: "Your AV booking B-123 is confirmed.",
      },
    ]);
    expect(sqs.deletes).toEqual(["rh-1"]);
  });

  it("delivers a duplicated transaction_id only once", async () => {
    const sqs = fakeSqs([
      { messageId: "m1", receiptHandle: "rh-1", body: JSON.stringify(bookingEvent()) },
      {
        messageId: "m2",
        receiptHandle: "rh-2",
        body: JSON.stringify(bookingEvent({ event_id: "evt-c1-retry" })),
      },
    ]);
    const { breeze, delivered } = recordingBreeze();
    const consumer = createConsumer({
      sqs: sqs.client,
      queueUrl: "https://sqs/test/queue",
      breeze,
      seen: inMemorySeenIds(),
      riders: staticRiderDirectory({}),
      tenantConfigStore: defaultTenantConfigStore(),
    });

    const running = consumer.start();
    await waitFor(() => delivered.length === 1);
    await waitFor(() => sqs.deletes.length === 2);
    await consumer.stop();
    await running;

    expect(delivered).toHaveLength(1);
    expect(sqs.deletes).toEqual(["rh-1", "rh-2"]);
  });

  it("does not delete a message whose delivery fails, and keeps consuming", async () => {
    const event = bookingEvent();
    let breezeDown = true;
    const breeze: BreezeClient = {
      deliver: async (notification) => {
        if (breezeDown && notification.riderId === "rider-1") throw new Error("breeze down");
      },
    };
    const sqs = fakeSqs([
      { messageId: "m1", receiptHandle: "rh-1", body: JSON.stringify(event) },
      {
        messageId: "m2",
        receiptHandle: "rh-2",
        body: JSON.stringify(
          bookingEvent({ event_id: "evt-c2", transaction_id: "txn-c2", rider_id: "rider-2" }),
        ),
      },
    ]);
    const consumer = createConsumer({
      sqs: sqs.client,
      queueUrl: "https://sqs/test/queue",
      breeze,
      seen: inMemorySeenIds(),
      riders: staticRiderDirectory({}),
      tenantConfigStore: defaultTenantConfigStore(),
    });

    // Requeue the failed message (as SQS would after the visibility timeout
    // expires) and recover Breeze, so the consumer can retry and succeed.
    const requeue = () => {
      breezeDown = false;
      sqs.entries.push({ messageId: "m1", receiptHandle: "rh-1-retry", body: JSON.stringify(event) });
    };

    const running = consumer.start();
    // The unrelated second message is delivered and deleted: the consumer kept
    // going after the first failure.
    await waitFor(() => sqs.deletes.includes("rh-2"));
    requeue();
    // The retried message is now delivered and deleted.
    await waitFor(() => sqs.deletes.includes("rh-1-retry"));
    await consumer.stop();
    await running;

    expect(sqs.deletes).not.toContain("rh-1"); // first (failed) attempt was not deleted
    expect(sqs.deletes).toContain("rh-1-retry");
    expect(sqs.deletes).toContain("rh-2");
  });

  it("stops polling on stop()", async () => {
    const sqs = fakeSqs([]);
    const { breeze } = recordingBreeze();
    const consumer = createConsumer({
      sqs: sqs.client,
      queueUrl: "https://sqs/test/queue",
      breeze,
      seen: inMemorySeenIds(),
      riders: staticRiderDirectory({}),
      tenantConfigStore: defaultTenantConfigStore(),
    });

    const running = consumer.start();
    await waitFor(() => sqs.receives >= 1);
    await consumer.stop();
    await running;

    // stop() lets an in-flight poll finish (graceful shutdown), so snapshot
    // only once the loop promise has resolved: from here on, no new polls.
    const receivesAtEnd = sqs.receives;
    // Give a (buggy) loop a chance to poll again after stopping.
    await new Promise((r) => setTimeout(r, 20));
    expect(sqs.receives).toBe(receivesAtEnd);
  });
});
