# governance/required-tags-scp

**Status: STUB -- single-account deployment only.**

This directory contains the recommended AWS Organizations Service Control Policy (SCP)
that enforces required cost-allocation tags on all new resources. It is not applied
because Strata-on-AWS v1 targets a single AWS account, not an AWS Organization.
Apply when you adopt multi-account Organizations.

## When to apply

1. You have created an AWS Organization (management account + member accounts).
2. You have enabled SCP policy type on the target OU.
3. Existing resources already carry the required tags.

## Canonical tag set for Strata-on-AWS

Every Phase 1 module applies these tags via the local.default_tags / extra_tags
merge pattern. Confirm coverage in Cost Explorer -> Cost Allocation Tags.

| Tag key     | Value (dev)  | Purpose                                              |
|-------------|--------------|------------------------------------------------------|
| Project     | strata       | Identifies all Strata-on-AWS resources               |
| Environment | dev          | Differentiates dev/staging/prod spend in CE          |
| ManagedBy   | terraform    | Signals IaC control; protects against manual drift   |
| CostCenter  | demo         | Cost allocation unit; use a real code in production  |

## Phase 1 tag coverage confirmation

All Phase 1 modules receive extra_tags = local.default_tags from the orchestrator.
The default_tags block in envs/dev/main.tf sets all four keys. New modules must
follow the merge(local.default_tags, var.extra_tags) pattern.

## How to apply (future, Organizations context)

See main.tf in this directory for the commented Terraform block and
required-tags-scp.json for the policy document.

Command sketch (replace IDs with real values):

  1. aws organizations create-policy --name strata-required-tags
     --content file://required-tags-scp.json --type SERVICE_CONTROL_POLICY
  2. aws organizations attach-policy --policy-id p-xxxxx --target-id ou-xxxx

## SCP scope note

The SCP in required-tags-scp.json targets us-east-1 (the Strata v1 single-region
footprint). Remove the aws:RequestedRegion condition when expanding to multiple regions.
