provider "aws" {
  alias               = "certificate"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]
}

# An operator first publishes the certificate root's validation CNAMEs at the
# existing DNS provider. Do not change public website routing for validation.
resource "aws_acm_certificate_validation" "landing" {
  provider        = aws.certificate
  certificate_arn = var.certificate_arn
  timeouts { create = "10m" }
  lifecycle {
    precondition {
      condition     = startswith(var.certificate_arn, "arn:aws:acm:us-east-1:${var.aws_account_id}:certificate/")
      error_message = "The certificate must belong to the verified AWS account."
    }
  }
}

resource "aws_s3_bucket" "landing" {
  bucket        = "gizu-landing-${var.aws_account_id}"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "landing" {
  bucket                  = aws_s3_bucket.landing.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "landing" {
  bucket = aws_s3_bucket.landing.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_versioning" "landing" {
  bucket = aws_s3_bucket.landing.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "landing" {
  bucket = aws_s3_bucket.landing.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_cloudfront_origin_access_control" "landing" {
  name                              = "gizu-landing"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_cache_policy" "landing" {
  name        = "gizu-landing-origin-cache-headers"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}
resource "aws_cloudfront_response_headers_policy" "landing" {
  name = "gizu-landing-security"
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}
resource "aws_cloudfront_distribution" "landing" {
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = ["gizu.io", "www.gizu.io"]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  wait_for_deployment = true
  origin {
    origin_id                = "landing-s3"
    domain_name              = aws_s3_bucket.landing.bucket_regional_domain_name
    origin_path              = "/site"
    origin_access_control_id = aws_cloudfront_origin_access_control.landing.id
  }
  default_cache_behavior {
    target_origin_id           = "landing-s3"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.landing.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.landing.id
  }
  # Keep missing associations/assets as errors. There is no SPA HTML fallback.
  custom_error_response {
    error_code            = 403
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    error_caching_min_ttl = 0
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.landing.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_policy" "landing" {
  bucket = aws_s3_bucket.landing.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReadSiteOnly", Effect = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject"
        Resource  = "${aws_s3_bucket.landing.arn}/site/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.landing.arn } }
      },
      {
        Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
        Resource  = [aws_s3_bucket.landing.arn, "${aws_s3_bucket.landing.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.landing]
}

output "bucket" { value = aws_s3_bucket.landing.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.landing.id }
output "cloudfront_domain" { value = aws_cloudfront_distribution.landing.domain_name }
output "deployment_role_arn" { value = aws_iam_role.deploy.arn }
