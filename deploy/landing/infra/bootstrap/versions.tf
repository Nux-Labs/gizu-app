terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Initially local. Add backend.tf from backend.tf.example only AFTER the
  # bucket exists, then explicitly migrate this state into its bootstrap key.
}

provider "aws" {
  region              = "eu-central-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = { Project = "gizu-landing", Environment = "production", ManagedBy = "OpenTofu", Owner = var.owner }
  }
}
