mock_provider "aws" {}
mock_provider "aws" { alias = "certificate" }
variables {
  aws_account_id           = "123456789012"
  owner                    = "test-operators"
  certificate_arn          = "arn:aws:acm:us-east-1:123456789012:certificate/example"
  github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  github_oidc_subject      = "repo:Nux-Labs@345999852/gizu-app@1381183565:ref:refs/heads/main"
}
run "private_static_site" {
  command = plan
  assert {
    condition     = aws_s3_bucket_public_access_block.landing.block_public_acls && aws_s3_bucket_public_access_block.landing.block_public_policy && aws_s3_bucket_public_access_block.landing.ignore_public_acls && aws_s3_bucket_public_access_block.landing.restrict_public_buckets
    error_message = "All bucket public-access protections must remain enabled."
  }
  assert {
    condition     = toset(aws_cloudfront_distribution.landing.aliases) == toset(["gizu.io", "www.gizu.io"]) && aws_cloudfront_distribution.landing.default_root_object == "index.html"
    error_message = "Serve both approved hostnames with index.html at the root."
  }
  assert {
    condition     = aws_cloudfront_distribution.landing.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && aws_cloudfront_cache_policy.landing.min_ttl == 0
    error_message = "Require HTTPS and honor short HTML/association caching."
  }
  assert {
    condition     = aws_cloudfront_origin_access_control.landing.signing_behavior == "always" && one(aws_cloudfront_distribution.landing.origin).origin_path == "/site"
    error_message = "Only the live site prefix may be served through signed origin access."
  }
  assert {
    condition     = alltrue([for response in aws_cloudfront_distribution.landing.custom_error_response : response.response_page_path == null])
    error_message = "Never return the HTML page for missing associations or assets."
  }
}
run "reject_wrong_certificate_region" {
  command = plan
  variables { certificate_arn = "arn:aws:acm:eu-central-1:123456789012:certificate/example" }
  expect_failures = [var.certificate_arn]
}
run "reject_pull_request_credentials" {
  command = plan
  variables { github_oidc_subject = "repo:Nux-Labs/gizu-app:pull_request" }
  expect_failures = [var.github_oidc_subject]
}
run "reject_other_repository_credentials" {
  command = plan
  variables { github_oidc_subject = "repo:another/repository:ref:refs/heads/main" }
  expect_failures = [var.github_oidc_subject]
}
run "reject_foreign_certificate" {
  command = plan
  variables { certificate_arn = "arn:aws:acm:us-east-1:999999999999:certificate/example" }
  expect_failures = [aws_acm_certificate_validation.landing]
}
run "reject_foreign_oidc_provider" {
  command = plan
  variables { github_oidc_provider_arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com" }
  expect_failures = [aws_iam_role.deploy]
}
