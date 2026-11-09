output "state_bucket" { value = aws_s3_bucket.state.bucket }

# An identity policy template, not an automatic grant or a bucket allow policy.
# Attach only to reviewed infrastructure operator roles. Recovery of old versions
# and bootstrap administration require separate elevated operator permissions.
output "state_access_policy_json" {
  value = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "ListStateKeys", Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.state.arn
      },
      {
        Sid      = "ReadWriteState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [for key in local.state_keys : "${aws_s3_bucket.state.arn}/${key}"]
      },
      {
        Sid      = "ManageLocks", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [for key in local.state_keys : "${aws_s3_bucket.state.arn}/${key}.tflock"]
      }
    ]
  })
}
