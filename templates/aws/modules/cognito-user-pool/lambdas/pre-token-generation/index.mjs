// PreTokenGeneration trigger (v2 event format).
//
// Cognito invokes this on every token mint. The handler reads the user's
// `cognito:groups` membership and any custom attributes the user pool stores
// (`custom:tenant_id`, `custom:role`) and projects them into the access /
// id token claim payload so downstream services (Strata-on-AWS HTTP transport,
// example-agent middleware) can authorize on a single claim read.
//
// Pure event manipulation. No HTTP calls, no SDK calls, no third-party deps.
// Native runtime only.
//
// v2 event shape reference:
//   https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html

export const handler = async (event) => {
  const userAttrs = event.request?.userAttributes ?? {};
  const groups = event.request?.groupConfiguration?.groupsToOverride ?? [];

  const tenantId = userAttrs["custom:tenant_id"] ?? "";
  const role = userAttrs["custom:role"] ?? "";

  // Only emit non-empty claims to keep the token compact.
  const claimsToAddOrOverride = {};
  if (tenantId) claimsToAddOrOverride["tenant_id"] = tenantId;
  if (role) claimsToAddOrOverride["role"] = role;

  // The v2 event format wraps the response in `claimsAndScopeOverrideDetails`.
  // We project into both the access token and the id token so consumers that
  // verify either token type get the same authorization context.
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride,
      },
      accessTokenGeneration: {
        claimsToAddOrOverride,
        scopesToAdd: [],
        scopesToSuppress: [],
      },
      groupOverrideDetails: {
        groupsToOverride: groups,
        iamRolesToOverride: [],
        preferredRole: undefined,
      },
    },
  };

  return event;
};
