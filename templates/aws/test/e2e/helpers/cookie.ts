// Cookie helper for the E2E smoke suite.
//
// The harness uses a "cookie replay" model: a human runs Cognito Hosted UI
// once (Google federation), the app sets an `eag_session` HttpOnly cookie,
// and we extract that cookie value into `.work/session-cookie.txt`. Tests
// then attach it to /api/chat requests.
//
// We deliberately fail loudly when:
//   1. The file does not exist                — operator hasn't refreshed yet.
//   2. The file is empty / whitespace-only    — corrupted refresh.
//   3. The JWT inside is expired              — silent skip would mask a
//      legitimate test failure as "no cookie", so we hard-error and tell the
//      operator exactly what to run.
//
// We do NOT validate the JWT signature — that's API GW's job at request time,
// not the harness's. We only check `exp` so the test failure mode is
// "your cookie is stale" rather than "401 from the API for opaque reasons".

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REFRESH_HINT = "run `task auth-refresh` (or follow the README) to grab a fresh cookie";

/**
 * Resolve the cookie file path. Override via STRATA_DEV_COOKIE_FILE; defaults
 * to {repoRoot}/.work/session-cookie.txt where repoRoot is the strata sub-repo
 * (two levels up from this file: helpers -> e2e -> test -> aws -> templates -> strata).
 */
export function cookieFilePath(): string {
  if (process.env.STRATA_DEV_COOKIE_FILE) {
    return resolve(process.env.STRATA_DEV_COOKIE_FILE);
  }
  // __dirname equivalent for ESM: this file is templates/aws/test/e2e/helpers/cookie.ts.
  // Walk up to the strata sub-repo root.
  const here = new URL(".", import.meta.url).pathname;
  // On Windows, the leading slash from URL pathname needs to be stripped (e.g. /E:/strata/...).
  const normalized = process.platform === "win32" && here.startsWith("/") ? here.slice(1) : here;
  // helpers -> e2e -> test -> aws -> templates -> strata (sub-repo root)
  const repoRoot = resolve(normalized, "..", "..", "..", "..", "..");
  return join(repoRoot, ".work", "session-cookie.txt");
}

/**
 * Decode the `exp` claim of a JWT without verifying the signature. Returns
 * null if the token isn't shaped like a JWT (e.g. opaque session value), which
 * means we cannot pre-flight-check expiry — the request will tell us.
 */
function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice((payload.length + 3) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(decoded) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

export interface SessionCookie {
  /** Header value, e.g. `eag_session=eyJhbGc...` (no extra attributes). */
  header: string;
  /** Raw value (no `name=` prefix). */
  value: string;
  /** Cookie name (default `eag_session`). */
  name: string;
}

/**
 * Load the session cookie and validate it's still usable. Throws with an
 * actionable error message on any failure mode.
 *
 * Format of session-cookie.txt: a single line, either:
 *   1. `eag_session=<value>`   (preferred — disambiguates the cookie name)
 *   2. `<value>`               (assumed eag_session)
 */
export function loadSessionCookie(): SessionCookie {
  const path = cookieFilePath();

  if (!existsSync(path)) {
    throw new Error(
      `Session cookie file not found at ${path}. ${REFRESH_HINT}.`,
    );
  }

  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) {
    throw new Error(
      `Session cookie file ${path} is empty. ${REFRESH_HINT}.`,
    );
  }

  let name = "eag_session";
  let value = raw;
  if (raw.includes("=")) {
    const eq = raw.indexOf("=");
    name = raw.slice(0, eq).trim();
    value = raw.slice(eq + 1).trim();
  }

  // Strip any trailing attributes a copy-paste might have included (e.g.
  // `; Path=/; HttpOnly`). We only want the cookie value.
  if (value.includes(";")) {
    value = value.slice(0, value.indexOf(";")).trim();
  }

  if (!value) {
    throw new Error(
      `Session cookie file ${path} contains no value after '='. ${REFRESH_HINT}.`,
    );
  }

  // If it looks like a JWT, hard-fail on expired tokens — silently submitting
  // an expired token leads to confusing 401s downstream.
  const exp = decodeJwtExp(value);
  if (exp !== null) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp <= nowSec) {
      const ageMin = Math.round((nowSec - exp) / 60);
      throw new Error(
        `Session cookie expired ${ageMin} minute(s) ago (JWT exp=${exp}, now=${nowSec}). ${REFRESH_HINT}.`,
      );
    }
  }

  return {
    header: `${name}=${value}`,
    value,
    name,
  };
}
