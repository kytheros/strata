output "user_pool_id" {
  description = "Cognito User Pool ID. Consumed by the Strata-on-AWS service for JWT issuer construction and by the example-agent for AdminAddUserToGroup calls."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito User Pool ARN. Used to scope IAM grants for any service that calls the AdminInitiateAuth / AdminGetUser surface."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Cognito User Pool endpoint hostname (cognito-idp.{region}.amazonaws.com/{pool_id}). Used to construct the JWT issuer URL — `https://<endpoint>` is the `iss` claim aws-jwt-verify expects."
  value       = aws_cognito_user_pool.this.endpoint
}

output "user_pool_client_id" {
  description = "App Client ID. Public — embedded in frontend bundles and backend env vars."
  value       = aws_cognito_user_pool_client.this.id
}

output "user_pool_client_secret" {
  description = "App Client secret. Confidential — only present when var.generate_client_secret = true. Backends that exchange the OAuth code for tokens need this. Never expose to a browser bundle."
  value       = aws_cognito_user_pool_client.this.client_secret
  sensitive   = true
}

output "test_user_client_id" {
  description = "Test-user app client ID (null when var.enable_test_user_client = false). Configured for ADMIN_USER_PASSWORD_AUTH only — used by synthetic canaries that AdminInitiateAuth a known user from a Lambda."
  value       = var.enable_test_user_client ? aws_cognito_user_pool_client.test_user[0].id : null
}

output "hosted_ui_domain" {
  description = "Cognito Hosted UI domain prefix (the unqualified prefix, not the full URL). Combine with the region to construct the hosted-ui base URL."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "hosted_ui_login_url" {
  description = "Fully-qualified Hosted UI login URL. Frontend redirects unauthenticated users here. Note: callers still need to append OAuth query params (response_type, client_id, redirect_uri, scope) — this is the base URL only."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.aws_region}.amazoncognito.com/login"
}

output "hosted_ui_base_url" {
  description = "Hosted UI base URL (no path). Combine with `/login`, `/logout`, `/oauth2/authorize`, `/oauth2/token` etc. as needed."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "jwks_uri" {
  description = "Well-known JWKS URI. The Strata-on-AWS HTTP transport's `aws-jwt-verify` middleware fetches this at boot to validate incoming Cognito access tokens. Format: `https://cognito-idp.{region}.amazonaws.com/{pool_id}/.well-known/jwks.json`."
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/jwks.json"
}

output "issuer_url" {
  description = "JWT issuer URL — what aws-jwt-verify expects as the `iss` claim. Equals the user pool's HTTPS endpoint."
  value       = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "pre_token_generation_lambda_arn" {
  description = "ARN of the module-shipped PreTokenGeneration Lambda. Consumers may grant additional log-stream permissions at the service layer if they want centralized log aggregation."
  value       = aws_lambda_function.pre_token_generation.arn
}

output "pre_signup_lambda_arn_effective" {
  description = "ARN of the actually-wired PreSignUp Lambda — either var.pre_signup_lambda_arn (if set) or the module-shipped inert stub. Diagnostic output for confirming the trigger graph is what the operator expects."
  value       = local.pre_signup_arn
}

output "post_confirmation_lambda_arn_effective" {
  description = "ARN of the actually-wired PostConfirmation Lambda — either var.post_confirmation_lambda_arn (if set) or the module-shipped inert stub."
  value       = local.post_confirmation_arn
}

output "groups" {
  description = "Map of group name → group ARN for the 5 module-created Cognito groups. Use to scope IAM grants in services that read group membership via AdminListGroupsForUser."
  value = {
    owner    = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${aws_cognito_user_pool.this.id}/group/${aws_cognito_user_group.owner.name}"
    admin    = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${aws_cognito_user_pool.this.id}/group/${aws_cognito_user_group.admin.name}"
    member   = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${aws_cognito_user_pool.this.id}/group/${aws_cognito_user_group.member.name}"
    viewer   = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${aws_cognito_user_pool.this.id}/group/${aws_cognito_user_group.viewer.name}"
    approved = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${aws_cognito_user_pool.this.id}/group/${aws_cognito_user_group.approved.name}"
  }
}

output "google_federation_enabled" {
  description = "True when Google IdP was created (both var.google_client_id and var.google_client_secret_arn were set). Useful for caller-side conditional UI that hides the 'Sign in with Google' button until federation is wired."
  value       = local.google_enabled
}

output "github_federation_enabled" {
  description = "True when GitHub IdP was created (var.github_native_oidc_endpoint plus client id/secret were all set). Default false — see README §'GitHub federation'."
  value       = local.github_enabled
}
