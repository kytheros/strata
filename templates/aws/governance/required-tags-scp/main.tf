# governance/required-tags-scp -- STUB, do not apply until AWS Organizations is adopted.
# See README.md for prerequisites and the required-tags-scp.json policy document.
#
# The actual SCP resources are commented out below. The terraform block is
# uncommented purely so tflint's terraform_required_version rule passes (the
# whole file is otherwise inert).

terraform {
  required_version = "~> 1.7"
}

# Terraform resources (commented out intentionally):
#
# resource "aws_organizations_policy" "required_tags" {
#   name        = "strata-required-tags"
#   description = "Deny resource creation without Project/Environment/ManagedBy/CostCenter tags."
#   type        = "SERVICE_CONTROL_POLICY"
#   content     = file("required-tags-scp.json")
# }
#
# resource "aws_organizations_policy_attachment" "strata_ou" {
#   policy_id = aws_organizations_policy.required_tags.id
#   target_id = "ou-xxxx-xxxxxxxx"
# }
