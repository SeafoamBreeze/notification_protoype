# Notification Architecture

How Significant Events reach riders' Breeze apps. See `CONTEXT.md` for terminology and `docs/adr/` for the decisions behind each seam.

## Pipeline

```
Web app (transactions)              AWS SQS                        Notification microservice                Breeze
  │  (container on ECS/Fargate)      │  queue: notifications.inbound │  (container on ECS/Fargate)             │
  │  publishes Domain Events         │        + dead-letter queue    │                                │
  │──{tenant, rider?, event, …}────────▶│───────────────────────────────▶│                                │
  │  (send with SDK retry)          │  receive (long poll),          │ 1. dedup (transaction id)      │
  │                                 │  visibility timeout = in-progress│ 2. resolve target + template   │
  │                                 │                                │ 3. BreezeClient.deliver()      │
  │                                 │◀──────── DeleteMessage = ack ────┤ 4. delete only on success      │
  │                                 │  not deleted → revisible →      │                                │
  │                                 │  MaxReceiveCount → DLQ          │                                │
```

**SQS never talks to Breeze.** The queue reliably moves messages between services; the microservice is the only component that knows about both. Each hop has its own contract: queue→microservice (visibility timeout / delete), microservice→Breeze (HTTP), Breeze→rider (black box).

## Components

| Component | Responsibility |
|---|---|
| **Web app** (to be developed) | Publishes Domain Events when actions complete. Knows nothing about notifications. |
| **AWS SQS** | Durable hand-off. Standard queue + DLQ with redrive policy. Run by AWS — nothing to operate. |
| **Notification microservice** | Consumes events (long polling), dedups, resolves target + wording, calls Breeze, deletes the message on success. Containerized; deployed via GitHub Actions → ECR → ECS/Fargate. |
| **BreezeClient** | Adapter seam for the Breeze API. Mock in the prototype; real HTTP adapter when the spec lands. One-file swap. |
| **Scenario Simulator** (prototype) | Stands in for the web app; publishes events to the *real* queue so the demo exercises the production seam. |

## Event contract

Every Domain Event carries, from day one:

```jsonc
{
  "event_id":      "uuid",          // unique per publication
  "transaction_id":"uuid",          // dedup key — same transaction republished ⇒ same value
  "tenant_id":     "av-service-id", // AV Service (multi-tenancy is in the schema, not an afterthought)
  "rider_id":      "… | null",      // null for tenant-wide events
  "type":          "booking_confirmed | arrival_warning | service_disruption | …",
  "occurred_at":   "iso-8601",
  "data":          { /* type-specific payload */ }
}
```

Rules:

- **Producers state facts, not intentions** — `booking_confirmed`, never `send_notification`. New consumers (activity log, analytics) subscribe without producer changes.
- **Significant Events only.** High-frequency telemetry (live ETA) does *not* ride this path — the web app serves it via SSE/polling. If Breeze ever needs ETAs, they are throttled/batched (e.g. emit only on >1 min change), never streamed raw.

## Reliability model

Requirements: **at-least-once delivery** with retries + dead-letter, and **deduplication**. (Ordering guarantees: not required for notifications. Standard queues, not FIFO — consumer-side dedup covers duplicates.)

1. **Publish**: web app sends via SDK (built-in retries with backoff on AWS unavailability).
2. **Consume**: long polling; the **visibility timeout** is the "in-progress" marker — the message is hidden from other workers while processed and reappears automatically if the worker dies (this is where at-least-once comes from).
3. **Dedup**: before delivering, check `transaction_id` against a processed-IDs store; if seen, delete and skip. Duplicates *will* arrive; dedup makes effective delivery exactly-once.
4. **Retry → DLQ**: Breeze call failed → do *not* delete → message becomes visible again after the timeout → redelivered. After `MaxReceiveCount` (e.g. 3–5), the redrive policy moves it to the **dead-letter queue**. A poison message (Breeze API down for an hour) cannot clog the main queue. Alert on DLQ depth.
5. **Breeze outage**: messages accumulate in the queue; riders are notified late, not lost. The web app never notices.

## Targeting and fan-out

| Event | Target |
|---|---|
| Booking Confirmation, Arrival Warning | the specific rider (`rider_id`) |
| Service Disruption | all riders of the affected AV Service (tenant-wide) |

Tenant-wide events fan out to N Breeze calls. The microservice must fan out **without blocking** the consumer (batch the calls, bound in-flight requests) so one disruption event for a large tenant doesn't stall the queue. Exact user volumes per AV Service are unknown — design for low thousands per event.

## Multi-tenancy

- `tenant_id` is mandatory in the event contract (above).
- Notification behavior is per-tenant: which event types are enabled, message templates, and (possibly) per-tenant Breeze API credentials.
- Onboarding a new AV Service = configuration, not code.

## Environments

- **Dev and production both use real AWS queues** (separate queues per environment, e.g. `notifications.inbound.dev` / `.prod`, each with its own DLQ). No local emulation — the free tier (1M requests/month) covers the prototype, and dev stays identical to production.
- **Local machine** runs only the microservice code and the simulator, pointed at the dev queues via endpoint + IAM credentials in env vars.
- **CI/CD**: GitHub Actions → build container image → push to ECR → deploy to ECS/Fargate. The container image is the artifact.

## Prototype scope

**In**: Scenario Simulator (buttons publishing `booking_confirmed`, `arrival_warning`, … to the real dev queue) · SQS queue + DLQ in a dev AWS account · Notification microservice (dedup, visibility-timeout semantics, redrive → DLQ) · mock BreezeClient that displays deliveries · visible event log for the demo.

**Out** (documented production concerns): the real web app · the real Breeze API adapter · live ETA delivery to Breeze · ridership/QR/GPS integration · bicycle-sharing stretch features.

## Open dependencies

| Dependency | Blocks | Owner |
|---|---|---|
| **Breeze API spec** (auth, payload format, rate limits, delivery receipts) | Real BreezeClient adapter | Ask the team that owns Breeze |
| **AWS account** (dev) | Queue creation, credentials for local runs | Us |
| **User volumes per AV Service** | Fan-out sizing | Product |
