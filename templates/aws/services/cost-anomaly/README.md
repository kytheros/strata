# services/cost-anomaly

AWS Cost Explorer anomaly detection for Strata-on-AWS (AWS-5.1).

## What this composition provisions

| Resource | Name | Purpose |
|---|---|---|
| aws_ce_anomaly_monitor | strata-env-all-services | DIMENSIONAL monitor, watches all AWS services in the account |
| aws_ce_anomaly_subscription | strata-env-cost-anomaly-sub | Emails cost_alert_email when spend exceeds anomaly_threshold_amount above baseline |

**Cost:** zero. Cost Explorer anomaly detection, monitors, and subscriptions have no AWS charge.

## What it does NOT own

**AWS Budget "strata-dev-cap"** -- the $30/mo manual budget with 50%/80%/100% forecast
thresholds and email alerts is **operator-managed** (created in the AWS console
before Terraform owned this account). Do not import it. Reference it in runbooks
as the complementary fixed-threshold guard.

## Threshold rationale

Default anomaly_threshold_amount = 5 (USD absolute, not percent). At near-zero
baseline spend, a $5 floor catches:

- A forgotten NAT Gateway left running overnight (~$1.08/hr)
- An Aurora instance missed by task dev:down
- A runaway Lambda canary loop

Raise to $25-50 for staging/prod where routine deploys produce natural variance.

## SNS confirmation

The subscriber is EMAIL type. On first apply, AWS Cost Explorer sends a
confirmation to cost_alert_email. The recipient must click Accept before
anomaly alerts are delivered.

## Runbook

When an anomaly alert fires: templates/aws/runbooks/cost-investigation.md
covers the Logs Insights query breaking down the week spend by service and tag.
