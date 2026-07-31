# Install metapi as a Windows service using NSSM with auto-start.
#
# Usage (run as Administrator):
#   Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File scripts\cloudflare-tunnel\install-metapi-service.ps1"
#
# Prereqs:
#   - NSSM installed: winget install nssm
#   - metapi built: npm run build:web && npm run build:server
#   - .env created in project root

$ErrorActionPreference = "Stop"

$ProjectDir = "C:\Users\allen\Documents\GitHub\metapi"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ServiceName = "metapi"
$LogDir      = "$ProjectDir\logs"

# Find NSSM
$nssm = (Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "nssm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $nssm) {
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}
if (-not $nssm) {
    # Fallback to common path
    $nssm = "C:\Program Files\NSSM\win64\nssm.exe"
}
if (-not (Test-Path $nssm)) {
    Write-Host "ERROR: NSSM not found. Install with: winget install nssm" -ForegroundColor Red
    exit 1
}

Write-Host "Using NSSM: $nssm" -ForegroundColor Cyan
Write-Host "Project dir: $ProjectDir" -ForegroundColor Cyan

# Create log directory
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# Remove existing service if present
Write-Host "Removing existing service (if any)..." -ForegroundColor Yellow
& $nssm stop $ServiceName 2>&1 | Out-Null
Start-Sleep 2
& $nssm remove $ServiceName confirm 2>&1 | Out-Null

# Install
Write-Host "Installing service '$ServiceName'..." -ForegroundColor Yellow
& $nssm install $ServiceName $NodeExe "$ProjectDir\dist\server\index.js"
& $nssm set $ServiceName AppDirectory $ProjectDir
& $nssm set $ServiceName AppEnvironmentExtra NODE_ENV=production
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName Description "Metapi gateway server"
& $nssm set $ServiceName AppStdout "$LogDir\metapi.out.log"
& $nssm set $ServiceName AppStderr "$LogDir\metapi.err.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760

# Start
Write-Host "Starting service..." -ForegroundColor Yellow
& $nssm start $ServiceName
Start-Sleep 5

# Verify
$svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Service: $($svc.Name)" -ForegroundColor Cyan
Write-Host "Status:  $($svc.Status)" -ForegroundColor Cyan
Write-Host "StartType: $($svc.StartType)" -ForegroundColor Cyan

$port = (Test-NetConnection 127.0.0.1 -Port 4000 -WarningAction SilentlyContinue).TcpTestSucceeded
Write-Host "Port 4000: $(if($port){'open'}else{'closed'})" -ForegroundColor $(if($port){'Green'}else{'Red'})

Write-Host "`nDone. Logs at: $LogDir\metapi.*.log" -ForegroundColor Green
