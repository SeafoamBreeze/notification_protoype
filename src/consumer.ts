import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { DomainEvent } from "./events.js";
import {
  processEvent,
  type BreezeClient,
  type ProcessedIds,
  type RiderDirectory,
} from "./process-event.js";
import type { TenantConfigStore } from "./tenant-config.js";

/** Shape of a queue entry as used by the in-memory SQS stand-in in tests. */
export interface FakeQueueEntry {
  messageId: string;
  receiptHandle: string;
  body: string;
}

export interface ConsumerDependencies {
  sqs: SQSClient;
  queueUrl: string;
  /** Dead-letter queue (for logging; redrive is configured on the queue itself). */
  dlqUrl?: string;
  breeze: BreezeClient;
  seen: ProcessedIds;
  riders: RiderDirectory;
  tenantConfigStore: TenantConfigStore;
}

export interface Consumer {
  /** Starts the long-poll loop; resolves when the consumer stops. */
  start(): Promise<void>;
  /** Stops after the current poll/message completes (graceful shutdown). */
  stop(): Promise<void>;
}

/**
 * SQS long-poll consumer: receive → process → delete.
 *
 * Reliability model (see docs/notification-architecture.md): the SQS visibility
 * timeout is the in-progress marker; a message is deleted only after a
 * successful Breeze delivery. On failure the message is NOT deleted, so it
 * reappears after the visibility timeout and lands in the DLQ after
 * MaxReceiveCount redrives.
 */
export function createConsumer(deps: ConsumerDependencies): Consumer {
  let stopping = false;
  let loop: Promise<void> | undefined;

  const processMessage = async (message: { Body?: string; ReceiptHandle?: string }) => {
    const event = JSON.parse(message.Body!) as DomainEvent;
    await processEvent(
      event,
      deps.breeze,
      deps.seen,
      deps.riders,
      deps.tenantConfigStore,
    );
    await deps.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: deps.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  };

  const pollOnce = async () => {
    const response = await deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: deps.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
      }),
    );
    for (const message of response.Messages ?? []) {
      try {
        await processMessage(message);
      } catch (err) {
        // Not deleted: redelivery after the visibility timeout, DLQ after
        // MaxReceiveCount.
        console.error(
          `delivery failed (message will be redelivered; DLQ: ${deps.dlqUrl ?? "n/a"}):`,
          err,
        );
      }
    }
  };

  return {
    start() {
      stopping = false;
      loop = (async () => {
        while (!stopping) {
          await pollOnce();
        }
      })();
      return loop;
    },
    async stop() {
      stopping = true;
      await loop;
    },
  };
}
