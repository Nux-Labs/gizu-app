# Separate root so external DNS validation can finish before site creation.
resource "aws_acm_certificate" "landing" {
  domain_name               = "gizu.io"
  subject_alternative_names = ["www.gizu.io"]
  validation_method         = "DNS"
  lifecycle { prevent_destroy = true }
}

output "certificate_arn" { value = aws_acm_certificate.landing.arn }
output "dns_validation_records" {
  value = [for option in aws_acm_certificate.landing.domain_validation_options : {
    name = option.resource_record_name, type = option.resource_record_type, value = option.resource_record_value
  }]
}
