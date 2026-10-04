# AV Booking Notification Microservice

Delivers rider notifications (Breeze) for autonomous-vehicle bookings, decoupled
from the (future) transactional web app by **AWS SQS**. Producers publish
**Domain Events** to a queue; this service consumes them, decides what each
rider should be told, and delivers via a **BreezeClient** adapter (mocked in
the prototype). At-least-once delivery with consumer-side deduplication,
retries, and a dead-letter queue: a Breeze outage means riders are notified
late, never lost.

See `docs/notification-architecture.md` for the design and `CONTEXT.md` for
the domain language.

## Components

| Path | What it is |
| --- | --- |
| `src/consumer.ts` | SQS long-poll consumer: receive → process → delete |
| `src/process-event.ts` | Event → Breeze delivery(ies); dedup, tenant templates, bounded fan-out |
| `src/breeze-mock.ts` | Prototype BreezeClient (the single Breeze adapter seam) |
| `src/main.ts` | Microservice entrypoint (runs against real queues) |
| `src/simulator.ts` | Scenario Simulator: stands in for the web app; publishes real events + visible log |
| `infra/` | Terraform: dev queues + dead-letter queue (see `infra/README.md`) |

## Run locally (against the dev queues)

No local emulation — the prototype uses real dev queues in the dev AWS account.
You need AWS credentials with SQS access (e.g. `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_REGION` in the environment) and the queue URLs
from `terraform output` (see `infra/README.md`).

```sh
npm install

# terminal 1 — the microservice
# (SIMULATOR_LOG_URL forwards each delivery to the simulator's visible log)
SQS_QUEUE_URL=<dev-queue-url> SIMULATOR_LOG_URL=http://localhost:3000/log-entry npm start

# terminal 2 — the scenario simulator
SQS_QUEUE_URL=<dev-queue-url> npm run simulator
```

Open <http://localhost:3000> and press the scenario buttons. Each press
publishes a real event to the dev queue; the microservice delivers it via the
mock Breeze (visible in its terminal), and the simulator's log shows the
published → delivered chain on one screen.

## Offline smoke test (no AWS needed)

`.scratch/stub-sqs.mjs` is a tiny in-memory SQS stub (AWS JSON 1.0) for
exercising the full chain locally — simulator → queue → microservice → mock
Breeze — without AWS credentials:

```sh
node .scratch/stub-sqs.mjs &
SQS_QUEUE_URL=http://localhost:9421/queue AWS_ENDPOINT=http://localhost:9421 \
  AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  SIMULATOR_LOG_URL=http://localhost:3000/log-entry npm start
SQS_QUEUE_URL=http://localhost:9421/queue AWS_ENDPOINT=http://localhost:9421 \
  AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npm run simulator
```

## Tests

```sh
npm test        # unit tests (BreezeClient seam)
npm run typecheck
```

Integration tests against the real dev queue (simulator → queue → microservice
→ mock Breeze, including dedup and DLQ redrive) are the second test seam; see
`docs/notification-architecture.md`.

## Deployment

`Dockerfile` + `.github/workflows/ci.yml`: push to `main` builds the container,
pushes it to ECR, and deploys to ECS/Fargate (OIDC; requires `DEPLOY_ROLE_ARN`
secret and `AWS_REGION` / `ECR_REPOSITORY` / `ECS_CLUSTER` / `ECS_SERVICE`
vars in the repo settings).
