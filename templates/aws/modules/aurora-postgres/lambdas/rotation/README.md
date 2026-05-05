# Master credential rotation — handled natively, no Lambda required

The plan ticket (AWS-1.4) called for a 30-day master-credential rotation
Lambda. After review we chose the AWS-native rotation path instead:

```hcl
resource "aws_rds_cluster" "aurora" {
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.aurora.arn
  ...
}
```

## Why no Lambda

`manage_master_user_password = true` (added in late 2023) hands master
credential ownership to AWS. AWS:

1. Generates the initial password with high-entropy randomness.
2. Stores it in a Secrets Manager secret encrypted with our cluster CMK.
3. Rotates it on a managed schedule (default 7 days for AWS-managed
   secrets — RDS uses a slightly longer cadence).
4. Coordinates the rotation with the cluster so there is no
   read-after-rotate race window.

RDS Proxy reads the secret transparently and picks up rotated values on
its next connection check — no app-side reload needed.

## Operational consequences

- **Pro:** one fewer Lambda to maintain. No CloudWatch failures from
  rotation Lambda exec timeouts. No state-machine for the four-step
  Secrets Manager rotation contract. The rotated value never leaves AWS.
- **Pro:** RDS Proxy + AWS-managed rotation is the canonical pattern in
  AWS docs as of 2024. Aligns with their published reference
  architectures.
- **Con:** rotation cadence is AWS-controlled, not operator-controlled.
  If a future audit demands a 24-hour rotation we cannot meet it
  without flipping to a `secrets`-module-managed credential and a custom
  rotation Lambda.
- **Con:** the master credential is by definition a `_admin` user. Some
  enterprise security postures require app-tier credentials to be
  separate from master. That is a Phase-2 follow-up — provision a
  per-app DB user post-bootstrap and put its credential in a separate
  module-`secrets`-managed entry with its own rotation Lambda.

## When to reintroduce a rotation Lambda here

If any of the following becomes true:

1. Operator-controlled rotation cadence is required (e.g., compliance
   demands a 24-hour rotation window).
2. Custom rotation logic is required (e.g., synchronizing with a
   downstream credential-cache invalidation).
3. The cluster moves off `manage_master_user_password = true` for any
   other reason (e.g., the master credential needs to be readable in
   plaintext outside Secrets Manager).

Then this directory becomes the home of:
- `index.mjs` — the four-step rotator implementing the AWS Secrets
  Manager rotation contract (createSecret, setSecret, testSecret,
  finishSecret).
- `package.json` — minimal deps. Native fetch only — no axios. The
  AWS SDK v3 modular clients (`@aws-sdk/client-secrets-manager`,
  `@aws-sdk/client-rds`) are the only dependencies.

The shipped `secrets` module's `rotation_lambda_arn` variable is the
plug point — wire that up plus a one-line `master_user_secret_kms_key_id`
flip on the cluster and the new rotator takes over.

## References

- [Manage master user passwords with AWS Secrets Manager](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-secrets-manager.html)
- [Rotating AWS Secrets Manager secrets for other databases](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_other-db.html)
- [`aws_rds_cluster` Terraform docs (manage_master_user_password)](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/rds_cluster#manage_master_user_password)
