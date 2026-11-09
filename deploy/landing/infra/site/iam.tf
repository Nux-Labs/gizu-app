# IAM OIDC providers are account-wide. Reuse an existing provider by default;
# opt into creation only after verifying that the account has none.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
locals {
  oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.github_oidc_provider_arn
}
resource "aws_iam_role" "deploy" {
  name                 = "gizu-landing-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Federated = local.oidc_arn }, Action = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
      } }
    }]
  })
  lifecycle {
    precondition {
      condition     = var.create_github_oidc_provider || var.github_oidc_provider_arn != null
      error_message = "Supply the existing GitHub OIDC provider ARN or explicitly enable creation."
    }
    precondition {
      condition     = var.create_github_oidc_provider || var.github_oidc_provider_arn == "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
      error_message = "The existing OIDC provider must be GitHub's provider in this AWS account."
    }
  }
}
resource "aws_iam_role_policy" "deploy" {
  name = "landing-release-only"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.landing.arn },
      {
        Effect   = "Allow", Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [for prefix in ["site", "archive", "control"] : "${aws_s3_bucket.landing.arn}/${prefix}/*"]
      },
      {
        Effect   = "Allow", Action = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = aws_cloudfront_distribution.landing.arn
      }
    ]
  })
}
