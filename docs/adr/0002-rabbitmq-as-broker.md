# RabbitMQ as the message broker

The notification path needs a queue with at-least-once delivery, retries, and dead-lettering at notification volume (low-frequency Significant Events per rider, plus tenant-wide disruption fan-out). We chose **RabbitMQ** (single node, Docker Compose for local dev).

## Considered Options

- **Kafka**: rejected for now — its advantages (replay, many full-stream consumers, high sustained throughput, events-as-record) are not needed by a work-queue notification flow. **Revisit trigger**: if the activity log or analytics later needs to *reprocess* historical events, that is the replay requirement that tips the balance. The publisher seam keeps this swap contained to the broker layer.
- **Redis Streams**: rejected — only wins if Redis is already in the stack, and it lacks a native dead-letter queue, so retry/DLQ logic would be hand-rolled.
- **Managed queue (AWS SQS / GCP Pub-Sub)**: legitimate if the deployment target is settled on that cloud (less to operate); deferred until the deployment target is known.

## Consequences

- Reliability is configured, not coded: publisher confirms, consumer acks only after successful Breeze delivery, nack → requeue with retry, then dead-letter exchange after N attempts.
- A future ops responsibility: one more stateful service to monitor (queue depths, DLQ contents).
