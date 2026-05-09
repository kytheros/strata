# Strata-on-AWS E2E Smoke Suite

Six Playwright cases that hit the live dev stack from outside the VPC and assert the cross-cutting wiring that unit tests cannot see — DNS, SG ingress, env-var injection, Cognito redirect URL composition, JWT-sub header injection, MCP `initialize` handshake, SSE framing, and the full `/api/chat` Anthropic + tool loop.

If this suite is green, the dev stack is exercising every external boundary the way a real Claude-Code-on-MCP user would.

## Why a separate suite?

The existing vitest suite under `services/example-agent/app/test/tools/` exercises business logic with mocks. It cannot catch:

- DNS hostnames typed wrong in Terraform
- Security Group ingress rules missing
- ECS task missing an environment variable
- API GW JWT authorizer pointed at the wrong issuer
- API GW header-injection step dropping `X-Strata-Verified`
- Strata MCP `initialize` handshake regression
- SSE framing regression on `/mcp`
- The `/api/chat` Anthropic + MCP-tool loop deadlocking

These are the bugs we hit 9 times in the last 2 days. This suite catches them.

## Prerequisites

1. **Node 22+** and `npm`.
2. **AWS CLI configured** for account `<ACCOUNT_ID>` (the dev account).
3. **Terraform initialized** in `templates/aws/envs/dev/` — the test harness reads `cognito_user_pool_id`, `cognito_test_user_client_id`, and `canary_credentials_secret_arn` via `terraform output -raw`.
4. **Test-user credentials seeded** in Secrets Manager. The orchestrator provisions the secret empty; one-time:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id $(terraform -chdir=envs/dev output -raw canary_credentials_secret_arn) \
     --secret-string '{"username":"canary@strata.test","password":"<password>"}'
   ```
5. **Session cookie file** at `<repo>/.work/session-cookie.txt` for the `/api/chat` case (case 6). See the cookie refresh section.

## Install

From `templates/aws/`:

```bash
npm install
npx playwright install chromium  # optional — this suite uses request fixtures only, no browser
```

(The `chromium install` is unnecessary for this smoke suite; included as a hint for when we add browser-driven UI tests later.)

## Run

From `templates/aws/`:

```bash
# default — hits the live dev stack at the URL baked into playwright.config.ts
npx playwright test --grep @smoke

# point at another stack
STRATA_DEV_URL=https://abc123.execute-api.us-east-1.amazonaws.com \
  npx playwright test --grep @smoke
```

Or via Taskfile from `templates/aws/`:

```bash
task dev:smoke
```

Exit code 0 = all 6 cases green. Non-zero = at least one case failed; check the per-test output for the body capture.

## Refreshing the session cookie

Case 6 (`POST /api/chat`) replays a cookie obtained from a real Cognito Hosted UI sign-in. The cookie is `eag_session` and lasts ~1 hour by default.

Manual refresh:

1. Open `https://tk4ti92jwc.execute-api.us-east-1.amazonaws.com` (or the current `STRATA_DEV_URL`) in a browser.
2. Sign in via the Cognito Hosted UI (Google federation, allowlisted email).
3. After the redirect lands on the app, open DevTools → Application → Cookies. Copy the value of `eag_session`.
4. Write it to `<repo>/.work/session-cookie.txt`. Either format works:
   ```
   eag_session=<value>
   ```
   or just:
   ```
   <value>
   ```

The harness:
- Hard-fails with a clear hint if the file is missing or empty.
- Decodes the JWT `exp` claim and hard-fails if expired (no silent skip).
- Strips trailing cookie attributes (`; Path=/; ...`) automatically.

The `.work/` directory is gitignored at the repo root.

## What each case proves

| # | Case | Catches |
|---|------|---------|
| 1 | `GET /health` returns 200 `{status:"ok"}` | DNS, ingress wiring, Strata reachable |
| 2 | `GET /` (anonymous) renders landing page | Container booted with env, ingress on right TG |
| 3 | `GET /api/auth/login` 307 → Cognito Hosted UI with `client_id`, `redirect_uri`, `state` | Cognito env vars wired, app_url correct |
| 4 | `POST /mcp` without auth → 401 | API GW JWT authorizer attached, no public bypass |
| 5 | `POST /mcp` initialize + tools/list with test-user token → ≥10 tools, SSE framed | Authorizer accepts test-user token, header injection works, MCP handshake clean, SSE parse clean |
| 6 | `POST /api/chat` with cookie → non-empty Claude response with valid `stoppedReason` | Full Anthropic + tool loop end-to-end |

## Cost

Each run costs:

- 1 × Cognito `AdminInitiateAuth` (free)
- 1 × Secrets Manager `GetSecretValue` (~$0.000005)
- 2 × MCP requests against Strata (free; runs inside our infra)
- 1 × Anthropic API call (~$0.001 — `say hi` is short)
- A few API GW + Lambda hits (~$0.000001)

Run as often as you like.

## Constraints

- Do not run this against production. The `/api/chat` case sends a real prompt to Anthropic; against prod that would emit a real conversation. The harness has no production guard — if you point it at prod, that's on you.
- Do not extend this suite past ~10 cases. Past ~10 cases, real E2E suites get ignored. If a case is not catching a cross-cutting wiring bug, it belongs in vitest.
