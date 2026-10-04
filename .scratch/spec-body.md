## Problem Statement

Riders book autonomous vehicles (AVs) through a web app, but the product has no notification path: when a booking is confirmed or the vehicle is about to arrive, nobody tells the rider's Breeze mobile app. There is also no working demonstration that such notifications would flow reliably from the transactional web app to Breeze, which is needed to validate the approach before the web app is built. Breeze is a black box owned by another team (integration surface: the Breeze API, spec not yet available).

## Solution

A **notification microservice** decoupled from the (future) web app by **AWS SQS**. The web app — or, in the prototype, a **Scenario Simulator** standing in for it — publishes **Domain Events** to a queue; the microservice consumes them, decides what each rider should be told, and delivers via a **BreezeClient** adapter (mocked in the prototype, real Breeze API adapter later). Deliveries are at-least-once with deduplication, retries, and a dead-letter queue, so a Breeze outage means riders are notified late, never lost, and the publishing side never notices. The prototype is demonstrable end-to-end: buttons publish real events through the real production seam, and a visible log shows event → delivery.

## User Stories

1. As a demo presenter, I want buttons that simulate the notification scenarios (booking confirmed, vehicle arriving in 10 minutes), so that I can show the notification flow without the real web app or vehicles.
2. As a demo presenter, I want a visible event log showing each published event and each resulting delivery, so that the audience can see the cause-and-effect chain, not just a message appearing.
3. As a demo presenter, I want the demo to run against real AWS queues, so that what I demonstrate is the actual production seam, not a simulation of it.
4. As a rider, I want a notification in Breeze when my AV booking is confirmed, so that I know my trip is locked in.
5. As a rider, I want a notification in Breeze when my vehicle is about 10 minutes away, so that I can get ready to meet it.
6. As a rider, I want disruption notifications when my AV Service's routes or schedules are affected, so that I can adjust my plans.
7. As a rider, I want notifications addressed to me specifically (not to other riders), so that I am not distracted by other people's trips.
8. As a rider, I want to receive each notification exactly once in effect, so that duplicate messages do not erode trust in the product.
9. As a rider, I want to still receive my notification — late rather than lost — if Breeze or the notification path had a temporary outage, so that time-sensitive information is not silently dropped.
10. As the web app team (future), I want to notify riders by publishing a JSON event to a queue with no knowledge of Breeze, notification wording, or delivery mechanics, so that our transactional code stays simple and untouched by notification changes.
11. As the web app team (future), I want publishing a notification event to never block or fail my transaction because the notification path is slow or down, so that booking reliability is independent of notification reliability.
12. As a platform developer, I want a single BreezeClient adapter seam for all Breeze delivery, so that swapping the mock for the real Breeze API is a one-file change when the spec arrives.
13. As a platform developer, I want failed deliveries retried and then moved to a dead-letter queue, so that a poison message cannot clog the main queue.
14. As a platform operator, I want an alert when the dead-letter queue accumulates messages, so that chronic delivery failures are investigated.
15. As a platform operator, I want separate queues per environment (dev/prod), so that prototype traffic never reaches real riders.
16. As a platform operator, I want the microservice deployed as a container through GitHub Actions → ECR → ECS/Fargate, so that the CI/CD pipeline is in place before the real web app arrives.
17. As a platform developer, I want every event to carry the tenant (AV Service) ID, so that multiple AV services can be onboarded without schema changes.
18. As a platform developer, I want notification behavior (enabled event types, message templates) configured per AV Service, so that onboarding a new AV service is configuration, not code.
19. As a future activity-log or analytics team, I want to consume the same Domain Events the notification service consumes, so that new consumers need no changes to producers.
20. As a rider, I want tenant-wide disruption events fanned out to many riders without stalling delivery of other riders' time-sensitive events (e.g. arrival warnings), so that one large fan-out does not delay my "arriving in 10 minutes" notice.
21. As a platform developer, I want the microservice to survive restarts mid-processing without losing or double-losing in-flight messages, so that deploys do not drop notifications.
22. As a demo presenter, I want to run the microservice and simulator from my local machine against the dev queues, so that I can iterate and demo without a full deployment.

## Implementation Decisions

- **Architecture**: event-driven, async. Producers publish Domain Events to AWS SQS; the notification microservice consumes and delivers. Rationale and rejected alternatives (synchronous HTTP, RabbitMQ, Kafka, FIFO) are recorded in ADR-0001 and ADR-0002.
- **Broker**: AWS SQS **Standard** queues (at-least-once). One inbound queue per environment plus a dead-letter queue with a redrive policy (`MaxReceiveCount` small, e.g. 3–5). No local emulation: dev uses real queues in a dev AWS account (free tier covers the prototype).
- **Event contract** (from the architecture doc; the schema is the cross-service contract):

  ```jsonc
  {
    "event_id":       "uuid",   // unique per publication
    "transaction_id": "uuid",   // dedup key — same transaction republished ⇒ same value
    "tenant_id":      "av-service-id",
    "rider_id":       "… | null",  // null for tenant-wide events
    "type":           "booking_confirmed | arrival_warning | service_disruption | …",
    "occurred_at":    "iso-8601",
    "data":           { }        // type-specific payload
  }
  ```

- **Producers state facts, not intentions** (`booking_confirmed`, never `send_notification`).
- **Significant Events only** on this path. High-frequency telemetry (live ETA) is excluded; the future web app serves it via SSE/polling, and any Breeze ETA delivery is throttled/batched, never streamed raw.
- **Reliability model**: long polling; the SQS visibility timeout is the in-progress marker; the message is deleted only after a successful Breeze delivery (ack). Failure → not deleted → redelivery after the visibility timeout → DLQ after `MaxReceiveCount`.
- **Dedup**: consumer-side, keyed on `transaction_id`, against a processed-IDs store; duplicates are deleted and skipped. (Covers Standard-queue at-least-once; makes effective delivery exactly-once.)
- **BreezeClient**: the single delivery adapter seam. Prototype ships a mock that displays/log deliveries. The real Breeze API HTTP adapter is a later, one-file swap gated on the Breeze API spec.
- **Targeting**: rider-scoped events (Booking Confirmation, Arrival Warning) target `rider_id`; Service Disruption fans out to all riders of the tenant. Fan-out must be batched with bounded in-flight requests so a large tenant fan-out cannot stall the consumer.
- **Multi-tenancy**: `tenant_id` mandatory in every event; per-tenant configuration of enabled event types, templates, and (possibly) Breeze API credentials.
- **Scenario Simulator**: prototype UI with buttons per scenario; publishes through the real dev queue using the same event contract the future web app will use. Includes the visible event log (demo chrome).
- **Deployment**: microservice containerized from day one; GitHub Actions → ECR → ECS/Fargate. Local development runs the microservice and simulator on a developer machine pointed at dev queues via endpoint + IAM credentials in environment variables.
- **Stack**: Node/TypeScript end-to-end.

## Testing Decisions

Good tests assert **external behavior only**: given an event, what did the delivery boundary receive (or not receive), and what is the queue's resulting state. No tests on internal wiring, function structure, or mock call choreography beyond the seam.

Two seams, both at the highest useful point:

1. **`BreezeClient` (primary seam)** — unit-level tests of the microservice drive it with events and assert what `BreezeClient` received: correct target (rider/tenant), correct wording per event type and tenant template, dedup suppression of repeated `transaction_id`s, and tenant filtering (disabled event types not delivered). The mock BreezeClient is both the test double and the demo display.
2. **SQS dev queue (integration seam)** — a small number of end-to-end tests: simulator → real dev queue → microservice → mock BreezeClient. Cases: happy path (delivered + message deleted); duplicate publication (exactly one delivery); forced BreezeClient failure (message redrives and lands in the DLQ after `MaxReceiveCount`).

The simulator itself is a thin publisher — no dedicated tests beyond the integration path. The visible event log is demo chrome, not behavior under test. No prior art exists (greenfield repo); these two seams are the first testing convention for the codebase.

## Out of Scope

- The real transactional web app (the simulator stands in for it).
- The real Breeze API adapter (blocked on the Breeze API spec from Breeze's team).
- Live ETA / telemetry delivery (web-app-side SSE/polling; Breeze ETA throttling is a documented production concern).
- Ridership tracking (QR/GPS/BT boarding), activity log service, bicycle-sharing stretch features.
- Ordering guarantees, SQS FIFO, Kafka/replay capabilities (named revisit trigger in ADR-0002: reprocessing historical events).
- Local AWS emulation (LocalStack) — dev uses real queues.
- Production environment setup, monitoring/alerting tooling beyond the DLQ-depth alert requirement.
- Authentication/authorization for the simulator (prototype-only UI).

## Further Notes

- Terminology follows `CONTEXT.md` (Domain Event, Significant Event, AV Service, Rider, Breeze, BreezeClient, Scenario Simulator). Decisions follow ADR-0001 (async event-driven communication) and ADR-0002 (AWS SQS as broker); the full design lives in `docs/notification-architecture.md`.
- `sample_ui/` contains Breeze app screenshots of the three core scenarios (trip submission → confirmation → "arriving in 10 min"); they are the visual reference for expected notification behavior.
- Open dependencies: Breeze API spec (blocks real adapter only), a dev AWS account (blocks queue creation), user volumes per AV Service (informs fan-out sizing).
- Suggested build order: SQS resources (queues + DLQ) → notification microservice (consumer, dedup, mock BreezeClient) → scenario simulator → container + GitHub Actions pipeline.
