/**
 * Community edition feature gate — all pro features disabled.
 * Pro/Team editions replace this file with the full license-aware implementation.
 */

export function initLicense(): void {
  // No-op in community edition
}

export function hasFeature(_feature: string): boolean {
  return false;
}

export function requireFeature(feature: string): void {
  throw new Error(
    `The "${feature}" feature requires Strata Pro. Visit strata.kytheros.dev/pricing to upgrade.`
  );
}

export interface LicenseInfo {
  tier: string;
  email: string;
  features: string[];
  expiresAt: number;
}

export function getLicenseInfo(): LicenseInfo | null {
  return null;
}

export interface RawLicenseResult {
  valid: boolean;
  tier?: string;
  email?: string;
  features?: string[];
  expiresAt?: number;
  error?: string;
}

export function getRawLicenseResult(): RawLicenseResult {
  return { valid: false, error: "Community edition — no license required" };
}

export function resetLicenseCache(): void {
  // No-op
}

export function setTestPublicKey(_key: string | null): void {
  // No-op
}
