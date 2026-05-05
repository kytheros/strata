// PreSignUp trigger — example-agent allowlist enforcer.
//
// Cognito invokes this Lambda before creating a user record. It reads the
// SSM-stored allowlist (KMS-encrypted SecureString JSON array of emails) and
// either auto-confirms the signup or throws — Cognito surfaces a thrown error
// as the user-visible Hosted UI message.
//
// USER-FACING ERROR MESSAGE CONTRACT — DO NOT CHANGE WITHOUT COORDINATION:
//   throw new Error("Not authorized")
// is what an unapproved user sees in the Hosted UI when they attempt federated
// signup. The exit criterion in `specs/2026-04-25-strata-deploy-aws-plan.md`
// §AWS-3.2 names this string verbatim. If you reword it, update the plan.
//
// Cache strategy: SSM call costs ~50ms per invocation and the parameter
// changes maybe once a week. We cache the parsed allowlist at module scope
// with a 60s TTL — warm Lambda containers reuse the cached value without
// hitting SSM. Cold starts (or 60s+ since the last fetch) re-read.
//
// IAM scope (set by infrastructure/main.tf):
//   - ssm:GetParameter on the allowlist parameter ARN only
//   - kms:Decrypt on the allowlist CMK ARN only
//   - basic CloudWatch Logs (managed policy)
//
// Native runtime — no third-party HTTP libs (per Strata supply-chain policy).

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const SSM_PARAM_NAME = process.env.ALLOWLIST_SSM_PARAM_NAME;
const CACHE_TTL_MS = 60_000;

if (!SSM_PARAM_NAME) {
  // Fail fast at cold-start when misconfigured. Cognito will surface the
  // resulting handler error generically; a deployer reading CloudWatch sees
  // the precise reason.
  throw new Error(
    "[pre-signup] ALLOWLIST_SSM_PARAM_NAME env var not set — check Lambda configuration.",
  );
}

const ssm = new SSMClient({});

let cached = { value: /** @type {Set<string> | null} */ (null), fetchedAt: 0 };

async function loadAllowlist() {
  const now = Date.now();
  if (cached.value && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const resp = await ssm.send(
    new GetParameterCommand({ Name: SSM_PARAM_NAME, WithDecryption: true }),
  );
  const raw = resp.Parameter?.Value ?? "[]";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[pre-signup] allowlist SSM value is not valid JSON: ${err.message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "[pre-signup] allowlist SSM value must be a JSON array of email strings.",
    );
  }

  // Lower-case once at fetch time; comparisons are case-insensitive.
  const set = new Set(parsed.map((e) => String(e).trim().toLowerCase()));
  cached = { value: set, fetchedAt: now };
  return set;
}

export const handler = async (event) => {
  const email = (event?.request?.userAttributes?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    // No email on the event — federated signups always include one. Fail
    // closed: refuse the signup. Don't expose internals to the user.
    console.warn("[pre-signup] event missing email", {
      triggerSource: event?.triggerSource,
      userName: event?.userName,
    });
    throw new Error("Not authorized");
  }

  const allowlist = await loadAllowlist();
  if (!allowlist.has(email)) {
    console.info("[pre-signup] reject", {
      email,
      triggerSource: event?.triggerSource,
    });
    // SEE CONTRACT NOTE AT TOP OF FILE — this string is user-visible.
    throw new Error("Not authorized");
  }

  console.info("[pre-signup] accept", {
    email,
    triggerSource: event?.triggerSource,
  });

  event.response = event.response ?? {};
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
