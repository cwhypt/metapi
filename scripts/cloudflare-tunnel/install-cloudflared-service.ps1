# Install cloudflared as a Windows service (remotely-managed tunnel).
#
# Usage (run as Administrator):
#   .\install-cloudflared-service.ps1 -Token "eyJhIjoi..."
#
# Prereqs:
#   - cloudflared installed: https://github.com/cloudflare/cloudflared/releases
#   - Tunnel created in Cloudflare Zero Trust dashboard with a connector token

param(
    [Parameter(Mandatory=$true)]
    [string]$Token
)

$ErrorActionPreference = "Stop"

$CfExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $CfExe)) {
    $alt = Get-Command cloudflared -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    if ($alt) { $CfExe = $alt }
}
if (-not (Test-Path $CfExe)) {
    Write-Host "ERROR: cloudflared not found. Install from:" -ForegroundColor Red
    Write-Host "  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi"
    exit 1
}

Write-Host "Using cloudflared: $CfExe" -ForegroundColor Cyan

# Clean up leftover EventLog registry key (from previous installs)
Write-Host "Cleaning up leftover registry keys..." -ForegroundColor Yellow
Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\Cloudflared" -Force -ErrorAction SilentlyContinue
Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\cloudflared" -Force -ErrorAction SilentlyContinue

# Remove existing service if present
Write-Host "Removing existing service (if any)..." -ForegroundColor Yellow
& $CfExe service uninstall 2>&1 | Out-Null
Start-Sleep 3

# Install with token
Write-Host "Installing cloudflared service with token..." -ForegroundColor Yellow
& $CfExe service install $Token 2>&1

# Set crash recovery actions (restart after 5s, 10s, 30s)
Write-Host "Configuring crash recovery..." -ForegroundColor Yellow
sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Start-Sleep 8

# Verify
$svc = Get-Service Cloudflared -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host ""
    Write-Host "Service: $($svc.Name)" -ForegroundColor Cyan
    Write-Host "Status:  $($svc.Status)" -ForegroundColor Cyan
    Write-Host "StartType: $($svc.StartType)" -ForegroundColor Cyan
} else {
    Write-Host "ERROR: Service not found after install" -ForegroundColor Red
    exit 1
}

Write-Host "`nDone. Connector should appear in Cloudflare Zero Trust dashboard." -ForegroundColor Green
Write-Host "Next step: Add a public hostname route in the dashboard:" -ForegroundColor Yellow
Write-Host "  Subdomain: metapi-106-backup" -ForegroundColor Yellow
Write-Host "  Domain: weihaocao.com" -ForegroundColor Yellow
Write-Host "  Service: HTTP -> localhost:4000" -ForegroundColor Yellow
