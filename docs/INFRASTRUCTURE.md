# Strata Web Platform Infrastructure

> This document describes the infrastructure for `strata-web/`, the marketing and authentication frontend for the Strata product family. It is maintained in `strata/docs/` because the web platform does not have its own `docs/` directory.

## Platform Overview

The Strata web platform is built on three services:

| Component        | Provider          | Role                                           |
|------------------|-------------------|-------------------------------------------------|
| **Auth + DB**    | Supabase          | User authentication, subscription/license storage, RLS policies |
| **Payments**     | Polar.sh          | Checkout, subscription management, Merchant of Record (handles tax/VAT globally) |
| **Hosting**      | Cloudflare Pages  | Static site hosting for the React SPA           |
| **Edge Functions** | Supabase        | Webhook handler (JWT signing), deploy callback   |

### Tech Stack

- React 19 + React Router 7
- Vite 6 (build tool)
- TypeScript 5.7 (strict mode)
- Supabase JS SDK v2
- Playwright (E2E tests)

## Supabase Setup

### Project Creation

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Note the project URL and anon key for the frontend.
3. Note the service role key for Edge Functions (never expose in the frontend).

### Tables

The database schema is defined in SQL migrations under `strata-web/supabase/migrations/`.

#### `subscriptions`

Tracks Polar subscription state for each user.

| Column                    | Type          | Constraints                                       |
|---------------------------|---------------|---------------------------------------------------|
| `id`                      | `UUID`        | Primary key, auto-generated                       |
| `user_id`                 | `UUID`        | Foreign key to `auth.users(id)`, `ON DELETE CASCADE` |
| `polar_subscription_id`   | `TEXT`        | Unique -- Polar's subscription identifier         |
| `plan`                    | `TEXT`        | `CHECK (plan IN ('pro', 'team'))`                 |
| `status`                  | `TEXT`        | `CHECK (status IN ('active', 'cancelled', 'expired', 'past_due'))` |
| `current_period_start`    | `TIMESTAMPTZ` | Start of the current billing period               |
| `current_period_end`      | `TIMESTAMPTZ` | End of the current billing period                 |
| `cancelled_at`            | `TIMESTAMPTZ` | When the subscription was cancelled (nullable)    |
| `created_at`              | `TIMESTAMPTZ` | Auto-set on insert                                |
| `updated_at`              | `TIMESTAMPTZ` | Auto-updated via trigger                          |

Indexes: `idx_subscriptions_user_id`, `idx_subscriptions_polar_id`.

#### `license_keys`

Stores generated JWT license keys and their associated Polar keys.

| Column              | Type          | Constraints                                       |
|---------------------|---------------|---------------------------------------------------|
| `id`                | `UUID`        | Primary key, auto-generated                       |
| `user_id`           | `UUID`        | Foreign key to `auth.users(id)`, `ON DELETE CASCADE` |
| `jti`               | `TEXT`        | Unique -- JWT token identifier                    |
| `tier`              | `TEXT`        | `CHECK (tier IN ('pro', 'team'))`                 |
| `jwt`               | `TEXT`        | The signed JWT license key                        |
| `polar_license_key` | `TEXT`        | The customer's Polar license key (nullable)       |
| `features`          | `JSONB`       | Array of feature flags, default `[]`              |
| `expires_at`        | `TIMESTAMPTZ` | When the license expires                          |
| `revoked_at`        | `TIMESTAMPTZ` | When the license was revoked (nullable)           |
| `created_at`        | `TIMESTAMPTZ` | Auto-set on insert                                |

Indexes: `idx_license_keys_user_id`, `idx_license_keys_jti`.

#### `deployments`

Tracks cloud deployment instances (for cloud sync feature).

| Column             | Type          | Constraints                                        |
|--------------------|---------------|----------------------------------------------------|
| `id`               | `UUID`        | Primary key, auto-generated                        |
| `user_id`          | `UUID`        | Foreign key to `auth.users(id)`, `ON DELETE SET NULL` |
| `license_jti`      | `TEXT`        | Unique -- links deployment to a license            |
| `service_url`      | `TEXT`        | The deployed service URL                           |
| `encrypted_api_key`| `TEXT`        | AES-256-GCM encrypted API key (nullable)           |
| `encryption_iv`    | `TEXT`        | Initialization vector for decryption (nullable)    |
| `region`           | `TEXT`        | Deployment region (nullable)                       |
| `gcp_project`      | `TEXT`        | GCP project ID (nullable)                          |
| `status`           | `TEXT`        | `CHECK (status IN ('active', 'inactive', 'error'))`, default `'active'` |
| `deployed_at`      | `TIMESTAMPTZ` | When the deployment was created                    |
| `updated_at`       | `TIMESTAMPTZ` | Auto-updated via trigger                           |

Indexes: `idx_deployments_user_id`, `idx_deployments_license_jti`.

Realtime enabled: `deployments` is added to `supabase_realtime` publication.

### Row Level Security (RLS)

All three tables have RLS enabled. The policies are simple -- users can only view their own records:

- `"Users can view own subscriptions"` -- `auth.uid() = user_id`
- `"Users can view own license keys"` -- `auth.uid() = user_id`
- `"Users can view own deployments"` -- `auth.uid() = user_id`

Write operations are performed by Edge Functions using the service role key, which bypasses RLS.

### Auto-Updated Timestamps

Triggers on `subscriptions` and `deployments` automatically set `updated_at` to `now()` on every update, using the `handle_updated_at()` function.

### Migrations

| File                                | Description                              |
|-------------------------------------|------------------------------------------|
| `0001_initial_schema.sql`           | Creates all three tables, RLS, triggers  |
| `0002_add_polar_license_key.sql`    | Adds `polar_license_key` column to `license_keys` |

## Polar.sh Configuration

### Products

Create three products in the Polar.sh dashboard:

| Product           | Price    | Billing   |
|-------------------|----------|-----------|
| Pro Monthly       | $9/mo    | Recurring |
| Pro Annual        | $90/yr   | Recurring |
| Team Monthly      | $19/user/mo | Recurring |

### Checkout Links

Each product generates a checkout link (format: `polar_cl_xxxx`). These are configured as Vite environment variables:

```
VITE_POLAR_PRO_MONTHLY_LINK=polar_cl_xxxx
VITE_POLAR_PRO_ANNUAL_LINK=polar_cl_xxxx
VITE_POLAR_TEAM_MONTHLY_LINK=polar_cl_xxxx
```

Set `VITE_POLAR_SANDBOX=true` to use sandbox checkout links during development.

### Webhook URL

Configure a webhook in the Polar.sh dashboard pointing to your Supabase Edge Function:

```
https://<project-ref>.supabase.co/functions/v1/polar-webhook
```

Subscribe to these events:
- `subscription.created`
- `subscription.active`
- `subscription.updated`
- `subscription.canceled`

### Svix Verification

Polar uses the Standard Webhooks specification (Svix) for signature verification. The webhook secret is provided by Polar and stored in Supabase secrets.

Secret formats:
- `whsec_xxxx` -- Legacy Svix format. Strip prefix, base64-decode to get HMAC key.
- `polar_whs_xxxx` or raw string -- Use raw UTF-8 bytes as HMAC key (matches Polar SDK behavior).

The signature verification process:
1. Read `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers (falls back to `svix-*` headers).
2. Reject timestamps older than 5 minutes to prevent replay attacks.
3. Compute `HMAC-SHA256(secret, "${msgId}.${timestamp}.${body}")`.
4. Compare against the `v1,<base64>` value in the signature header.

## Webhook Flow

```
Polar.sh                Supabase Edge Function          Supabase DB
--------                ----------------------          -----------
    |                            |                          |
    |--- POST /polar-webhook --->|                          |
    |    webhook-id: msg_xxx     |                          |
    |    webhook-timestamp: ...  |                          |
    |    webhook-signature: ...  |                          |
    |    { type, data }          |                          |
    |                            |                          |
    |                   verify Svix signature               |
    |                   parse event type                    |
    |                            |                          |
    |               [subscription.created/active/updated]   |
    |                            |                          |
    |                            |--- findOrCreateUser ---->|
    |                            |    listUsers(email)      |
    |                            |    or createUser(email)  |
    |                            |                          |
    |                            |--- upsert subscription ->|
    |                            |    polar_subscription_id |
    |                            |                          |
    |                            |--- check existing key -->|
    |                            |    (idempotency)         |
    |                            |                          |
    |                            |--- sign JWT (RS256) -----|
    |                            |    { sub, tier,          |
    |                            |      features, exp,      |
    |                            |      iss, jti }          |
    |                            |                          |
    |                            |--- insert license_key -->|
    |                            |                          |
    |                            |--- fetch Polar key ----->| (Polar API)
    |                            |--- store polar key ----->|
    |                            |                          |
    |                            |--- generate magic link ->|
    |                            |                          |
    |<--- 200 { ok, jti } ------|                          |
    |                            |                          |
    |               [subscription.canceled]                 |
    |                            |                          |
    |                            |--- update subscription ->|
    |                            |    status: cancelled      |
    |                            |                          |
    |                            |--- revoke license keys ->|
    |                            |    set revoked_at         |
    |                            |                          |
    |<--- 200 { ok } -----------|                          |
```

### Event Handling

| Event                      | Action                                                    |
|----------------------------|-----------------------------------------------------------|
| `subscription.created`     | Create user, upsert subscription, generate JWT            |
| `subscription.active`      | Same as created (first payment confirmed)                 |
| `subscription.updated`     | Same as created (renewal, plan change)                    |
| `subscription.canceled`    | Update subscription status, revoke all active license keys |
| Other events               | Acknowledge with 200, no action                           |

### Idempotency

The webhook handler is idempotent:
- Subscriptions are upserted on `polar_subscription_id` (unique constraint).
- Before generating a new JWT, it checks for an existing non-revoked license key for the user and tier. If one exists, it returns the existing `jti` instead of creating a duplicate.

## Deploy Callback

The `deploy-callback` Edge Function handles cloud deployment registration:

1. Authenticated via a shared secret (`DEPLOY_CALLBACK_SECRET` in the `Authorization: Bearer` header).
2. Receives `service_url`, `api_key`, and optionally `license_key`, `region`, `gcp_project`.
3. Encrypts the API key using AES-256-GCM with a server-side encryption key.
4. If a `license_key` JWT is provided, extracts the `jti` and looks up the associated user.
5. Upserts the deployment record (conflicts on `license_jti`).

## Secrets Management

### Supabase Edge Function Secrets

Set these via the Supabase dashboard or CLI (`supabase secrets set`):

| Secret                         | Purpose                                          |
|--------------------------------|--------------------------------------------------|
| `POLAR_WEBHOOK_SECRET`         | Production Svix webhook signing secret            |
| `POLAR_SANDBOX_WEBHOOK_SECRET` | Sandbox webhook signing secret (optional)         |
| `POLAR_ACCESS_TOKEN`           | Polar API token for license key lookups           |
| `POLAR_ORG_ID`                 | Polar organization ID                             |
| `POLAR_API_BASE`               | Polar API base URL (default: `https://api.polar.sh`) |
| `RSA_PRIVATE_KEY_PEM`          | RSA private key for JWT signing (PEM format)      |
| `SUPABASE_URL`                 | Auto-injected by Supabase runtime                 |
| `SUPABASE_SERVICE_ROLE_KEY`    | Auto-injected by Supabase runtime                 |
| `DEPLOY_CALLBACK_SECRET`       | Shared secret for deploy-callback auth            |
| `DEPLOY_ENCRYPTION_KEY`        | 256-bit hex string for AES-256-GCM encryption     |

### Frontend Environment Variables

Set in `.env.local` or your hosting provider's environment settings:

| Variable                         | Purpose                                       |
|----------------------------------|-----------------------------------------------|
| `VITE_SUPABASE_URL`             | Supabase project URL                           |
| `VITE_SUPABASE_ANON_KEY`       | Supabase anonymous (public) key                |
| `VITE_POLAR_SANDBOX`           | Set to `true` for sandbox checkout links       |
| `VITE_POLAR_PRO_MONTHLY_LINK`  | Polar checkout link for Pro monthly            |
| `VITE_POLAR_PRO_ANNUAL_LINK`   | Polar checkout link for Pro annual             |
| `VITE_POLAR_TEAM_MONTHLY_LINK` | Polar checkout link for Team monthly           |

### Key Security Notes

- The `RSA_PRIVATE_KEY_PEM` must never appear in source code or frontend bundles. It exists only in Supabase Edge Function secrets.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and must only be used in server-side code (Edge Functions).
- The `VITE_SUPABASE_ANON_KEY` is safe to include in the frontend bundle -- RLS policies protect data.
- The `DEPLOY_ENCRYPTION_KEY` and `DEPLOY_CALLBACK_SECRET` are server-side only.

## Cloudflare Pages

### Build Settings

| Setting       | Value                  |
|---------------|------------------------|
| Framework     | Vite                   |
| Build command | `tsc -b && vite build` |
| Output dir    | `dist`                 |
| Node version  | 18+                    |

### Deployment

The site is deployed from the `strata-web/` directory. Cloudflare Pages automatically builds and deploys on push to the configured branch.

Environment variables (`VITE_*`) must be set in the Cloudflare Pages dashboard under Settings > Environment Variables.

## Monitoring

### Supabase Dashboard

- **Auth > Users** -- View all registered users, login history.
- **Table Editor** -- Inspect `subscriptions`, `license_keys`, and `deployments` tables directly.
- **Edge Functions > Logs** -- Real-time logs from the `polar-webhook` and `deploy-callback` functions. Check here first when debugging webhook failures.

### Polar.sh Dashboard

- **Webhooks > Delivery History** -- View all webhook attempts, payloads, and response codes. Useful for diagnosing failed deliveries.
- **Subscriptions** -- View active subscriptions, cancellations, and payment status.
- **License Keys** -- Polar-managed keys (separate from the JWT keys generated by the Edge Function).

### Common Issues

| Symptom                          | Likely Cause                                   | Fix                                        |
|----------------------------------|------------------------------------------------|--------------------------------------------|
| Webhook returns 401              | Svix signature mismatch                        | Verify `POLAR_WEBHOOK_SECRET` matches Polar dashboard |
| User not created on checkout     | Edge Function error                            | Check Edge Function logs in Supabase       |
| License key not appearing        | Idempotency check found existing key           | Check `license_keys` table for existing non-revoked row |
| Magic link not sent              | Supabase email provider not configured         | Set up email provider in Auth > Settings   |
| Deploy callback 401              | Wrong `DEPLOY_CALLBACK_SECRET`                 | Verify secret matches caller configuration |

## Related Documentation

- [LICENSING.md](./LICENSING.md) -- How license keys are structured, validated, and activated
- [MONETIZATION.md](./MONETIZATION.md) -- Pricing tiers, feature matrix, and business model
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- Core engine architecture (search, indexing, knowledge extraction)
