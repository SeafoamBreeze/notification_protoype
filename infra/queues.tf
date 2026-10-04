# Dev-environment SQS resources (see docs/notification-architecture.md).
# Standard queues: at-least-once delivery; a DLQ catches poison messages.

resource "aws_sqs_queue" "dlq" {
  name                        = "notifications.dlq.dev"
  visibility_timeout          = 60
  message_retention_period    = 345600 # 4 days

  tags = {
    Environment = "dev"
  }
}

resource "aws_sqs_queue" "inbound" {
  name                       = "notifications.inbound.dev"
  visibility_timeout         = 60
  message_retention_period   = 345600 # 4 days
  receive_wait_time_seconds  = 20 # long polling by default

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Environment = "dev"
  }
}
