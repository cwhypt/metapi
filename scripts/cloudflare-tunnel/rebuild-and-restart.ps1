# Full rebuild and restart of the metapi service.
#
# Usage:
#   .\scripts\cloudflare-tunnel\rebuild-and-restart.ps1
#
# What it does:
#   1. git pull
#   2. npm ci (if needed)
#   3. npm run build:web && npm run build:server
#   4. Restart-Service metapi
#   5. Verify /v1/models

$ErrorActionPreference = "Stop"
$ProjectDir = "C:\Users\allen\Documents\GitHub\metapi"
$ProxyToken = (Select-String -Path "$ProjectDir\.env" -Pattern "PROXY_TOKEN=(.+)").Matches.Groups[1].Value

Set-Location $ProjectDir

Write-Host "=== Pulling latest code ===" -ForegroundColor Cyan
git pull

Write-Host "`n=== Building web ===" -ForegroundColor Cyan
npm run build:web
if ($LASTEXITCODE -ne 0) { Write-Host "BUILD:WEB FAILED" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Building server ===" -ForegroundColor Cyan
npm run build:server
if ($LASTEXITCODE -ne 0) { Write-Host "BUILD:SERVER FAILED" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Restarting service ===" -ForegroundColor Cyan
Restart-Service metapi -Force
Start-Sleep 5

$svc = Get-Service metapi
Write-Host "Service status: $($svc.Status)" -ForegroundColor Cyan

Write-Host "`n=== Verifying /v1/models ===" -ForegroundColor Cyan
try {
    $r = Invoke-WebRequest "http://127.0.0.1:4000/v1/models" -Headers @{Authorization="Bearer $ProxyToken"} -UseBasicParsing -TimeoutSec 10
    Write-Host "HTTP $($r.StatusCode) - OK" -ForegroundColor Green
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
