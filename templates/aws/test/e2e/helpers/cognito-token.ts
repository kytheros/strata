// Mint a Cognito access token for the test-user app client.
//
// This mirrors templates/aws/services/canary/lambda/index.mjs — the synthetic
// canary's reference implementation. We pull the same secret + same client
// IDs so tests and the canary exercise identical auth paths. If this drifts
// from the canary, expect drift in production behavior too.
//
// Required env / discovery sources (precedence):
//   1. STRATA_TEST_USER_CLIENT_ID  (explicit override)
//      STRATA_CANARY_SECRET_ARN
//      STRATA_USER_POOL_ID
//   2. `terraform output -raw <name>` from templates/aws/envs/dev — the
//      operator-friendly default.
//
// We cache the minted token on the module for the test process lifetime;
// AdminInitiateAuth burns Cognito API quota and there is no point re-minting
// for every test case.

import { execFileSync } from "node:child_process";
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  ListUserPoolClientsCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const REGION = process.env.STRATA_AWS_REGION ?? "us-east-1";

// Module-scoped cache. Tokens last 1 hour by default; the smoke suite finishes
// in < 90 s, so a single mint per process is fine.
let cachedToken: string | null = null;

function resolveTfDir(): string {
  // helpers -> e2e -> test -> aws -> envs/dev
  const here = new URL("../../../envs/dev/", import.meta.url).pathname;
  return process.platform === "win32" && here.startsWith("/") ? here.slice(1) : here;
}

const TF_DIR = resolveTfDir();

function tfOutput(name: string): string | null {
  // `terraform output -raw <name>` is fast (reads local state cache or remote
  // backend; for our backend this is < 2 s cold). Returns null on any failure
  // — caller decides whether to fall back to a discovery API call or hard-fail.
  try {
    const out = execFileSync("terraform", ["-chdir=" + TF_DIR, "output", "-raw", name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Fall back to listing user pool app clients and picking the test-user one.
 * The example-agent module names it `<env>-app-client-test-user`; we match
 * the suffix so this works across env names without a hardcoded prefix.
 */
async function discoverTestUserClientId(userPoolId: string): Promise<string> {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const out = await cognito.send(
    new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60 }),
  );
  const candidates = (out.UserPoolClients ?? []).filter((c) =>
    c.ClientName?.endsWith("-test-user"),
  );
  if (candidates.length === 0) {
    throw new Error(
      `No app client matching '*-test-user' found in pool ${userPoolId}. ` +
        "Either canary_enabled=false (no test-user client provisioned), or set STRATA_TEST_USER_CLIENT_ID explicitly.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple '*-test-user' app clients found in pool ${userPoolId} ` +
        `(${candidates.map((c) => c.ClientName).join(", ")}). Set STRATA_TEST_USER_CLIENT_ID to disambiguate.`,
    );
  }
  return candidates[0].ClientId!;
}

interface AuthIds {
  userPoolId: string;
  clientId: string;
  secretArn: string;
}

async function discoverAuthIds(): Promise<AuthIds> {
  const userPoolId =
    process.env.STRATA_USER_POOL_ID ??
    tfOutput("cognito_user_pool_id") ??
    null;
  const secretArn =
    process.env.STRATA_CANARY_SECRET_ARN ??
    tfOutput("canary_credentials_secret_arn") ??
    null;

  if (!userPoolId || !secretArn) {
    throw new Error(
      "Could not resolve Cognito user pool ID or canary credentials secret ARN. " +
        `Either run \`terraform init && terraform refresh\` in templates/aws/envs/dev, or set ` +
        `STRATA_USER_POOL_ID and STRATA_CANARY_SECRET_ARN explicitly. ` +
        `(userPoolId=${!!userPoolId}, secretArn=${!!secretArn})`,
    );
  }

  // Test-user client ID has three resolution paths, in order:
  //   1. STRATA_TEST_USER_CLIENT_ID env var (manual override)
  //   2. terraform output cognito_test_user_client_id (canonical, after apply)
  //   3. ListUserPoolClients fallback (works pre-apply or when output drifted)
  const clientId =
    process.env.STRATA_TEST_USER_CLIENT_ID ??
    tfOutput("cognito_test_user_client_id") ??
    (await discoverTestUserClientId(userPoolId));

  if (!clientId) {
    throw new Error(
      "Could not resolve the test-user Cognito app client ID via any method.",
    );
  }
  return { userPoolId, clientId, secretArn };
}

async function loadCredentials(secretArn: string): Promise<{ username: string; password: string }> {
  const client = new SecretsManagerClient({ region: REGION });
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!out.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString — operator must seed it.`);
  }
  const parsed = JSON.parse(out.SecretString) as { username?: string; password?: string };
  if (!parsed.username || !parsed.password) {
    throw new Error(
      `Secret ${secretArn} shape invalid — expected {username, password}, got keys: ${Object.keys(parsed).join(",")}.`,
    );
  }
  return { username: parsed.username, password: parsed.password };
}

/**
 * Mint a Cognito access token for the test-user app client via
 * AdminInitiateAuth. Cached for the test process lifetime.
 *
 * Throws with an actionable message if AWS creds are missing or the secret /
 * pool / client are not yet provisioned.
 */
export async function mintTestUserAccessToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const ids = await discoverAuthIds();
  const { username, password } = await loadCredentials(ids.secretArn);

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const out = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: ids.userPoolId,
      ClientId: ids.clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const token = out?.AuthenticationResult?.AccessToken;
  if (!token) {
    throw new Error(
      "AdminInitiateAuth returned no AccessToken — check the test-user exists in the pool, the password matches the secret, and the app client allows ADMIN_USER_PASSWORD_AUTH.",
    );
  }
  cachedToken = token;
  return token;
}
