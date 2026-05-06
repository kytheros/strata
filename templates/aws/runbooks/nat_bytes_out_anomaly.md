# nat_bytes_out_anomaly

**Severity:** SEV-2
**Owner team:** platform / observability + finops-analyst
**Dashboard:** `strata-<env>-ops` -> "NAT egress" row

## What this alarm means

`AWS/NATGateway::BytesOutToDestination` for the named NAT gateway is outside the 3-sigma `ANOMALY_DETECTION_BAND` (15-minute window, 2 of 3 datapoints must breach). This catches design Risk #3 — a chatty agent or a runaway outbound traffic source. NAT egress is metered at $0.045/GB AND is a primary attack-surface signal: the alarm is intentionally tuned to detect deviation from the established baseline rather than a hard byte threshold.

## First triage steps (5 min)

1. Open the ops dashboard "NAT egress" row. Compare current bytes-out vs the trailing 24-hour band; identify whether the spike is sustained or a transient burst.
2. Filter VPC Flow Logs to the offending NAT-gateway ENI for the last hour, sorted by destination IP:
   ```
   aws logs start-query --log-group-name /aws/vpc/flowlogs/<env> \
     --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, srcAddr, dstAddr, dstPort, bytes
                     | stats sum(bytes) as total by dstAddr
                     | sort total desc
                     | limit 20'
   ```
3. Reverse-resolve the top destination IPs. Public LLM API ranges (Anthropic, OpenAI, Google) are the expected #1; anything unrecognized is the lead.
4. Cross-reference recent deploys of Strata, example-agent, or any agent code that issues outbound HTTP.

## Common causes

- **Chatty agent.** A new code path issues unbounded LLM calls (loop without termination, missing token cap). Mitigation: revert; add rate-limit + max-loop guard.
- **Data exfil indicator.** Unrecognized destination IP, sustained bandwidth. Treat as security incident — page security-compliance, capture flow logs, do NOT power-cycle the task before forensic capture.
- **Legitimate growth.** Agent fleet expanded; baseline shifts upward and the anomaly band re-fits within ~48 hours. Mitigation: confirm via correlated traffic increase, then accept.
- **Container image pull through NAT.** A new task def is pulling from a registry not on a VPC endpoint. Mitigation: switch to ECR / S3 gateway endpoint to avoid NAT charges.

## Escalation

Unrecognized destination IP + sustained anomaly = SEV-1 security incident; page security-compliance immediately. All other causes: 30-minute soft target with finops-analyst looped in if cost is the driver.
