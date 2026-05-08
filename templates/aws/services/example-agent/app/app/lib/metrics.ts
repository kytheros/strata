// CloudWatch custom-metric emitter (AWS-3.4 — Anthropic spend observability).
//
// Anthropic does NOT push token-usage metrics to CloudWatch — we instrument
// the SDK call site and PutMetricData ourselves so an alarm can page on
// runaway burn before the next "$0 credits, all chats 500" event.
//
// Design:
//   - Fire-and-forget. A CloudWatch outage MUST NOT break a chat turn, so
//     callers `void publishTokenMetric(...)` and any error is swallowed
//     into console.error.
//   - One PutMetricData call per direction (input/output) per turn. At
//     chat cadence this is well under CloudWatch's 150 TPS account limit;
//     we don't bother batching.
//   - Module-level CloudWatchClient singleton. Construction is cheap, but
//     reusing it across warm task invocations avoids re-resolving creds on
//     every turn.
//   - Resource-level scoping: PutMetricData does not support resource-level
//     IAM scoping (per AWS docs); the IAM policy in the task role uses
//     `cloudwatch:namespace` condition keys for the equivalent constraint.

import {
  CloudWatchClient,
  PutMetricDataCommand,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';

export const ANTHROPIC_METRIC_NAMESPACE = 'Concierge/Anthropic';

let _client: CloudWatchClient | null = null;
function getClient(): CloudWatchClient {
  if (_client === null) {
    _client = new CloudWatchClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
  }
  return _client;
}

export interface TokenMetricArgs {
  env: string;
  model: string;
  direction: 'input' | 'output';
  tokens: number;
}

/**
 * Fire-and-forget PutMetricData. Returns a Promise that ALWAYS resolves —
 * errors are caught and logged so a CloudWatch outage cannot break a chat
 * turn. Callers should `void publishTokenMetric(...)` to make the
 * non-blocking nature explicit at the call site.
 */
export async function publishTokenMetric(args: TokenMetricArgs): Promise<void> {
  // Defensive: don't push 0 or NaN — Anthropic returns numeric token
  // counts, but if the SDK shape ever changes we'd rather drop the metric
  // than emit garbage.
  if (
    !Number.isFinite(args.tokens) ||
    args.tokens < 0 ||
    args.tokens > Number.MAX_SAFE_INTEGER
  ) {
    return;
  }

  try {
    await getClient().send(
      new PutMetricDataCommand({
        Namespace: ANTHROPIC_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: 'TokensConsumed',
            Value: args.tokens,
            Unit: 'Count' satisfies StandardUnit,
            Dimensions: [
              { Name: 'Env', Value: args.env },
              { Name: 'Model', Value: args.model },
              { Name: 'Direction', Value: args.direction },
            ],
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (err) {
    // Never throw. CloudWatch is best-effort observability; a chat turn
    // succeeding without a metric beats a chat turn failing because the
    // metrics pipeline is down.
    // eslint-disable-next-line no-console
    console.error('[metrics] publishTokenMetric failed:', err);
  }
}

/**
 * Test-only seam — let unit tests inject a mock client so PutMetricData
 * calls can be asserted. Not exported via the package barrel.
 */
export function __setCloudWatchClientForTests(client: CloudWatchClient | null): void {
  _client = client;
}
