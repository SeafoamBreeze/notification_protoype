# Async, event-driven communication between the web app and the notification service

The web app (transactional, to be developed) and the notification microservice are separate services that must scale independently to production level. We decided they communicate **asynchronously via Domain Events on a message broker**, not synchronous HTTP: the web app publishes facts (`booking_confirmed`, `arrival_warning`, …) to a queue; the notification service subscribes and decides what riders are told.

## Considered Options

- **Synchronous HTTP** (web app calls the notification service and waits): rejected — a slow or down notification service would block bookings, consumers can't scale independently, and every new consumer (activity log, analytics) would require web app changes.
- **Async via message broker**: accepted — failures at the notification path are contained (messages queue up while Breeze is down; riders are notified late, not lost), producers and consumers scale and evolve independently, and new consumers subscribe without producer changes.

## Consequences

- Producers must treat publishing as fire-and-forget-with-retry; they never learn delivery outcome.
- Delivery is **at-least-once**: consumers must deduplicate (see ADR-0002's reliability notes in `docs/notification-architecture.md`).
- Event schemas are a cross-service contract: they must carry the AV Service (tenant) ID from day one.
