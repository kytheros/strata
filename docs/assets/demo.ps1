# Strata README demo — self-pacing PowerShell script for ScreenToGif recording.
#
# Uses an isolated temp data dir so it never touches your real ~/.strata/strata.db.
# Cleans up automatically at the end.
#
# To record:
#   1. Open ScreenToGif → Recorder.
#   2. Position the capture rectangle over a PowerShell window (~120 cols x 25 rows is a good size).
#   3. Click Record.
#   4. Switch focus to the PowerShell window and run:  .\demo.ps1
#   5. When the script finishes, click Stop in ScreenToGif and save the GIF to
#      strata/docs/assets/strata-demo.gif

$ErrorActionPreference = "Stop"

# Alias `strata` to the local dist build so the recording shows clean `strata` commands
# without requiring `npm install -g strata-mcp`.
$strataCli = Join-Path $PSScriptRoot "..\..\dist\cli.js" | Resolve-Path
function strata { node $strataCli @args }

$demoDir = Join-Path $env:TEMP ("strata-demo-" + [System.Guid]::NewGuid().ToString("N"))
$env:STRATA_DATA_DIR = $demoDir
New-Item -ItemType Directory -Path $demoDir -Force | Out-Null

try {
    Clear-Host

    Write-Host "PS> strata status" -ForegroundColor Cyan
    strata status
    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "PS> strata store-memory 'Use bcrypt with cost factor 12 for password hashing' --type decision" -ForegroundColor Cyan
    strata store-memory "Use bcrypt with cost factor 12 for password hashing" --type decision
    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "PS> strata search 'how do we hash passwords'" -ForegroundColor Cyan
    strata search "how do we hash passwords"
    Start-Sleep -Seconds 3
}
finally {
    Remove-Item -Recurse -Force $demoDir -ErrorAction SilentlyContinue
    Remove-Item Env:STRATA_DATA_DIR -ErrorAction SilentlyContinue
}
