import { randomUUID } from "node:crypto";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsumer, type Consumer } from "../../src/consumer.js";
import type { DomainEvent } from "../../src/events.js";
import type { BreezeClient, BreezeNotification, ProcessedIds, RiderDirectory } from "../../src/process-event.js";
import { DefaultTenantConfigStore } from "../../src/tenant-config.js";

/**
 * Integration seam: simulator-shaped publication → real dev queue →
 * microservice consumer → BreezeClient.
 *
 * Runs against the real dev queues (no local emulation), so it is skipped
 * unless SQS_QUEUE_URL is set (plus standard AWS credentials):
 *
 *   SQS_QUEUE_URL=<dev-queue-url> AWS_REGION=eu-west-1 npm test
 */
const queueUrl = process.env.SQS_QUEUE_URL;

describe("dev-queue integration", { skip: !queueUrl }, () => {
  let sqs: SQSClient;
  let consumer: Consumer;
  let running: Promise<void> | undefined;
  const delivered: BreezeNotification[] = [];

  const recordingBreeze: BreezeClient = {
    async deliver(notification) {
      delivered.push(notification);
    },
  };

  const inMemorySeenIds = (): ProcessedIds => {
    const seen = new Set<string>();
    return { has: (id) => seen.has(id), add: (id) => seen.add(id) };
  };

  const noRiders: RiderDirectory = { listRiders: async () => [] };

  function publish(event: DomainEvent): Promise<void> {
    return sqs
      .send(new SendMessageCommand({ QueueUrl: queueUrl!, MessageBody: JSON.stringify(event) }))
      .then(() => {});
  }

  function bookingEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
    return {
      event_id: randomUUID(),
      transaction_id: randomUUID(),
      tenant_id: "integration-test",
      rider_id: "rider-integration",
      type: "booking_confirmed",
      occurred_at: new Date().toISOString(),
      data: { booking_ref: `AV-IT-${randomUUID().slice(0, 8)}` },
      ...overrides,
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Drain any messages left in the dev queue so tests start and end clean. */
  async function drainQueue(): Promise<void> {
    for (;;) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl!, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      if (!Messages?.length) return;
      await Promise.all(
        Messages.map((m) =>
          sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl!, ReceiptHandle: m.ReceiptHandle! })),
        ),
      );
    }
  }

  beforeAll(async () => {
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? "eu-west-1",
      ...(process.env.AWS_ENDPOINT ? { endpoint: process.env.AWS_ENDPOINT } : {}),
    });
    await drainQueue();
    consumer = createConsumer({
      sqs,
      queueUrl: queueUrl!,
      breeze: recordingBreeze,
      seen: inMemorySeenIds(),
      riders: noRiders,
      tenantConfigStore: new DefaultTenantConfigStore(),
    });
    running = consumer.start();
  });

  afterAll(async () => {
    await consumer.stop();
    await running;
    await drainQueue();
  });

  it("delivers a published event and deletes the message (happy path)", async () => {
    const event = bookingEvent();
    const ref = String(event.data.booking_ref);
    await publish(event);
    await waitFor(() => delivered.some((n) => n.body.includes(ref)));
    expect(delivered.find((n) => n.body.includes(ref))).toMatchObject({
      riderId: event.rider_id,
      tenantId: event.tenant_id,
      title: "Booking confirmed",
    });
  });

  it("delivers a republished transaction exactly once (dedup)", async () => {
    const event = bookingEvent();
    const ref = String(event.data.booking_ref);
    await publish(event);
    await publish({ ...event, event_id: randomUUID() }); // same transaction_id
    await waitFor(() => delivered.some((n) => n.body.includes(ref)));
    // Give a (buggy) consumer time to deliver a duplicate.
    await sleep(2000);
    expect(delivered.filter((n) => n.body.includes(ref)).length).toBe(1);
  });
});

// Full redrive to the DLQ takes ~5 minutes (5 receives × 60s visibility
// timeout on the dev queue), so it runs only when explicitly requested:
//
//   SQS_QUEUE_URL=... SQS_DLQ_URL=... INTEGRATION_SLOW=1 npm test

describe("dev-queue integration: DLQ redrive (slow)", {
  skip: !queueUrl || !process.env.INTEGRATION_SLOW,
}, () => {
  const dlqUrl = process.env.SQS_DLQ_URL;

  it("redrives a chronically failing message to the DLQ after MaxReceiveCount", async () => {
    if (!dlqUrl) throw new Error("SQS_DLQ_URL is required for the DLQ redrive test");
    const sqs = new SQSClient({
      region: process.env.AWS_REGION ?? "eu-west-1",
      ...(process.env.AWS_ENDPOINT ? { endpoint: process.env.AWS_ENDPOINT } : {}),
    });

    const attempts: string[] = [];
    const failingBreeze: BreezeClient = {
      async deliver(n) {
        attempts.push(n.body);
        throw new Error("breeze down (forced)");
      },
    };
    const seen = new Set<string>();
    const consumer = createConsumer({
      sqs,
      queueUrl: queueUrl!,
      breeze: failingBreeze,
      seen: { has: (id) => seen.has(id), add: (id) => seen.add(id) },
      riders: { listRiders: async () => [] },
      tenantConfigStore: new DefaultTenantConfigStore(),
    });
    const running = consumer.start();

    try {
      const event = {
        event_id: randomUUID(),
        transaction_id: randomUUID(),
        tenant_id: "integration-test",
        rider_id: "rider-integration",
        type: "booking_confirmed" as const,
        occurred_at: new Date().toISOString(),
        data: { booking_ref: `AV-IT-${randomUUID().slice(0, 8)}` },
      };
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl!, MessageBody: JSON.stringify(event) }));

      // Wait for the message to accumulate MaxReceiveCount receives and
      // land in the DLQ (bounded at 8 minutes; dev queue redrive is ~5).
      const start = Date.now();
      for (;;) {
        const { Messages } = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10 }),
        );
        if (Messages?.length) {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: Messages[0].ReceiptHandle! }));
          break;
        }
        if (Date.now() - start > 8 * 60_000) throw new Error("message never reached the DLQ");
      }
      expect(attempts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await consumer.stop();
      await running;
    }
  }, 10 * 60_000);
});
