# AV Booking Notification Microservice

Delivers rider notifications (Breeze) for autonomous-vehicle (AV) bookings,
decoupled from the (future) transactional web app by **AWS SQS**. Producers
publish **Domain Events** to a queue; this service consumes them, decides what
each rider should be told, and delivers via a **BreezeClient** adapter (mocked
in the prototype). At-least-once delivery with consumer-side deduplication,
retries, and a dead-letter queue: a Breeze outage means riders are notified
late, never lost.

See `docs/notification-architecture.md` for the design and `CONTEXT.md` for the
domain language. UI reference screenshots live in `sample_ui/`.

## How it fits together

```
Scenario Simulator ──publish──▶ SQS queue ──consume──▶ Microservice ──deliver──▶ Breeze (mock)
      (web app stand-in)        (dev queue)                     │
                                                                └── failure ×5 ──▶ dead-letter queue
```

| Path | What it is |
| --- | --- |
| `src/consumer.ts` | SQS long-poll consumer: receive → process → delete |
| `src/process-event.ts` | Event → Breeze delivery(ies); dedup, tenant templates, bounded fan-out |
| `src/breeze-mock.ts` | Prototype BreezeClient (the single Breeze adapter seam) |
| `src/main.ts` | Microservice entrypoint (runs against real queues) |
| `src/simulator.ts` | Scenario Simulator: stands in for the web app; booking form + visible inbox |
| `infra/` | Terraform: dev queues + dead-letter queue + DLQ alarm (see `infra/README.md`) |

## Prerequisites

- **Node.js 20+** (tested on Node 24)
- For the *local demo* only: nothing else — no AWS account, no credentials
- For *real AWS*: AWS credentials with SQS access and [Terraform](https://developer.hashicorp.com/terraform) (see below)

Run `npm install` once first.

## Quick start: local demo (no AWS)

A tiny in-memory SQS stub (`.scratch/stub-sqs.mjs`, AWS JSON 1.0 protocol)
stands in for the queue, so the full chain — simulator → queue → microservice
→ mock Breeze — runs on your machine.

Open **three terminals** in this directory:

**Terminal 1 — the SQS stub**

```sh
node .scratch/stub-sqs.mjs        # listens on http://localhost:9421
```

**Terminal 2 — the microservice**

```sh
# unix / Git Bash
SQS_QUEUE_URL=http://localhost:9421/queue \
AWS_ENDPOINT=http://localhost:9421 \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
SIMULATOR_LOG_URL=http://localhost:3000/log-entry \
npm start

# Windows PowerShell
$env:SQS_QUEUE_URL="http://localhost:9421/queue"; $env:AWS_ENDPOINT="http://localhost:9421"; $env:AWS_REGION="us-east-1"; $env:AWS_ACCESS_KEY_ID="test"; $env:AWS_SECRET_ACCESS_KEY="test"; $env:SIMULATOR_LOG_URL="http://localhost:3000/log-entry"; npm start
```

**Terminal 3 — the scenario simulator**

```sh
# unix / Git Bash
SQS_QUEUE_URL=http://localhost:9421/queue \
AWS_ENDPOINT=http://localhost:9421 \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
npm run simulator

# Windows PowerShell
$env:SQS_QUEUE_URL="http://localhost:9421/queue"; $env:AWS_ENDPOINT="http://localhost:9421"; $env:AWS_REGION="us-east-1"; $env:AWS_ACCESS_KEY_ID="test"; $env:AWS_SECRET_ACCESS_KEY="test"; npm run simulator
```

Then open **<http://localhost:3000>** and use the Breeze-styled UI:

- Fill in the **New AV booking** form and press *Submit AV booking request* →
  a `booking_confirmed` event is published; a "Booking confirmed" card appears
  in the Inbox within a second.
- **AV arriving in 10 mins** → `arrival_warning` for the last booking.
- **Service disruption** → fans out to *all* riders of the tenant.

The Inbox shows the cause-and-effect chain (published event → delivered
notification). The microservice terminal also logs each delivery.

> The stub is in-memory: restarting it empties the queue. That is fine for the
> demo; use the real queues below for anything durable.

## Running against real AWS dev queues

1. **Create the queues** (once):

   ```sh
   cd infra
   terraform init
   terraform apply        # dev-queue + dev-dlq + DLQ alarm in $AWS_REGION
   terraform output       # copy queue_url / dlq_url
   ```

   See `infra/README.md` for details. Your environment needs
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (default region:
   `eu-west-1`).

2. **Run the microservice and simulator** as in the quick start, but with the
   real queue URL and **without** `AWS_ENDPOINT` / dummy credentials:

   ```sh
   # terminal 1
   SQS_QUEUE_URL=<queue_url from terraform output> \
   SIMULATOR_LOG_URL=http://localhost:3000/log-entry npm start

   # terminal 2
   SQS_QUEUE_URL=<queue_url from terraform output> npm run simulator
   ```

## Tests

```sh
npm test           # unit tests (BreezeClient / process-event / consumer seams)
npm run typecheck
npm run build      # compile to dist/ (what the Dockerfile does)
```

**Integration tests** exercise the full chain against the *real* dev queue
(publish → deliver, dedup, DLQ redrive). They skip automatically without
`SQS_QUEUE_URL`:

```sh
SQS_QUEUE_URL=<dev-queue-url> npm test

# the DLQ-redrive test takes ~5 minutes (5 receives × 60s visibility timeout);
# include it with:
SQS_QUEUE_URL=<dev-queue-url> SQS_DLQ_URL=<dlq-url> INTEGRATION_SLOW=1 npm test
```

## Deployment

`Dockerfile` (multi-stage: build TS → `dist/`, run as non-root) +
`.github/workflows/ci.yml`: push to `main` builds the container, pushes it to
ECR, and deploys to ECS/Fargate. Uses GitHub OIDC (no long-lived AWS keys in
CI); requires a `DEPLOY_ROLE_ARN` secret and `AWS_REGION` / `ECR_REPOSITORY` /
`ECS_CLUSTER` / `ECS_SERVICE` vars in the repo settings. The ECS task needs
`SQS_QUEUE_URL` in its environment.

## Known prototype shortcuts

- Dedup state (`ProcessedIds`) and tenant config are in-memory — lost on
  restart. Production: durable store (e.g. DynamoDB).
- Breeze is mocked (`src/breeze-mock.ts`); the adapter seam is ready for the
  real API.
- The DLQ alarm has no notification channel attached yet (add an SNS topic).
