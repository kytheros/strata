# `aws/modules/custom-domain` — API Gateway custom domain + ACM cert (Cloudflare DNS)

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; the cert validation / domain / mapping graph is three resources with a single hard ordering edge (cert → validation gate → domain) which Terraform's plan model expresses cleanly. CDK / CloudFormation would add a tool-chain dependency for ~80 lines of declarative wiring with no runtime logic.

## What this creates

| Resource | When | Notes |
|---|---|---|
| `aws_acm_certificate` | always | DNS-validated, RSA-2048, in the same region as the API. `lifecycle.create_before_destroy = true` so SAN-list churn rotates without a 4xx window. |
| `aws_acm_certificate_validation` | always | No-op gate that polls ACM until the cert flips to ISSUED. We do NOT pass `validation_record_fqdns` because the records live in Cloudflare — ACM polls public DNS instead. 30 min create timeout. |
| `aws_apigatewayv2_domain_name` | always | Regional endpoint, TLS 1.2 minimum. NOT EDGE — that's CloudFront-fronted and pins the cert into us-east-1 (use `cloudfront-dist` for that path). |
| `aws_apigatewayv2_api_mapping` | always | Empty `api_mapping_key` puts the API at the apex of the custom domain. Stage defaults to `$default` (HTTP API convention). |

All resources tagged `Project=strata`, `Component=custom-domain`, `ManagedBy=terraform`, `Environment={env_name}`, `Region={aws_region}`, `Domain={domain_name}`.

## Why the cert lives in this module's region (NOT us-east-1)

Two ACM placement rules are easy to confuse:

- **CloudFront** consumes certs from us-east-1 only. (CloudFront is global; ACM has a special control-plane shortcut for it.)
- **API Gateway HTTP API** with a REGIONAL custom domain consumes certs from the API's own region.

This module emits a regional API GW custom domain, so the cert lives wherever the API does (us-east-1 in dev, but the module is region-portable). When the operator later puts CloudFront in front (separate `cloudfront-dist` module + WAF), that path uses its own us-east-1 cert.

## Two-pass apply pattern (operator runbook)

The cert is `PENDING_VALIDATION` until the operator pastes the CNAME into Cloudflare. The validation gate has a 30 min timeout, so the apply will sit and wait — DO NOT cancel it.

```
1. terraform apply                                   # Apply 1, eventually blocks on validation
2. terraform output cloudflare_dns_records           # Read the validation CNAME(s)
3. Paste validation CNAME into Cloudflare (DNS-only / grey cloud)
4. Wait ~3 min — ACM polls and flips the cert to ISSUED
5. (Apply 1 finishes; api_mapping is created)
6. Paste the FINAL CNAME (aws.strata.kytheros.dev → <target_domain_name>)
   into Cloudflare (DNS-only / grey cloud)
7. curl https://aws.strata.kytheros.dev/health       # End-to-end check
```

If apply 1 times out before the operator pastes the validation CNAME, the cert resource is still in state. Re-running `terraform apply` resumes the validation gate without churning the cert.

## CRITICAL: Cloudflare DNS records MUST be DNS-only (grey cloud)

Both records:
1. ACM validation CNAME
2. Final `aws.strata.kytheros.dev` → `<api gw regional domain>` CNAME

…must be set to **DNS only** (grey cloud icon) in Cloudflare, NOT proxied (orange cloud).

Why:

- **Validation record proxied:** Cloudflare answers with its own edge cert at the validation hostname; ACM's HTTP probe sees the wrong content and never marks the cert ISSUED. Validation hangs forever.
- **Final alias proxied:** API Gateway terminates TLS using the ACM cert at the regional endpoint. If Cloudflare proxies, it terminates TLS with its own cert and re-encrypts to API GW — which works for plain HTTP but breaks SSE / WebSockets / sticky session paths the chat UI relies on. It also obscures the real source IP from CloudWatch access logs.

If the operator later wants Cloudflare's edge protections, that is the `cloudfront-dist` + WAF v2 path — different module, different design choice.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `env_name` | string | (required) | Environment short-name; used in tags only. |
| `aws_region` | string | (required) | Region the API GW lives in. ACM cert is issued in this region. |
| `domain_name` | string | (required) | FQDN to attach (e.g. `aws.strata.kytheros.dev`). |
| `apigw_api_id` | string | (required) | API Gateway HTTP API ID — pass `module.ingress.api_id`. |
| `apigw_stage_name` | string | `"$default"` | Stage to map. Override only if running a non-default-stage HTTP API. |
| `extra_tags` | map(string) | `{}` | Extra tags merged onto module defaults. |

## Outputs

| Name | Description |
|---|---|
| `acm_certificate_arn` | ACM cert ARN. |
| `acm_certificate_status` | Cert status (`PENDING_VALIDATION` → `ISSUED`). |
| `domain_name` | Mirrors `var.domain_name`. |
| `target_domain_name` | Regional API GW DNS the final CNAME points to. |
| `hosted_zone_id` | API GW endpoint hosted-zone ID (for Route 53 alias targets — Cloudflare CNAMEs don't need it). |
| `validation_records` | List of `{name, type, value}` ACM validation records to paste. |
| `cloudflare_dns_records` | Pretty multi-line summary of both records — print this in the env's outputs for operator copy-paste. |

## Coordination

- **Cognito callback URLs.** The Cognito app client's `callback_urls` and `logout_urls` must include the new FQDN. Keep the OLD execute-api URL in the list during cutover so the OLD domain keeps working — Cognito accepts a list. After the new domain is verified, a follow-up commit can drop the execute-api URL.
- **Security review.** This module touches public ingress (TLS termination FQDN). Request a `security-compliance` review when first wiring it into a new env. The reviewer should verify: TLS 1.2 minimum, REGIONAL endpoint (not EDGE without intent), and that the upstream auth path (JWT authorizer in `services/ingress-authorizer`) is still in the loop.
- **Observability.** The custom domain does NOT change CloudWatch metric dimensions for the API GW (metrics still key off `ApiId`), so existing alarms keep working. No `observability-sre` ping required for the domain itself.
