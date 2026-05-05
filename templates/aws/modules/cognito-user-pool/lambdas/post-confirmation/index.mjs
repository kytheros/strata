// PostConfirmation trigger — INERT MODULE-DEFAULT STUB.
//
// This stub does nothing. It is wired by default so the user pool's trigger
// graph is complete on first apply; the example-agent service (AWS-3.2)
// replaces it with a group-assigner that adds confirmed users to the
// `approved` Cognito group.
//
// To replace, set var.post_confirmation_lambda_arn on the module — the module
// will rewire the trigger to point at the supplied ARN and stop using this
// stub.
//
// Native runtime only — no third-party deps.

export const handler = async (event) => {
  return event;
};
