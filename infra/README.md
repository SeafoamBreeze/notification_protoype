# Dev SQS Resources

Terraform for the dev-environment queues:

- `notifications.inbound.dev` — the microservice's inbound queue
- `notifications.dlq.dev` — dead-letter queue (redrive after 5 receives)

## Usage

```bash
cd infra
terraform init
terraform apply
```

Point the microservice and simulator at the queues via environment variables:

```bash
export SQS_QUEUE_URL=$(terraform output -raw inbound_queue_url)
export SQS_DLQ_URL=$(terraform output -raw dlq_url)
```

## Teardown

```bash
cd infra
terraform destroy
```
