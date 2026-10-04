import { SQSClient } from "@aws-sdk/client-sqs";
import { createMockBreeze } from "./breeze-mock.js";
import { createConsumer } from "./consumer.js";
import { InMemoryRiderDirectory } from "./rider-directory.js";
import type { ProcessedIds } from "./process-event.js";
import { defaultTenantConfigStore } from "./tenant-config.js";

/**
 * Notification microservice entrypoint.
 *
 * Runs the SQS long-poll consumer against a real queue (dev queues for the
 * prototype — no local emulation). Configuration via environment:
 *
 *   SQS_QUEUE_URL        (required) URL of the inbound domain-events queue
 *   SQS_DLQ_URL          (optional) dead-letter queue URL (logging only;
 *                          redrive is configured on the queue itself)
 *   AWS_REGION           (default: us-east-1)
 *   AWS_ENDPOINT         (optional) custom SQS endpoint
 *   AWS credentials      standard environment variables / IAM role
 *   SIMULATOR_LOG_URL    (optional) scenario simulator log endpoint
 *   RIDER_DIRECTORY      (optional) JSON map of tenant_id -> rider_id[]
 */
function inMemorySeenIds(): ProcessedIds {
  const seen = new Set<string>();
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      seen.add(id);
    },
  };
}

function riderDirectoryFromEnv(): InMemoryRiderDirectory {
  const raw = process.env.RIDER_DIRECTORY;
  if (raw) {
    return new InMemoryRiderDirectory(JSON.parse(raw) as Record<string, string[]>);
  }
  // Prototype default so the service-disruption fan-out has riders to reach.
  return new InMemoryRiderDirectory({
    "demo-av-service": ["rider-demo-1", "rider-demo-2"],
  });
}

async function main(): Promise<void> {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    console.error("SQS_QUEUE_URL is required (URL of the inbound domain-events queue)");
    process.exit(1);
  }

  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT ? { endpoint: process.env.AWS_ENDPOINT } : {}),
  });

  const consumer = createConsumer({
    sqs,
    queueUrl,
    dlqUrl: process.env.SQS_DLQ_URL,
    breeze: createMockBreeze({ logUrl: process.env.SIMULATOR_LOG_URL }),
    seen: inMemorySeenIds(),
    riders: riderDirectoryFromEnv(),
    tenantConfigStore: defaultTenantConfigStore(),
  });

  const running = consumer.start();
  console.log(`notification microservice started (queue: ${queueUrl})`);

  const stop = async (signal: string) => {
    console.log(`${signal} received, stopping after in-flight work completes`);
    await consumer.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  await running;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
