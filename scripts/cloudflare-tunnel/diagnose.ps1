# Metapi + Cloudflare Tunnel Diagnostic Script
# Runs all health checks and prints a summary table.
#
# Usage:
#   .\diagnose.ps1
#
# Prereqs:
#   - Set $ProxyToken below to your PROXY_TOKEN value
#   - Set $PublicUrl to your tunnel hostname

$ProxyToken = "sk-b0310b1dff9f0e4933a4c16e09226e7456f233c7"
$PublicUrl   = "https://metapi-106-backup.weihaocao.com"
$LocalPort   = 4000

$results = @()

function Add-Result($Check, $Status, $Detail) {
    $results += [PSCustomObject]@{ Check=$Check; Status=$Status; Detail=$Detail }
    $color = if ($Status -eq "PASS") { "Green" } elseif ($Status -eq "FAIL") { "Red" } else { "Yellow" }
    Write-Host "  [$Status] $Check - $Detail" -ForegroundColor $color
}

Write-Host "`n=== Metapi + Cloudflare Tunnel Diagnostics ===`n" -ForegroundColor Cyan

# 1. Metapi service
Write-Host "[1/6] Checking metapi service..." -ForegroundColor Yellow
$svc = Get-Service metapi -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") {
        Add-Result "Metapi service" "PASS" "Status=$($svc.Status) StartType=$($svc.StartType)"
    } else {
        Add-Result "Metapi service" "FAIL" "Status=$($svc.Status) (expected Running)"
    }
} else {
    Add-Result "Metapi service" "FAIL" "Service not found"
}

# 2. Port 4000
Write-Host "[2/6] Checking local port $LocalPort..." -ForegroundColor Yellow
$port = (Test-NetConnection 127.0.0.1 -Port $LocalPort -WarningAction SilentlyContinue).TcpTestSucceeded
if ($port) {
    Add-Result "Port $LocalPort" "PASS" "Listening"
} else {
    Add-Result "Port $LocalPort" "FAIL" "Not listening"
}

# 3. Local /v1/models
Write-Host "[3/6] Checking local /v1/models..." -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$LocalPort/v1/models" -Headers @{Authorization="Bearer $ProxyToken"} -UseBasicParsing -TimeoutSec 5
    Add-Result "Local /v1/models" "PASS" "HTTP $($r.StatusCode)"
} catch {
    Add-Result "Local /v1/models" "FAIL" $_.Exception.Message
}

# 4. Cloudflared service
Write-Host "[4/6] Checking Cloudflared service..." -ForegroundColor Yellow
$cf = Get-Service Cloudflared -ErrorAction SilentlyContinue
if ($cf) {
    if ($cf.Status -eq "Running") {
        Add-Result "Cloudflared service" "PASS" "Status=$($cf.Status) StartType=$($cf.StartType)"
    } else {
        Add-Result "Cloudflared service" "FAIL" "Status=$($cf.Status) (expected Running)"
    }
} else {
    Add-Result "Cloudflared service" "FAIL" "Service not found"
}

# 5. Tunnel connections
Write-Host "[5/6] Checking tunnel connections..." -ForegroundColor Yellow
$tunnelInfo = cloudflared tunnel info metapi-106-backup 2>&1 | Out-String
if ($tunnelInfo -match "does not have any active connection") {
    Add-Result "Tunnel connections" "FAIL" "No active connections"
} elseif ($tunnelInfo -match "CONNECTOR ID") {
    $connCount = ([regex]::Matches($tunnelInfo, "\d+x\w+\d+")).Count
    Add-Result "Tunnel connections" "PASS" "$connCount edge connection(s)"
} else {
    Add-Result "Tunnel connections" "WARN" "Could not determine - check manually"
}

# 6. Public URL
Write-Host "[6/6] Checking public URL..." -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest "$PublicUrl/v1/models" -Headers @{Authorization="Bearer $ProxyToken"} -UseBasicParsing -TimeoutSec 15
    Add-Result "Public URL" "PASS" "HTTP $($r.StatusCode)"
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 530) {
        Add-Result "Public URL" "FAIL" "HTTP 530 - tunnel route not configured in dashboard"
    } elseif ($code -eq 401) {
        Add-Result "Public URL" "FAIL" "HTTP 401 - wrong PROXY_TOKEN"
    } elseif ($code -eq 502) {
        Add-Result "Public URL" "FAIL" "HTTP 502 - metapi not responding on port $LocalPort"
    } else {
        Add-Result "Public URL" "FAIL" "HTTP $code - $($_.Exception.Message)"
    }
}

# Summary
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$pass = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$fail = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
$warn = ($results | Where-Object { $_.Status -eq "WARN" }).Count
Write-Host "  PASS: $pass  FAIL: $fail  WARN: $warn`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
