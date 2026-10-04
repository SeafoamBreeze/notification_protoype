output "inbound_queue_arn" {
  value = aws_sqs_queue.inbound.arn
}

output "inbound_queue_url" {
  value = aws_sqs_queue.inbound.url
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}
