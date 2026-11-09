terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    key          = "site/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
provider "aws" {
  region              = "eu-central-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags { tags = { Project = "gizu-landing", ManagedBy = "OpenTofu", Owner = var.owner } }
}
