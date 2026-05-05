// Server-side runtime config. All values come from environment variables
// injected by the ECS task definition (Terraform-managed). NEXT_PUBLIC_*
// names are reserved for non-secrets; everything here is server-only.

export const config = {
  cognito: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    userPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    clientId: requireEnv('COGNITO_CLIENT_ID'),
    // Confidential — never reach a browser bundle. Read at request time.
    clientSecret: process.env.COGNITO_CLIENT_SECRET ?? '',
    hostedUiDomain: requireEnv('COGNITO_HOSTED_UI_DOMAIN'),
    // Group membership the backend asserts before letting a request through.
    requiredGroup: process.env.COGNITO_REQUIRED_GROUP ?? 'approved',
  },
  app: {
    // Public URL — used to construct redirect_uri values handed to Cognito.
    appUrl: requireEnv('APP_URL'),
    // Cookie name used to store the access token. Same shape as the JWT
    // verifier expects; rotate via env if upstream incident requires.
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'eag_session',
    // Cookie name for the OAuth state nonce.
    stateCookieName: process.env.STATE_COOKIE_NAME ?? 'eag_oauth_state',
  },
  strata: {
    // Internal Service Connect URL of the Strata-on-AWS service. Empty in
    // dev — AWS-3.2 wires the actual recall flow against this URL.
    internalUrl: process.env.STRATA_INTERNAL_URL ?? '',
    authProxyToken: process.env.STRATA_AUTH_PROXY_TOKEN ?? '',
  },
} as const;

export type AppConfig = typeof config;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    // Surface the missing variable name in the error so a misconfigured
    // task definition produces a debuggable failure rather than a silent
    // 500 with no signal.
    throw new Error(
      `[example-agent] Required env var ${name} is not set. ` +
        `Check the ECS task definition.`,
    );
  }
  return v;
}

// Build the issuer URL aws-jwt-verify expects as the JWT `iss` claim.
export function cognitoIssuer(): string {
  return `https://cognito-idp.${config.cognito.region}.amazonaws.com/${config.cognito.userPoolId}`;
}

// Build the Hosted UI base URL.
export function hostedUiBase(): string {
  return `https://${config.cognito.hostedUiDomain}.auth.${config.cognito.region}.amazoncognito.com`;
}
