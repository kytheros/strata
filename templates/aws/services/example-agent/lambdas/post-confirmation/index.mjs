// PostConfirmation trigger — example-agent group-assigner.
//
// Cognito invokes this Lambda after the user record is confirmed (which the
// pre-signup Lambda did via autoConfirmUser=true). We add the user to the
// `approved` Cognito group so subsequent JWT verifications carry the group
// claim and authorize the user against /api/chat.
//
// SILENT-FAILURE DESIGN — INTENTIONAL.
// If AdminAddUserToGroupCommand fails (rate limit, transient API error, IAM
// hiccup, etc.) we DO NOT throw. Throwing here would fail the entire signup,
// erasing the user record we just confirmed and forcing them to start over.
// The downside is that we may end up with a confirmed user who is not in the
// `approved` group — they will fail the group-membership check at /api/chat
// and need a manual fix-up:
//
//   aws cognito-idp admin-add-user-to-group \
//     --user-pool-id <id> --username <sub> --group-name approved
//
// This trade-off favors keeping confirmed users intact. We log the error
// loudly so an on-call operator can spot it and fix membership manually.
//
// IAM scope (set by infrastructure/main.tf):
//   - cognito-idp:AdminAddUserToGroup scoped to the user pool ARN only
//   - basic CloudWatch Logs (managed policy)
//
// Native runtime — no third-party HTTP libs.

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const APPROVED_GROUP_NAME = process.env.APPROVED_GROUP_NAME ?? "approved";

const cognito = new CognitoIdentityProviderClient({});

export const handler = async (event) => {
  // Cognito provides userPoolId on the event — we don't hardcode it. This
  // makes the Lambda safe to attach to any pool (test, staging, prod) without
  // re-deploying with a different env var.
  const userPoolId = event?.userPoolId;
  const userName = event?.userName;

  if (!userPoolId || !userName) {
    console.error("[post-confirmation] event missing userPoolId or userName", {
      triggerSource: event?.triggerSource,
      userPoolId,
      userName,
    });
    return event;
  }

  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: userName,
        GroupName: APPROVED_GROUP_NAME,
      }),
    );
    console.info("[post-confirmation] added to group", {
      userName,
      group: APPROVED_GROUP_NAME,
    });
  } catch (err) {
    // Per the silent-failure design above: log loudly, do not throw.
    console.error(
      "[post-confirmation] AdminAddUserToGroup failed — user is confirmed but NOT in the approved group; manual fix-up required",
      {
        userName,
        userPoolId,
        group: APPROVED_GROUP_NAME,
        error: err?.message,
        name: err?.name,
      },
    );
  }

  return event;
};
