# Post-apply seeding for the Strata-on-AWS dev stack.
# Run from anywhere after `task dev:up` completes.
#
# What it does (idempotent — safe to re-run):
#   1. Pulls the freshly-applied terraform outputs
#   2. Appends canary@strata.test to the SSM allowlist
#   3. Creates the canary Cognito user with a permanent random password
#   4. Seeds the canary credentials secret with that password
#   5. Seeds the real Anthropic API key
#   6. Forces a new ECS deployment for the example-agent so it picks up
#      the seeded Anthropic key
#
# Reads ANTHROPIC_API_KEY from E:\strata\.env (monorepo-root .env, gitignored).
# No keys live in this script.

$ErrorActionPreference = 'Stop'

# ---- Load ANTHROPIC_API_KEY from monorepo-root .env -------------------------
$envFile = 'E:\strata\.env'
if (-not (Test-Path $envFile)) {
    Write-Error "Cannot find $envFile. Create it with a line: ANTHROPIC_API_KEY=sk-ant-..."
    exit 1
}

$ANTHROPIC_API_KEY = $null
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '^ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$') {
        # Strip surrounding single or double quotes if present
        $val = $matches[1] -replace '^["'']', '' -replace '["'']$', ''
        $script:ANTHROPIC_API_KEY = $val
    }
}

if (-not $ANTHROPIC_API_KEY -or $ANTHROPIC_API_KEY -like '*paste-your*' -or $ANTHROPIC_API_KEY.Length -lt 20) {
    Write-Error "ANTHROPIC_API_KEY missing or too short in $envFile. Expected sk-ant-... value."
    exit 1
}

$env:AWS_DEFAULT_REGION = 'us-east-1'

Write-Host "==> Reading terraform outputs from envs/dev"
Push-Location E:\strata\strata\templates\aws\envs\dev
$poolId = (terraform output -raw cognito_user_pool_id).Trim()
$canarySecretArn = (terraform output -raw canary_credentials_secret_arn).Trim()
$anthropicSecretArn = (terraform output -raw anthropic_api_key_secret_arn).Trim()
$ingressDns = (terraform output -raw ingress_endpoint_dns).Trim()
Pop-Location

Write-Host "    user pool:        $poolId"
Write-Host "    canary secret:    $canarySecretArn"
Write-Host "    anthropic secret: $anthropicSecretArn"
Write-Host "    ingress dns:      $ingressDns"

Write-Host "`n==> [1/6] Append canary email to SSM allowlist"
# PowerShell→native-exe arg passing strips inner double quotes from a string
# argument, so `--value '["mkavalich@gmail.com",...]'` arrives at the AWS CLI
# as `[mkavalich@gmail.com,...]` — invalid JSON. Workaround: write the JSON
# payload to a temp file and use the AWS CLI `file://` URI prefix.
$allowlistJson = '["mkavalich@gmail.com","canary@strata.test","stratatest549@gmail.com"]'
$allowlistFile = New-TemporaryFile
[System.IO.File]::WriteAllText($allowlistFile.FullName, $allowlistJson, [System.Text.Encoding]::ASCII)
aws ssm put-parameter `
    --name "/example-agent/dev/allowed-emails" `
    --value "file://$($allowlistFile.FullName)" `
    --type SecureString --overwrite | Out-Null
Remove-Item $allowlistFile -Force

Write-Host "==> [2/6] Generate strong canary password"
Add-Type -AssemblyName System.Web
# 28 chars, mixed alpha-num + symbols Cognito accepts
$canaryPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$canaryPass = "$canaryPass" + 'Z9!a'
$canaryUser = 'canary@strata.test'

Write-Host "==> [3/6] Create Cognito canary user (idempotent)"
# PowerShell 5.1 quirk: redirecting native cmd stderr inside PS wraps stderr
# lines as NativeCommandError records and trips $ErrorActionPreference=Stop.
# Use cmd.exe to swallow stderr externally so $LASTEXITCODE is the only signal.
& cmd /c "aws cognito-idp admin-get-user --user-pool-id $poolId --username $canaryUser >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    aws cognito-idp admin-create-user `
        --user-pool-id $poolId --username $canaryUser `
        --user-attributes Name=email,Value=$canaryUser Name=email_verified,Value=true `
        --message-action SUPPRESS | Out-Null
    Write-Host "    created"
} else {
    Write-Host "    already exists, skipping create"
}

Write-Host "==> [4/6] Set permanent canary password"
aws cognito-idp admin-set-user-password `
    --user-pool-id $poolId --username $canaryUser `
    --password $canaryPass --permanent | Out-Null

Write-Host "==> [5/6] Seed canary credentials secret"
# Same PowerShell→native-exe quote-stripping bug as step [1/6]: a JSON
# string passed via `--secret-string '{"k":"v"}'` arrives at the AWS CLI
# as `{k:v}` (inner quotes stripped). Workaround: write the JSON to a
# temp file and use the AWS CLI `file://` URI prefix.
$canaryJson = (@{ username = $canaryUser; password = $canaryPass } | ConvertTo-Json -Compress)
$canaryFile = New-TemporaryFile
[System.IO.File]::WriteAllText($canaryFile.FullName, $canaryJson, [System.Text.Encoding]::ASCII)
aws secretsmanager put-secret-value `
    --secret-id $canarySecretArn `
    --secret-string "file://$($canaryFile.FullName)" | Out-Null
Remove-Item $canaryFile -Force

Write-Host "==> [6/6] Seed Anthropic API key"
aws secretsmanager put-secret-value `
    --secret-id $anthropicSecretArn `
    --secret-string $ANTHROPIC_API_KEY | Out-Null

Write-Host "`n==> Force ECS to pick up the new secrets"
aws ecs update-service --cluster strata-dev --service example-agent-dev `
    --force-new-deployment | Out-Null

Write-Host "`nDONE."
Write-Host "    URL:        https://$ingressDns"
Write-Host "    Sign in as: mkavalich@gmail.com (Google federation)"
Write-Host "`nWait ~3 min for the example-agent rollout, then visit the URL."
