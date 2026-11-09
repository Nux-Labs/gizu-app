variable "aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply the verified AWS account ID."
  }
}
variable "owner" {
  type = string
  validation {
    condition     = length(trimspace(var.owner)) > 0
    error_message = "Assign an operating owner."
  }
}

variable "certificate_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "Supply the certificate root's validated us-east-1 ACM ARN."
  }
}
variable "github_oidc_provider_arn" {
  type        = string
  default     = null
  description = "Existing account-wide token.actions.githubusercontent.com provider ARN."
}
variable "create_github_oidc_provider" {
  type    = bool
  default = false
}
variable "github_oidc_subject" {
  type        = string
  description = "Verify repository's actual subject format, including immutable IDs when enabled. No environment is used by this workflow."
  validation {
    condition     = can(regex("^repo:Nux-Labs(@[0-9]+)?/gizu-app(@[0-9]+)?:ref:refs/heads/main$", var.github_oidc_subject))
    error_message = "Only this repository's exact main-branch OIDC subject is permitted."
  }
}
