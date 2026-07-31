# Troubleshooting: Metapi + Cloudflare Tunnel

## Diagnostic Script

Run the all-in-one diagnostic:

```powershell
.\scripts\cloudflare-tunnel\diagnose.ps1
```

This checks: metapi service, port 4000, `/v1/models`, cloudflared service,
tunnel connections, and public URL.

---

## 1. Metapi Service Issues

### 1.1 Service won't start

```powershell
# Check service status
Get-Service metapi | Format-List Name,Status,StartType

# Check Windows event log
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-10)} -MaxEvents 20 |
  Where-Object { $_.Message -match 'metapi' } |
  Format-List TimeCreated,Id,Message

# Check NSSM logs
Get-Content C:\Users\allen\Documents\GitHub\metapi\logs\metapi.out.log -Tail 50
Get-Content C:\Users\allen\Documents\GitHub\metapi\logs\metapi.err.log -Tail 50
```

### 1.2 Port 4000 not listening

```powershell
# Check if anything is on port 4000
Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue

# Check if node process is running
Get-Process node -ErrorAction SilentlyContinue

# Test connectivity
Test-NetConnection 127.0.0.1 -Port 4000
```

### 1.3 `better-sqlite3` native module error

If metapi crashes on startup with a `better-sqlite3` error:

```powershell
# Verify the module loads
node -e "require('better-sqlite3'); console.log('OK')"

# If it fails, rebuild
npm rebuild better-sqlite3

# If still failing, approve install scripts (npm 10+)
npm install-scripts approve better-sqlite3@12.10.0
npm rebuild better-sqlite3

# Then restart the service
Restart-Service metapi
```

### 1.4 `/v1/models` returns 401

```powershell
# Verify the token in .env
Select-String -Path .env -Pattern "PROXY_TOKEN"

# Test with the exact token
$token = (Select-String -Path .env -Pattern "PROXY_TOKEN=(.+)").Matches.Groups[1].Value
curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $token"
```

### 1.5 Run metapi manually to see errors

```powershell
# Stop the service first
Stop-Service metapi

# Run in foreground to see real-time output
node dist/server/index.js

# Press Ctrl+C when done, then restart the service
Start-Service metapi
```

---

## 2. NSSM Service Issues

### 2.1 View / change NSSM configuration

```powershell
$nssm = "C:\Users\allen\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win32\nssm.exe"

# View current config
& $nssm get metapi Application
& $nssm get metapi AppParameters
& $nssm get metapi AppDirectory
& $nssm get metapi AppEnvironmentExtra
& $nssm get metapi Start

# Reinstall from scratch (elevated)
& $nssm stop metapi
& $nssm remove metapi confirm
& $nssm install metapi "C:\Program Files\nodejs\node.exe" "C:\path\to\dist\server\index.js"
# ... (see install-metapi-service.ps1 for full config)
```

### 2.2 NSSM AppDirectory must be set

If metapi can't find `.env` or `data/`, ensure `AppDirectory` is the project
root:

```powershell
& $nssm set metapi AppDirectory "C:\Users\allen\Documents\GitHub\metapi"
```

---

## 3. Cloudflared Service Issues

### 3.1 `Cannot install event logger: registry key already exists`

This happens when reinstalling cloudflared service after a previous install.
Fix (run as Administrator):

```powershell
# Remove leftover registry key
Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\Cloudflared" -Force -ErrorAction SilentlyContinue

# Reinstall
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install <YOUR_TOKEN>
```

### 3.2 Service installed but immediately stops

Check the Windows event log:

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-10)} -MaxEvents 30 |
  Where-Object { $_.Message -match 'cloudflared|Cloudflared' } |
  Format-List TimeCreated,Id,LevelDisplayName,Message
```

Look for:
- **Event 7034** - "service terminated unexpectedly" (crash loop)
- **Event 7024** - "service-specific error" (check the error code)

### 3.3 Service shows "StopPending" (stuck)

```powershell
# Force kill the process
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
taskkill /F /IM cloudflared.exe

# Wait, then start fresh
Start-Sleep 5
Start-Service Cloudflared
```

### 3.4 Tunnel has no active connections

```powershell
# Check tunnel info
cloudflared tunnel info metapi-106-backup

# If "does not have any active connection":
# 1. Verify the service is running
Get-Service Cloudflared

# 2. Restart it
Restart-Service Cloudflared
Start-Sleep 10
cloudflared tunnel info metapi-106-backup
```

### 3.5 Run cloudflared manually to debug

```powershell
# Stop the service
Stop-Service Cloudflared

# Run in foreground (Ctrl+C to stop)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run

# Watch for connection errors, config issues, etc.
```

---

## 4. Cloudflare Edge / DNS Issues

### 4.1 HTTP 530 on public URL

This means the tunnel is connected but Cloudflare can't route to the origin.

**Cause:** No public hostname route configured in the dashboard.

**Fix:**
1. Go to **Zero Trust** -> **Networks** -> **Tunnels** -> your tunnel -> **Configure**
2. Go to **Public Hostname** tab
3. Add: subdomain + domain -> Service `HTTP` -> URL `localhost:4000`

### 4.2 HTTP 502 Bad Gateway

The tunnel is up and routing is configured, but metapi isn't responding.

```powershell
# Check if metapi is running
Get-Service metapi
Test-NetConnection 127.0.0.1 -Port 4000

# Check if metapi responds locally
curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer sk-<token>"
```

### 4.3 Old CNAME pointing to deleted tunnel

If you previously created a named tunnel and deleted it, the DNS CNAME may
remain and point to the old tunnel UUID.

**Fix:**
1. Go to **Cloudflare Dashboard** -> **your domain** -> **DNS** -> **Records**
2. Find the CNAME for your subdomain (e.g. `metapi-106-backup`)
3. If it points to an old tunnel UUID (`<old-uuid>.cfargotunnel.com`), delete it
4. The remotely-managed tunnel will create the correct CNAME automatically

### 4.4 Verify DNS resolution

```powershell
# Check A/AAAA records (should resolve to Cloudflare IPs)
Resolve-DnsName metapi-106-backup.weihaocao.com

# Check CNAME
Resolve-DnsName metapi-106-backup.weihaocao.com -Type CNAME

# External DNS check
nslookup metapi-106-backup.weihaocao.com 1.1.1.1
```

---

## 5. Full End-to-End Verification

```powershell
# 1. Metapi service running?
Get-Service metapi | Select-Object Name,Status,StartType

# 2. Port 4000 open?
(Test-NetConnection 127.0.0.1 -Port 4000).TcpTestSucceeded

# 3. Local /v1 works?
$token = "sk-<your-proxy-token>"
$r = Invoke-WebRequest "http://127.0.0.1:4000/v1/models" -Headers @{Authorization="Bearer $token"} -UseBasicParsing
"Local: HTTP $($r.StatusCode)"

# 4. Cloudflared service running?
Get-Service Cloudflared | Select-Object Name,Status,StartType

# 5. Tunnel has connections?
cloudflared tunnel info metapi-106-backup

# 6. Public URL works?
$r = Invoke-WebRequest "https://metapi-106-backup.weihaocao.com/v1/models" -Headers @{Authorization="Bearer $token"} -UseBasicParsing
"Public: HTTP $($r.StatusCode)"
```

Or just run:

```powershell
.\scripts\cloudflare-tunnel\diagnose.ps1
```
