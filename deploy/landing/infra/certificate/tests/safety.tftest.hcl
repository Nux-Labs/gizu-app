mock_provider "aws" {}
variables {
  aws_account_id = "123456789012"
  owner          = "test-operators"
}
run "dns_validated_both_hostnames" {
  command = plan
  assert {
    condition     = aws_acm_certificate.landing.domain_name == "gizu.io" && contains(aws_acm_certificate.landing.subject_alternative_names, "www.gizu.io") && aws_acm_certificate.landing.validation_method == "DNS"
    error_message = "The certificate must cover both hostnames and use external DNS validation."
  }
}
