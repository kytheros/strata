output "cache_id" {
  description = "Name/ID of the Serverless cache. Same as the resource's Name field — ElastiCache Serverless uses the name as the canonical identifier."
  value       = aws_elasticache_serverless_cache.this.id
}

output "cache_arn" {
  description = "ARN of the Serverless cache. Use to scope IAM permissions for `elasticache:Describe*` calls and to wire CloudWatch alarms."
  value       = aws_elasticache_serverless_cache.this.arn
}

output "endpoint" {
  description = "Primary endpoint hostname (TLS-only). Consumers connect using `rediss://<endpoint>:<port>` (note the double-s — TLS is required). Pair with `auth_secret_arn` to read the AUTH token at runtime."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].address
}

output "port" {
  description = "Port the cache listens on. Always 6379 for Redis Serverless; emitted as an output for symmetry so consumers don't hardcode it."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].port
}

output "reader_endpoint" {
  description = "Reader endpoint hostname. Returns the same address as `endpoint` for Serverless caches today (the read/write split is transparent), but emitted separately so consuming clients that already split connection pools by reader/writer don't need a code change."
  value       = aws_elasticache_serverless_cache.this.reader_endpoint[0].address
}

output "auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the AUTH token. Consuming task roles attach `secretsmanager:GetSecretValue` on this ARN + `kms:Decrypt` on `kms_key_arn`. The plaintext token is never exposed as an output."
  value       = module.auth_secret.secret_arn
}

output "auth_secret_consumer_iam_policy_json" {
  description = "Least-privilege IAM policy JSON granting `secretsmanager:GetSecretValue` on the AUTH-token secret + `kms:Decrypt` on the per-cache CMK (scoped via kms:ViaService). Attach to consumer task roles. Pass-through from the secrets module's own consumer policy."
  value       = module.auth_secret.consumer_iam_policy_json
}

output "security_group_id" {
  description = "ID of the security group attached to the cache ENIs. Consumers SHOULD add their own egress rule allowing TCP/6379 to this SG (`aws_vpc_security_group_egress_rule` with `referenced_security_group_id = this`), then pass their consumer SG ID into this module via `var.allowed_security_group_ids` so ingress is mutually scoped."
  value       = aws_security_group.cache.id
}

output "kms_key_arn" {
  description = "ARN of the per-cache KMS CMK encrypting both the cache's at-rest data and the AUTH-token secret. Consumers grant `kms:Decrypt` on this ARN to read the secret."
  value       = aws_kms_key.cache.arn
}

output "kms_key_alias" {
  description = "Alias of the per-cache CMK. Format: `alias/strata-{env}-cache`."
  value       = aws_kms_alias.cache.name
}

output "user_group_id" {
  description = "ID of the ElastiCache user group bound to the cache. Useful for adding additional users (read-only, app-scoped, etc.) post-deploy without recreating the cache."
  value       = aws_elasticache_user_group.this.user_group_id
}
