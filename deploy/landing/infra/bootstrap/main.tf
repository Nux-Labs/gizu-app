locals {
  bucket_name = "gizu-landing-tofu-${var.aws_account_id}-eu-central-1"
  state_keys  = toset(["bootstrap/terraform.tfstate", "certificate/terraform.tfstate", "site/terraform.tfstate"])
}

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.state]
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  dynamic "rule" {
    for_each = local.state_keys
    content {
      id     = "history-${split("/", rule.value)[0]}"
      status = "Enabled"
      filter { prefix = rule.value }
      noncurrent_version_expiration {
        noncurrent_days           = var.state_version_retention_days
        newer_noncurrent_versions = 20
      }
    }
  }
  dynamic "rule" {
    for_each = local.state_keys
    content {
      id     = "locks-${split("/", rule.value)[0]}"
      status = "Enabled"
      filter { prefix = "${rule.value}.tflock" }
      noncurrent_version_expiration { noncurrent_days = 1 }
      expiration { expired_object_delete_marker = true }
    }
  }
  depends_on = [aws_s3_bucket_versioning.state]
}
