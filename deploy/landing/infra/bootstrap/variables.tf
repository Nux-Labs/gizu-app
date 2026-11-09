variable "aws_account_id" {
  description = "Expected target account. Uses external AWS credentials; never place credentials in tfvars."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply the verified 12-digit AWS account ID."
  }
}

variable "owner" {
  description = "Operating team or role responsible for cost and recovery."
  type        = string
  validation {
    condition     = length(trimspace(var.owner)) > 0
    error_message = "Assign an operating owner before provisioning."
  }
}

variable "state_version_retention_days" {
  description = "Review before apply: retain noncurrent state for at least this many days and keep the newest 20 noncurrent versions."
  type        = number
  default     = 90
  validation {
    condition     = var.state_version_retention_days >= 30 && floor(var.state_version_retention_days) == var.state_version_retention_days
    error_message = "State history retention must be an integer of at least 30 days."
  }
}
