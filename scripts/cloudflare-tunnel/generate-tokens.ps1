# Generate cryptographically strong tokens for metapi .env
#
# Usage:
#   .\generate-tokens.ps1
#
# Output: prints the values to copy into .env

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$AUTH_TOKEN = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''

$pbytes = New-Object byte[] 20
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pbytes)
$PROXY_TOKEN = 'sk-' + (($pbytes | ForEach-Object { $_.ToString("x2") }) -join '')

$abytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($abytes)
$ACCOUNT_CREDENTIAL_SECRET = ($abytes | ForEach-Object { $_.ToString("x2") }) -join ''

Write-Host "=== Generated tokens (copy to .env) ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "ACCOUNT_CREDENTIAL_SECRET=$ACCOUNT_CREDENTIAL_SECRET"
Write-Host "AUTH_TOKEN=$AUTH_TOKEN"
Write-Host "PROXY_TOKEN=$PROXY_TOKEN"
Write-Host ""
Write-Host "=== .env template ===" -ForegroundColor Cyan
Write-Host @"
ACCOUNT_CREDENTIAL_SECRET=$ACCOUNT_CREDENTIAL_SECRET
AUTH_TOKEN=$AUTH_TOKEN
PROXY_TOKEN=$PROXY_TOKEN
CHECKIN_CRON=0 8 * * *
BALANCE_REFRESH_CRON=0 * * * *
PORT=4000
DATA_DIR=./data
TZ=Asia/Shanghai
"@
