// PreSignUp trigger — INERT MODULE-DEFAULT STUB.
//
// This stub auto-confirms every signup. It is intentionally permissive so the
// module can stand up a working user pool on first apply without requiring a
// consumer-supplied Lambda. The example-agent service (AWS-3.1) replaces this
// with an allowlist enforcer that rejects unknown federated emails.
//
// To replace, set var.pre_signup_lambda_arn on the module — the module will
// rewire the trigger to point at the supplied ARN and stop using this stub.
//
// Native runtime only — no third-party deps.

export const handler = async (event) => {
  event.response = event.response ?? {};
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
