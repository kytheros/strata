# Strata Licensing

## Overview

Strata uses an open-core licensing model:

- **Community edition** (free) -- No license key required. Provides 8 MCP tools, 3 AI tool parsers, and the full SQLite/FTS5 search engine. Install from npm and use immediately.
- **Pro edition** ($9/mo or $90/yr) -- Requires a license key (JWT). Adds semantic search, entity graph, procedures, cloud sync, analytics, LLM extraction, and 2 additional parsers.
- **Team edition** ($19/user/mo) -- Requires a license key (JWT). Adds shared knowledge, team sync, and role-based access control on top of all Pro features.

License keys are RSA-signed JWTs verified entirely offline. There is no phone-home, no telemetry, and no network call during verification.

## How Purchase Works

1. User visits `strata.kytheros.dev/pricing` and selects a tier.
2. Clicking a purchase button redirects to a **Polar.sh** checkout page.
3. Polar.sh handles payment processing, tax/VAT, and invoicing as Merchant of Record.
4. On successful payment, Polar fires a webhook to the **Supabase Edge Function** (`polar-webhook`).
5. The Edge Function:
   a. Verifies the Svix/Standard Webhooks signature (HMAC-SHA256).
   b. Finds or creates a Supabase auth user by email (auto-confirmed, since they paid).
   c. Upserts a subscription record in the `subscriptions` table.
   d. Generates an RSA-signed JWT license key and stores it in the `license_keys` table.
   e. Looks up the customer's Polar license key and stores it alongside the JWT.
   f. Sends a magic link so the user can log in to the dashboard.
6. User copies their license key (JWT or Polar key) from the dashboard.

See also: [MONETIZATION.md](./MONETIZATION.md), [INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

## JWT Structure

License keys are RS256-signed JWTs with the following structure.

### Header

```json
{
  "alg": "RS256",
  "typ": "JWT"
}
```

### Payload

| Field      | Type       | Description                                           |
|------------|------------|-------------------------------------------------------|
| `sub`      | `string`   | Customer email address                                |
| `tier`     | `string`   | License tier: `"pro"` or `"team"`                     |
| `features` | `string[]` | Feature flags enabled by this license                 |
| `exp`      | `number`   | Expiration timestamp (Unix seconds)                   |
| `iat`      | `number`   | Issued-at timestamp (Unix seconds)                    |
| `iss`      | `string`   | Issuer -- always `"kytheros.dev"`                     |
| `jti`      | `string`   | Unique token identifier (UUID)                        |

### Feature Flags by Tier

**Pro:**

```json
["pro", "vector_search", "llm_extraction", "cloud_sync", "analytics"]
```

**Team:**

```json
["pro", "vector_search", "llm_extraction", "cloud_sync", "analytics", "team_knowledge", "team_sync", "access_control"]
```

### Example Payload

```json
{
  "sub": "user@example.com",
  "tier": "pro",
  "features": ["pro", "vector_search", "llm_extraction", "cloud_sync", "analytics"],
  "exp": 1772600000,
  "iat": 1741200000,
  "iss": "kytheros.dev",
  "jti": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

## How Activation Works

There are three methods to activate a license, checked in priority order.

### Method 1: CLI Command (Recommended)

```bash
strata activate eyJhbGciOiJS...
```

This validates the JWT and writes it to `~/.strata/license.key` with `0o600` permissions. The CLI prints the tier, email, features, and expiration date on success.

### Method 2: Environment Variable

```bash
export STRATA_LICENSE_KEY=eyJhbGciOiJS...
```

Or in your MCP configuration:

```json
{
  "env": {
    "STRATA_LICENSE_KEY": "eyJhbGciOiJS..."
  }
}
```

The environment variable takes priority over the file.

### Method 3: Direct File

Place the JWT directly in `~/.strata/license.key`. The file should contain only the JWT string.

### Priority Order

When `initLicense()` is called (automatically on server start), the system checks:

1. `STRATA_LICENSE_KEY` environment variable
2. `~/.strata/license.key` file

The first valid source found is used. The result is cached in memory for the lifetime of the process.

## How Verification Works

License verification is performed entirely offline using the Node.js `crypto` module.

### Verification Steps

1. **Parse** -- Split the JWT into header, payload, and signature parts.
2. **Header check** -- Confirm `alg` is `RS256` and `typ` is `JWT`.
3. **Signature verification** -- Use `crypto.createVerify("RSA-SHA256")` with the embedded RSA public key to verify the signature over `header.payload`.
4. **Payload decode** -- Parse the base64url-decoded payload as JSON.
5. **Field validation** -- Confirm `sub`, `tier`, `features[]`, `exp`, and `iss` are present.
6. **Issuer check** -- Confirm `iss` equals `"kytheros.dev"`.
7. **Expiration check** -- Confirm `exp` is in the future (with 5-minute clock skew tolerance).

### Key Properties

- **RSA public key embedded in package** -- The production public key is compiled into `strata-pro/src/ee/license-validator.ts`. No network request is needed.
- **No phone-home** -- Verification never contacts any server. Works fully offline and in air-gapped environments.
- **Private key never in repo** -- The signing private key exists only in Supabase Edge Function secrets (`RSA_PRIVATE_KEY_PEM`).
- **Clock skew tolerance** -- 5 minutes (`CLOCK_SKEW_SECONDS = 300`) to accommodate minor time differences.

### Community Edition Behavior

The community edition (`strata/src/extensions/license-validator.ts`) contains a stub that always returns `{ valid: false }` with a message directing users to install strata-pro. The Pro edition replaces this file with the full RSA verification implementation.

## Feature Gating

Feature gating is how Pro/Team tools check whether the current license authorizes their use.

### API

```typescript
import { hasFeature, requireFeature, getLicenseInfo } from "./extensions/feature-gate.js";

// Check without throwing
if (hasFeature("vector_search")) {
  // enable vector search UI
}

// Check and throw if missing
requireFeature("cloud_sync");  // throws Error with upgrade instructions

// Get full license info
const info = getLicenseInfo();
// { tier: "pro", email: "...", features: [...], expiresAt: 1772600000 }
```

### Feature Flags

| Flag               | Tier      | Gates                                          |
|--------------------|-----------|-------------------------------------------------|
| `pro`              | Pro, Team | Parsers (Aider, Gemini CLI), entity extraction, procedures, confidence scoring, memory decay |
| `vector_search`    | Pro, Team | Semantic search (Gemini embeddings + hybrid RRF) |
| `llm_extraction`   | Pro, Team | LLM-powered knowledge extraction (Gemini)       |
| `cloud_sync`       | Pro, Team | Cloud sync push/pull (Supabase backend)          |
| `analytics`        | Pro, Team | Local usage analytics                            |
| `team_knowledge`   | Team      | Shared knowledge base                            |
| `team_sync`        | Team      | Bi-directional team knowledge sync               |
| `access_control`   | Team      | Role-based access (admin, member, viewer)        |

### How Gating Works

1. On MCP server startup, `initLicense()` loads and validates the license key.
2. Pro tools call `requireFeature("feature_name")` before executing.
3. If the license is missing, invalid, or lacks the required feature, `requireFeature()` throws an error with a link to the pricing page.
4. If the license is expired, the error includes the expiration date and a renewal link.
5. `hasFeature()` provides a non-throwing boolean check, used when tools need to conditionally enable capabilities.

### Community Edition Behavior

In the community edition, `hasFeature()` always returns `false` and `requireFeature()` always throws. `getLicenseInfo()` always returns `null`. Pro tools are not registered in the community MCP server.

## Expiration and Renewal

### How Expiration Works

- The JWT `exp` field is a Unix timestamp (seconds).
- For subscription-based licenses, `exp` is set to the subscription's `current_period_end`.
- If no period end is provided, the default expiration is 1 year from issuance.
- Verification checks `exp > (now - 300)` to allow 5 minutes of clock skew.

### When a License Expires

- `hasFeature()` returns `false` for all features.
- `requireFeature()` throws an error: "Your Strata Pro license expired on YYYY-MM-DD. Free tools remain available."
- Community edition tools (8 MCP tools) continue working normally.
- The `strata license` CLI command shows the expired status with the expiration date.

### Renewal

- Renewals are handled through Polar.sh (automatic subscription renewal).
- On renewal, Polar fires a `subscription.updated` webhook.
- The Edge Function generates a new JWT with the updated `exp` timestamp.
- User copies the new key from the dashboard and re-activates:
  ```bash
  strata activate eyJnew...
  ```

## Polar Key Activation

In addition to JWT license keys, Strata supports **Polar license keys** for download-based activation. These keys are used to download and install the Pro or Team package.

### Key Formats

| Format          | Prefix     | Purpose                                  |
|-----------------|------------|------------------------------------------|
| JWT             | `eyJ`      | Direct license activation (offline)      |
| Polar key       | `STRATA-`  | Download Pro/Team package from releases  |
| Polar key       | `pol_lic_` | Download Pro/Team package from releases  |

### Polar Key Activation Flow

```bash
strata activate STRATA-xxxxx [--binary] [--platform linux-x64]
```

1. The CLI detects the key prefix and routes to the Polar activation flow.
2. `fetchVersionInfo(key)` calls the releases Worker (`releases.kytheros.dev/versions`) to get the tier and latest version.
3. `downloadAndInstall()` downloads the artifact (tarball or binary) from the releases Worker, authenticated by the Polar key.
4. The download is verified via SHA-256 checksum (from the `x-checksum-sha256` response header).
5. **Tarball format**: Installed globally via `npm install -g <file>`.
6. **Binary format**: Copied to `~/.strata/bin/strata-{tier}[.exe]` with executable permissions.
7. The install configuration is saved to `~/.strata/config.json`.
8. The Polar key is saved to `~/.strata/polar.key` for future updates.

### Supported Platforms (Binary Format)

| Platform ID      | OS          | Architecture |
|------------------|-------------|--------------|
| `linux-x64`      | Linux       | x86_64       |
| `darwin-arm64`   | macOS       | Apple Silicon |
| `darwin-x64`     | macOS       | Intel        |
| `win-x64`        | Windows     | x86_64       |

### Self-Update

```bash
strata update
```

Reads the saved Polar key from `~/.strata/polar.key` and config from `~/.strata/config.json`, checks for a newer version, and downloads in the same format (tarball or binary) as the original installation.

## Architecture Diagram

```
Purchase Flow
=============

  User                   Polar.sh              Supabase Edge Function
  ----                   --------              ----------------------
    |                        |                          |
    |--- checkout ---------->|                          |
    |                        |--- webhook (POST) ------>|
    |                        |                          |
    |                        |           verify Svix signature (HMAC-SHA256)
    |                        |           find or create auth user by email
    |                        |           upsert subscription record
    |                        |           sign JWT with RSA private key
    |                        |           store JWT in license_keys table
    |                        |           send magic link email
    |                        |                          |
    |                        |<---- 200 OK -------------|
    |<--- payment success ---|                          |
    |                                                   |
    |--- login (magic link) --------------------------->|
    |<--- dashboard with JWT + Polar key ---------------|
    |                                                   |

Activation Flow (JWT)
=====================

  User                   Strata CLI              ~/.strata/
  ----                   ----------              ----------
    |                        |                       |
    |--- strata activate --->|                       |
    |    eyJ...              |                       |
    |                        |--- validateLicense -->|
    |                        |    RSA-SHA256 verify  |
    |                        |    check exp, iss     |
    |                        |                       |
    |                        |--- write license.key->|
    |<--- success -----------|                       |

Activation Flow (Polar Key)
===========================

  User                   Strata CLI           Releases Worker
  ----                   ----------           ---------------
    |                        |                       |
    |--- strata activate --->|                       |
    |    STRATA-xxxxx        |                       |
    |                        |--- GET /versions ---->|
    |                        |<--- tier, version ----|
    |                        |                       |
    |                        |--- GET /pro/latest -->|
    |                        |<--- artifact + hash --|
    |                        |                       |
    |                        |--- verify SHA-256     |
    |                        |--- npm install -g     |
    |                        |    or copy binary     |
    |                        |                       |
    |                        |--- save config.json   |
    |                        |--- save polar.key     |
    |<--- success -----------|                       |

Runtime Verification
====================

  MCP Server Start        feature-gate.ts       license-validator.ts
  ----------------        ---------------       --------------------
    |                          |                        |
    |--- initLicense() ------->|                        |
    |                          |--- read env var        |
    |                          |    or license.key      |
    |                          |                        |
    |                          |--- validateLicense() ->|
    |                          |    RSA public key      |
    |                          |    (embedded)          |
    |                          |                        |
    |                          |<--- LicenseResult -----|
    |                          |--- cache result        |
    |                          |                        |
    |--- hasFeature("pro") --->|                        |
    |<--- true/false ----------|                        |
    |                          |                        |
    |--- requireFeature() ---->|                        |
    |<--- ok or throw ---------|                        |
```

## File Locations

| File | Purpose |
|------|---------|
| `strata/src/extensions/license-validator.ts` | Community stub (always returns invalid) |
| `strata/src/extensions/feature-gate.ts` | Community stub (all features disabled) |
| `strata-pro/src/ee/license-validator.ts` | Full RSA-JWT verification implementation |
| `strata-pro/src/ee/feature-gate.ts` | Full feature gating with license loading |
| `strata/src/cli.ts` | CLI `activate` and `license` commands |
| `strata/src/cli/download.ts` | Polar key download and install logic |
| `strata/src/cli/platform.ts` | Platform detection for binary downloads |
| `strata-web/supabase/functions/polar-webhook/index.ts` | JWT signing Edge Function |
| `~/.strata/license.key` | User's JWT license key |
| `~/.strata/polar.key` | User's Polar license key (for updates) |
| `~/.strata/config.json` | Install configuration (tier, version, format) |
