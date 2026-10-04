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

# Alert when the DLQ accumulates messages (chronic delivery failures need
# investigating). Hook up an SNS topic in alarm_actions when ops wants paging.
resource "cloudwatch_metric_alarm" "dlq_accumulation" {
  alarm_name          = "notifications-dlq-accumulation.dev"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessages"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
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
