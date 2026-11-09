mock_provider "aws" {}

variables {
  aws_account_id = "123456789012"
  owner          = "test-operators"
}

run "protected_state_bucket" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.force_destroy == false && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "The state bucket must preserve versioned data on deletion attempts."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "All S3 public-access controls must be enabled."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "State must be encrypted at rest."
  }
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.state.rule :
      alltrue([for expiry in rule.expiration : expiry.expired_object_delete_marker == true])
    ])
    error_message = "Lifecycle rules must never expire current state or a live lock."
  }
}

run "reject_short_state_history" {
  command = plan
  variables { state_version_retention_days = 1 }
  expect_failures = [var.state_version_retention_days]
}
