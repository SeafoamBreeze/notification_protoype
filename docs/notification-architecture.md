# Notification Architecture

How Significant Events reach riders' Breeze apps. See `CONTEXT.md` for terminology and `docs/adr/` for the decisions behind each seam.

## Pipeline

```
Web app (transactions)                RabbitMQ                     Notification microservice                Breeze
  │                                     │                                  │                                │
  │  publishes Domain Events            │                                  │                                │
  │──{tenant, rider?, event, …}────────▶│  queue: notifications.inbound     │                                │
  │  (fire-and-forget, with retry)      │──────────────────────────────────▶│                                │
  │                                     │                                  │ 1. dedup (transaction id)      │
  │                                     │                                  │ 2. resolve target + template   │
  │                                     │                                  │ 3. BreezeClient.deliver()      │
  │                                     │                                  │───────────────────────────────▶│
  │                                     │◀───────────────── ack / nack ─────┤ 4. ack only on success         │
  │                                     │  retries → dead-letter queue      │                                │
```

**RabbitMQ never talks to Breeze.** The broker reliably moves messages between services; the microservice is the only component that knows about both. Each hop has its own contract: broker→microservice (ack/nack), microservice→Breeze (HTTP), Breeze→rider (black box).

## Components

| Component | Responsibility |
|---|---|
| **Web app** (to be developed) | Publishes Domain Events when actions complete. Knows nothing about notifications. |
| **RabbitMQ** | Durable hand-off. Holds messages while consumers are down. Single node. |
| **Notification microservice** | Consumes events, dedups, resolves target + wording, calls Breeze, acks on success. |
| **BreezeClient** | Adapter seam for the Breeze API. Mock in the prototype; real HTTP adapter when the spec lands. One-file swap. |
| **Scenario Simulator** (prototype) | Stands in for the web app; publishes events through the *real* broker path so the demo exercises the production seam. |

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

Requirements: **at-least-once delivery** with retries + dead-letter, and **deduplication**. (Ordering guarantees: not required for notifications.)

1. **Publish**: web app uses publisher confirms; on broker unavailability, retry with backoff.
2. **Consume**: manual ack. The microservice acks **only after** the Breeze call succeeds.
3. **Dedup**: before delivering, check `transaction_id` against a processed-IDs store; if seen, ack and skip. At-least-once means duplicates *will* arrive; dedup makes effective delivery exactly-once.
4. **Retry → DLQ**: failed Breeze call → nack → requeue with attempt counter. After N attempts (and backoff), route to a dead-letter queue. A poison message (Breeze API down for an hour) cannot clog the main queue. Alert on DLQ depth.
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

## Prototype scope

**In**: Scenario Simulator (buttons publishing `page_loaded`-style, `booking_confirmed`, `arrival_warning` through the real broker path) · RabbitMQ · Notification microservice (dedup, ack/nack, retry, DLQ) · mock BreezeClient that displays deliveries · visible event log for the demo.

**Out** (documented production concerns): the real web app · the real Breeze API adapter · live ETA delivery to Breeze · ridership/QR/GPS integration · bicycle-sharing stretch features.

## Open dependencies

| Dependency | Blocks | Owner |
|---|---|---|
| **Breeze API spec** (auth, payload format, rate limits, delivery receipts) | Real BreezeClient adapter | Ask the team that owns Breeze |
| **Deployment target / cloud** | Broker choice confirmation (ADR-0002: managed SQS/Pub-Sub becomes attractive if a cloud is settled) | Us |
| **User volumes per AV Service** | Fan-out sizing | Product |
