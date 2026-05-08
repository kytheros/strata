###############################################################################
# Outputs — operator-facing copy-paste targets for Cloudflare DNS.
#
# Two records the operator needs:
#   1. ACM validation CNAME (paste FIRST, BEFORE running the validation gate
#      to completion). Surfaces from aws_acm_certificate.domain_validation_options
#      as a set of {name, type, value} objects. RSA-2048 single-SAN certs
#      emit exactly one validation record; we still expose the full list so
#      future SAN expansion stays compatible.
#   2. Final alias CNAME (paste AFTER the cert validates). The target is the
#      regional API GW endpoint exposed via
#      aws_apigatewayv2_domain_name.domain_name_configuration[0].target_domain_name.
#
# Both must be DNS-only (grey cloud) in Cloudflare:
#   - Validation CNAME: ACM polls the public DNS for the literal CNAME
#     value. If Cloudflare proxies (orange cloud), it serves its OWN cert
#     and the value at the validation hostname is masked.
#   - Final alias CNAME: API GW does TLS termination with the ACM cert.
#     Proxying through Cloudflare's cert layer would force a re-encrypt
#     loop and break SSE / WebSockets which the chat path relies on.
###############################################################################

output "acm_certificate_arn" {
  description = "ACM certificate ARN. Diagnostic / audit; consumers do not need to read this in v1 because the api-gateway domain resource is created internally."
  value       = aws_acm_certificate.this.arn
}

output "acm_certificate_status" {
  description = "ACM cert status — `ISSUED` once validation completes. `terraform output -raw acm_certificate_status` is the fastest sanity check after pasting the validation CNAME."
  value       = aws_acm_certificate.this.status
}

output "domain_name" {
  description = "The FQDN configured on this domain. Mirrors var.domain_name."
  value       = aws_apigatewayv2_domain_name.this.domain_name
}

output "target_domain_name" {
  description = "Regional API Gateway DNS hostname this custom domain forwards to. Consumed by the operator to populate the FINAL Cloudflare CNAME (aws.strata.kytheros.dev → <this>)."
  value       = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name
}

output "hosted_zone_id" {
  description = "Hosted-zone ID for the regional API GW endpoint. Consumed by Route 53 alias targets — left here for symmetry with the ALB/CloudFront patterns. Cloudflare CNAMEs do not need it."
  value       = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].hosted_zone_id
}

output "validation_records" {
  description = "List of ACM validation CNAME records to paste into Cloudflare (one per SAN — single-entry list for the v1 single-FQDN cert). Each item is {name, type, value}; type is always CNAME for DNS-validation certs. `name` is the FQDN to set on the Cloudflare side; `value` is the target."
  value = [
    for opt in aws_acm_certificate.this.domain_validation_options : {
      name  = opt.resource_record_name
      type  = opt.resource_record_type
      value = opt.resource_record_value
    }
  ]
}

output "cloudflare_dns_records" {
  description = "Operator-friendly multi-line summary of the two DNS records that must be added in Cloudflare. Print after `task dev:up` so the operator does not have to assemble the values from raw outputs. Both records MUST be DNS-only (grey cloud), NOT proxied (orange cloud)."
  value = join("\n", concat(
    [
      "Cloudflare DNS records for ${var.domain_name} (DNS-only / grey cloud — NOT proxied):",
      "",
      "1. ACM validation CNAME (paste FIRST, then wait ~3 min for ACM to mark the cert ISSUED):",
    ],
    [
      for opt in aws_acm_certificate.this.domain_validation_options :
      "     ${opt.resource_record_type}  ${opt.resource_record_name}  →  ${opt.resource_record_value}"
    ],
    [
      "",
      "2. Final alias CNAME (paste AFTER the cert validates — sign-in starts working immediately):",
      "     CNAME  ${var.domain_name}.  →  ${aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name}",
      "",
      "Reminder: in Cloudflare, click the cloud icon next to each record so it shows GREY (DNS only).",
      "Proxied (orange) records break ACM validation and the API GW TLS handshake.",
    ]
  ))
}
