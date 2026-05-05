// OAuth code exchange + Hosted-UI URL construction.
//
// All HTTP calls use native fetch — repo CLAUDE.md "HTTP Client Policy"
// bans third-party HTTP clients (axios/got/node-fetch/superagent/request).
// The Semgrep rule `banned-http-client-library` enforces this at CI.

import { config, hostedUiBase } from './config';

export interface CognitoTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  expires_in: number;
}

// Build the Hosted UI authorize URL. The frontend redirects to this when a
// user hits a protected route without a valid session cookie. Cognito
// renders the federation buttons (Google + any other configured IdP) plus
// the local-account fallback.
export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognito.clientId,
    redirect_uri: redirectUri,
    scope: 'email openid profile',
    state,
  });
  return `${hostedUiBase()}/oauth2/authorize?${params.toString()}`;
}

// Build the Hosted UI logout URL. After Cognito clears its session cookie
// it 302s back to logout_uri (which must match a value in the App Client's
// `logout_urls` list).
export function buildLogoutUrl(logoutUri: string): string {
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: logoutUri,
  });
  return `${hostedUiBase()}/logout?${params.toString()}`;
}

// Exchange an authorization code for tokens. Confidential client — the
// client_secret is sent in the Authorization header (Basic auth) per
// RFC 6749 §2.3.1.
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<CognitoTokenResponse> {
  if (!config.cognito.clientSecret) {
    throw new Error(
      '[example-agent] COGNITO_CLIENT_SECRET is empty — confidential client OAuth code ' +
        'exchange requires the secret. Check the ECS task definition secrets block.',
    );
  }

  const tokenUrl = `${hostedUiBase()}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.cognito.clientId,
    code,
    redirect_uri: redirectUri,
  });

  const basicAuth = Buffer.from(
    `${config.cognito.clientId}:${config.cognito.clientSecret}`,
  ).toString('base64');

  // Native fetch — Node 22 ships it built-in. No third-party HTTP client.
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(
      `[example-agent] Cognito token exchange failed: ${res.status} ${res.statusText} — ${text}`,
    );
  }

  return (await res.json()) as CognitoTokenResponse;
}

// Generate a cryptographically random state nonce. We attach it to the
// authorize URL and to a short-lived cookie so the callback can detect
// CSRF / replay attacks.
export function newOauthState(): string {
  // Web Crypto is available in Node 22 and in the Edge runtime — no Node
  // 'crypto' import, so this stays portable across server runtimes.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
