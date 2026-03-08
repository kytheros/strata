/** Community edition stub — license activation tells users to use strata-pro. */

export type LicenseTier = "pro" | "team" | "enterprise";

export interface LicensePayload {
  sub: string;
  tier: LicenseTier;
  features: string[];
  exp: number;
  iat: number;
  iss: string;
  jti?: string;
}

export interface LicenseResult {
  valid: boolean;
  tier?: LicenseTier;
  features?: string[];
  email?: string;
  expiresAt?: number;
  error?: string;
}

export function validateLicense(_token: string, _publicKey?: string): LicenseResult {
  return {
    valid: false,
    error: "License activation requires @kytheros/strata-pro. Install it with: npm install -g @kytheros/strata-pro",
  };
}

export function generateTestLicense(_overrides?: Partial<LicensePayload>): string {
  throw new Error("Test license generation requires @kytheros/strata-pro");
}
