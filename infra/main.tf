terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

variable "aws_region" {
  description = "AWS region for the dev SQS resources"
  type        = string
  default     = "eu-west-1"
}

provider "aws" {
  region = var.aws_region
}
