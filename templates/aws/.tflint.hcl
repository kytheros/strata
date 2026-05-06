# tflint config for the strata-on-aws deploy template.
# Loaded by .github/workflows/aws-template-ci.yml.

config {
  format = "compact"
  call_module_type = "local"
  force = false
  disabled_by_default = false
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.32.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Modules pin required_version + required_providers in versions.tf —
# the recommended preset's terraform_required_version / terraform_required_providers
# rules are kept on. Naming, tagging, and unused-decl rules also stay on by default.

# Ignore checkov-skip annotations (those are checkov scope, not tflint).
rule "terraform_naming_convention" {
  enabled = true
  format  = "snake_case"
}

rule "terraform_unused_declarations" {
  enabled = true
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}
