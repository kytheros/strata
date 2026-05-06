###############################################################################
# Outputs surface the ARNs and policy JSON the Strata service composition
# needs to consume the auth-proxy secret, plus diagnostic IDs for operators.
###############################################################################

output "auth_proxy_secret_arn" {
  description = "Secrets Manager ARN of the STRATA_AUTH_PROXY_TOKEN. The Strata service composition reads this at task launch and Strata's HTTP transport compares the X-Strata-Verified header against it constant-time."
  value       = module.auth_proxy_secret.secret_arn
}

output "auth_proxy_secret_kms_key_arn" {
  description = "ARN of the per-secret CMK encrypting the auth-proxy token. Consumers grant kms:Decrypt on this ARN (scoped via kms:ViaService to Secrets Manager)."
  value       = module.auth_proxy_secret.kms_key_arn
}

output "auth_proxy_consumer_iam_policy_json" {
  description = "Least-privilege IAM policy JSON granting secretsmanager:GetSecretValue on the auth-proxy secret + kms:Decrypt on its CMK. Attach to any task role that needs to read the shared sentinel — primarily the Strata service task role."
  value       = module.auth_proxy_secret.consumer_iam_policy_json
}

output "authorizer_id" {
  description = "API GW Cognito JWT authorizer ID. Diagnostic; routes attached in this module already reference it. Useful for operator-side `aws apigatewayv2 get-authorizer` calls."
  value       = aws_apigatewayv2_authorizer.cognito.id
}

output "authorizer_name" {
  description = "Human-readable authorizer name (`strata-{env}-cognito-jwt`)."
  value       = aws_apigatewayv2_authorizer.cognito.name
}

output "strata_integration_id" {
  description = "API GW integration ID for the Strata-bound integration with X-Strata-Verified injection. Diagnostic — operators trace request flow from a route through this integration to the Strata service."
  value       = aws_apigatewayv2_integration.strata_with_header.id
}

output "jwt_issuer_url" {
  description = "Cognito JWT issuer URL. External MCP clients verify Strata's responses against this same issuer; documented for operator runbooks."
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${var.cognito_user_pool_id}"
}

output "mcp_route_keys" {
  description = "Route keys created on the API GW for the JWT-authorized Strata path. Useful for `aws apigatewayv2 get-routes --api-id <id>` cross-checks."
  value = [
    aws_apigatewayv2_route.strata_mcp_post.route_key,
    aws_apigatewayv2_route.strata_mcp_get.route_key,
    aws_apigatewayv2_route.strata_mcp_delete.route_key,
    aws_apigatewayv2_route.strata_health.route_key,
  ]
}
