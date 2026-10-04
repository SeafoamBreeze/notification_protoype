# AWS SQS as the message broker

The notification path needs a queue with at-least-once delivery, retries, and dead-lettering at notification volume (low-frequency Significant Events per rider, plus tenant-wide disruption fan-out). The deployment target is **AWS**, so we chose **AWS SQS (Standard queues)**: the reliability requirements are its native feature set and there is no broker to operate.

## Considered Options

- **RabbitMQ** (container on ECS): portable and feature-rich, but means operating a stateful broker container on AWS for no gain at this volume. Was the pre-AWS default; superseded once the deployment target was settled.
- **Kafka** (MSK): rejected for now — its advantages (replay, many full-stream consumers, high sustained throughput, events-as-record) are not needed by a work-queue notification flow. **Revisit trigger**: if the activity log or analytics later needs to *reprocess* historical events, that is the replay requirement that tips the balance. The publisher seam keeps this swap contained to the broker layer.
- **SQS FIFO**: offers content-based dedup, but adds throughput partitioning and ordering semantics we don't need; Standard queue + consumer-side dedup is simpler and fits at-least-once.

## Consequences

- **AWS lock-in** at the broker seam. Publisher and consumer only speak the SQS SDK, so a future swap is contained to those two edges.
- Reliability is configured, not coded: visibility timeout = in-progress; `DeleteMessage` after successful Breeze delivery = ack; redrive policy + `MaxReceiveCount` → dead-letter queue. Alert on DLQ depth.
- **Dev environment uses real AWS queues** (dev account), not an emulation — the first 1M requests/month are free, and this keeps dev identical to production.
- The microservice is **containerized from day one**: the container image is the CI/CD artifact (GitHub Actions → ECR → ECS/Fargate).
