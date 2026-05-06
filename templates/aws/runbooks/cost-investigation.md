# cost-investigation

**When to use:** A Cost Anomaly Detection alert fired, or you notice an unexpected
line item in Cost Explorer. Use this runbook to isolate the service and resource.

## Cost guardrails in place

| Guard | Type | Threshold | Managed by |
|---|---|---|---|
| strata-dev-cap budget | Fixed cap | $30/mo; alerts at 50/80/100% forecast | Operator (console-managed) |
| strata-dev-cost-anomaly-sub | CE Anomaly Detection | $5 absolute above baseline | Terraform (services/cost-anomaly/) |
| strata-dev-nat-bytes-out-anomaly-* | CloudWatch 3-sigma alarm | BytesOutToDestination anomaly band | modules/observability |

## Step 1 -- past 7 days by service (Cost Explorer CLI)

Requires aws ce:GetCostAndUsage permission (included in ReadOnlyAccess).

Replace the date range with today minus 7 days:

  aws ce get-cost-and-usage 
    --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD 
    --granularity DAILY 
    --metrics UnblendedCost 
    --group-by Type=DIMENSION,Key=SERVICE 
    --filter '{"Tags":{"Key":"Project","Values":["strata"]}}' 
    --output table
Expected top services:
  - Amazon Virtual Private Cloud (NAT GW ~$1.08/hr when up)
  - AWS PrivateLink (interface VPC endpoints ~$0.01/hr per endpoint per AZ)
  - Amazon ElastiCache (Redis Serverless)
  - Amazon RDS (Aurora Serverless v2)
  - Amazon ECS / Fargate

## Step 2 -- CloudWatch Logs Insights (free, no CUR setup needed)

Logs Insights does not query billing data directly. Use it for operational
signals: error spikes, request counts, canary failures.

API GW access log group: /aws/apigateway/strata-dev (or from task dev:output).

Query -- recent errors:

  fields @timestamp, routeKey, status, responseLength
  | filter status >= 400
  | stats count(*) as error_count by routeKey, status
  | sort error_count desc
  | limit 20

Query -- request volume by route (cost-driver identification):

  fields @timestamp, routeKey, responseLength
  | stats count(*) as req_count, sum(responseLength) as bytes_out by routeKey
  | sort bytes_out desc
  | limit 20

## Step 3 -- drill into NAT egress (most common culprit)

The strata-dev-nat-bytes-out-anomaly-* alarms fire when BytesOutToDestination
crosses the 3-sigma anomaly band (modules/observability section 4h).

VPC Flow Logs Insights query (log group /aws/vpc/strata-dev or similar):

  fields @timestamp, srcAddr, dstAddr, bytes
  | filter action = "ACCEPT" and interfaceId like /eni-/
  | stats sum(bytes) as total_bytes by dstAddr
  | sort total_bytes desc
  | limit 20

Common culprits:
  - api.anthropic.com: expected during canary runs or active chat sessions
  - s3 (not covered by gateway endpoint): check for missing endpoint config
  - Unknown external IPs: investigate as potential data exfiltration

Cross-reference ECS task IPs (from task networking) against the srcAddr field.

## Step 4 -- check for forgotten running resources

If the stack should have been destroyed but spend continues:

  aws resourcegroupstaggingapi get-resources 
    --tag-filters Key=Project,Values=strata 
    --query ResourceTagMappingList[].ResourceARN 
    --output text

Then: cd templates/aws && task dev:down

## Step 5 -- Cost Anomaly Detection console

AWS Cost Management > Cost Anomaly Detection > Anomalies.
The strata-dev-all-services monitor shows root-cause analysis (service, region)
and spend impact. Subscription ARN: task dev:output -> cost_anomaly_subscription_arn

## Escalation

If spend exceeds the strata-dev-cap budget and the source is unknown:
  1. aws health describe-events --region us-east-1
  2. Open an AWS Support case if the charge is from an unrecognized service
  3. Check WAF logs if charges correlate with DDoS-amplified traffic
