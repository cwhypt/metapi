# Metapi + Cloudflare Tunnel Deployment Guide

This guide documents the complete setup for running **metapi** as a Windows
service and exposing its `/v1` OpenAI-compatible endpoint through a Cloudflare
Tunnel (remotely-managed) so it can be consumed by other servers (e.g. an
Oracle Cloud VM).

---

## Architecture

```
Other server (Oracle VM)                     This machine (Windows)
┌─────────────────────┐         ┌──────────────────────────────────────┐
│  curl / OpenAI SDK  │────────▶│  Cloudflare Edge (HTTPS)             │
│  base_url:          │  HTTPS  │    │                                 │
│  /v1                │────────▶│    ▼                                 │
└─────────────────────┘         │  Cloudflared service (auto-start)    │
                                │    │  localhost:4000                  │
                                │    ▼                                 │
                                │  Metapi service (NSSM, auto-start)   │
                                │    /v1/*  (OpenAI-compatible proxy)  │
                                └──────────────────────────────────────┘
```

**Key components:**

| Component | Role | Auto-start |
|-----------|------|------------|
| **metapi** (NSSM service) | API gateway, listens on port 4000 | Yes |
| **Cloudflared** (Windows service) | Tunnel connector to Cloudflare edge | Yes |

---

## Auto-Start Logic (Critical)

Both services are registered as **Windows services with `Automatic` start type**,
meaning they start on boot without login. They use **two different mechanisms**
that must not be confused:

### Metapi — NSSM service (wrapper)

| Property | Value |
|----------|-------|
| **Service name** | `metapi` |
| **Binary** | `node.exe` (wrapped by NSSM) |
| **Arguments** | `dist\server\index.js` |
| **StartType** | `SERVICE_AUTO_START` (Automatic) |
| **Restart on crash** | NSSM `AppExit Default = Restart` (auto-restarts if process exits) |
| **Boot dependency** | None — starts as soon as the kernel loads services |
| **Config** | `.env` in the project root (AppDirectory set to project dir) |

NSSM monitors the Node process. If `node.exe` crashes, NSSM automatically
restarts it within ~1.5 seconds (throttle). This is the **only** auto-start
mechanism for metapi — there is no scheduled task or startup script.

```powershell
# Verify auto-start is configured
& nssm get metapi Start              # SERVICE_AUTO_START
& nssm get metapi AppExit Default    # Restart
```

### Cloudflared — Remotely-Managed Connector (token-based)

| Property | Value |
|-----------|-------|
| **Service name** | `Cloudflared` |
| **Binary** | `cloudflared.exe` (native Windows service) |
| **Mode** | **Remotely-managed connector** (NOT local named tunnel) |
| **Auth** | Connector **token** (embedded in service args, `eyJh...`) |
| **StartType** | `Automatic` |
| **Config** | **None local** — all ingress rules live in the Cloudflare dashboard |

> **IMPORTANT:** This setup uses the **new remotely-managed tunnel** approach,
> not the legacy local `config.yml` named tunnel. The difference:
>
> | | Legacy (old) | Remotely-managed (this setup) |
> |---|---|---|
> | **Config** | Local `~/.cloudflared/config.yml` | Cloudflare dashboard (cloud) |
> | **Auth** | `cert.pem` + credentials JSON | Connector token (`eyJh...`) |
> | **Ingress rules** | In `config.yml` | In dashboard → Public Hostname tab |
> | **Service install** | `cloudflared tunnel run` | `cloudflared service install <TOKEN>` |
> | **DNS** | Manual `cloudflared tunnel route dns` | Auto-created by dashboard |
> | **Restart on crash** | None (crash = down) | Windows Service Recovery (see below) |

The connector token tells cloudflared **which tunnel to join** and fetches all
ingress rules from the Cloudflare dashboard at runtime. There is **no local
config file** to maintain — if you change the route (e.g. add another hostname),
you do it in the dashboard and it takes effect immediately without restarting
the service.

### Boot order & dependency

```
Windows boots
  │
  ├── metapi service starts (NSSM, Automatic)     ← no dependencies
  │     └── node dist/server/index.js on :4000
  │
  └── Cloudflared service starts (Automatic)       ← no dependencies
        └── connects to Cloudflare edge
              └── fetches ingress rules from dashboard
                    └── routes traffic to localhost:4000
```

Both services start independently with no inter-dependency declared. In
practice, metapi (Node) starts faster than cloudflared (QUIC handshake to
edge), so by the time cloudflared receives its first request, metapi is
already listening on port 4000. If metapi is briefly down when a request
arrives, Cloudflare returns HTTP 502 and retries automatically.

### Enabling crash recovery for Cloudflared

The built-in `cloudflared service install` does **not** set Windows Service
Recovery actions by default. To make it auto-restart on crash, run this once
as Administrator:

```powershell
sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/30000
```

This means: on crash, restart after 5s, then 10s, then 30s, resetting the
counter every 24 hours. Metapi (via NSSM) already has this built in.

### Verifying both auto-start on reboot

```powershell
# Both should show StartType = Automatic
Get-Service metapi, Cloudflared | Format-Table Name,Status,StartType -AutoSize

# After a reboot, verify both come back:
Get-Service metapi, Cloudflared
# metapi      Running   Automatic
# Cloudflared Running   Automatic

# Quick end-to-end check:
.\scripts\cloudflare-tunnel\diagnose.ps1
```

---

## Prerequisites

- Windows machine with **Node.js 22+** and **npm**
- **cloudflared** installed: <https://github.com/cloudflare/cloudflared/releases>
- A **Cloudflare account** with a managed domain (e.g. `weihaocao.com`)
- Admin access on the Windows machine (for service installation)

---

## Part 1 — Build & Run Metapi

### 1.1 Install dependencies

```powershell
cd C:\Users\allen\Documents\GitHub\metapi
npm ci --no-audit --no-fund
```

> **Note:** npm 10+ blocks install scripts by default. Approve native modules:
> ```powershell
> npm install-scripts approve better-sqlite3@12.10.0
> npm install-scripts approve esbuild@0.25.12
> npm install-scripts approve esbuild@0.18.20
> npm install-scripts approve esbuild@0.21.5
> npm install-scripts approve esbuild@0.27.3
> npm install-scripts approve sharp@0.34.5
> npm rebuild better-sqlite3
> npm rebuild sharp
> ```

### 1.2 Create `.env`

Generate strong random tokens (see `scripts/cloudflare-tunnel/generate-tokens.ps1`):

```powershell
# Generate cryptographically strong tokens
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$AUTH_TOKEN = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''

$pbytes = New-Object byte[] 20
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pbytes)
$PROXY_TOKEN = 'sk-' + (($pbytes | ForEach-Object { $_.ToString("x2") }) -join '')

$abytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($abytes)
$ACCOUNT_CREDENTIAL_SECRET = ($abytes | ForEach-Object { $_.ToString("x2") }) -join ''
```

Write `.env` in the project root:

```env
ACCOUNT_CREDENTIAL_SECRET=<your-generated-secret>
AUTH_TOKEN=<your-generated-admin-token>
PROXY_TOKEN=sk-<your-generated-proxy-token>
CHECKIN_CRON=0 8 * * *
BALANCE_REFRESH_CRON=0 * * * *
PORT=4000
DATA_DIR=./data
TZ=Asia/Shanghai
```

**Token reference:**

| Token | Used for | Where |
|-------|----------|-------|
| `PROXY_TOKEN` | `/v1/*` API authentication (`Authorization: Bearer sk-...`) | Given to consumers |
| `AUTH_TOKEN` | Admin dashboard & `/api/*` endpoints | Keep private |
| `ACCOUNT_CREDENTIAL_SECRET` | Internal credential encryption | Keep private |

### 1.3 Build

```powershell
npm run build:web
npm run build:server
```

Verify the build output exists:

```powershell
Test-Path dist\server\index.js   # True
Test-Path dist\web\index.html    # True
```

### 1.4 Test-run before installing as a service

```powershell
node dist/server/index.js
```

In another terminal, verify:

```powershell
curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer sk-<your-proxy-token>"
# Should return: {"object":"list","data":[...]}
```

Press `Ctrl+C` to stop.

---

## Part 2 — Register Metapi as a Windows Service (NSSM)

### 2.1 Install NSSM

```powershell
winget install nssm --accept-package-agreements --accept-source-agreements
```

### 2.2 Install the service (run as Administrator)

Use the script `scripts/cloudflare-tunnel/install-metapi-service.ps1`:

```powershell
# Run in elevated PowerShell
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File scripts\cloudflare-tunnel\install-metapi-service.ps1"
```

Or manually:

```powershell
$nssm = "<path-to-nssm.exe>"
& $nssm install metapi "C:\Program Files\nodejs\node.exe" "C:\Users\allen\Documents\GitHub\metapi\dist\server\index.js"
& $nssm set metapi AppDirectory "C:\Users\allen\Documents\GitHub\metapi"
& $nssm set metapi AppEnvironmentExtra NODE_ENV=production
& $nssm set metapi Start SERVICE_AUTO_START
& $nssm set metapi AppStdout "C:\Users\allen\Documents\GitHub\metapi\logs\metapi.out.log"
& $nssm set metapi AppStderr "C:\Users\allen\Documents\GitHub\metapi\logs\metapi.err.log"
& $nssm set metapi AppRotateFiles 1
& $nssm set metapi AppRotateBytes 10485760
& $nssm start metapi
```

### 2.3 Verify

```powershell
Get-Service metapi | Format-List Name,Status,StartType
# Status: Running, StartType: Automatic

curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer sk-<your-proxy-token>"
```

---

## Part 3 — Cloudflare Tunnel (Remotely-Managed)

This uses the newer **remotely-managed tunnel** approach where ingress rules
are configured in the Cloudflare dashboard (not in a local `config.yml`).

### 3.1 Create a tunnel in the dashboard

1. Go to **Cloudflare Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**
2. Select **Cloudflared** tunnel type
3. Name it (e.g. `metapi-106-backup`)
4. Select **Windows / 64-bit**
5. Copy the **connector token** (starts with `eyJh...`)

### 3.2 Install the connector (run as Administrator)

cloudflared should already be installed. Open an **elevated Command Prompt**:

```cmd
"C:\Program Files (x86)\cloudflared\cloudflared.exe" service install eyJhIjoi...YOUR_FULL_TOKEN...
```

If you get `Cannot install event logger: ... registry key already exists`,
remove the leftover key and retry (see Troubleshooting below).

### 3.3 Verify the connector is online

```powershell
cloudflared tunnel info metapi-106-backup
# Should show CONNECTOR ID with active EDGE connections
```

Or check the service:

```powershell
Get-Service Cloudflared | Format-List Name,Status,StartType
# Status: Running, StartType: Automatic
```

### 3.4 Add a public hostname route

In the dashboard:

1. Go to the tunnel → **Configure** → **Public Hostname** tab
2. Click **Add a public hostname**:
   - **Subdomain**: `metapi-106-backup`
   - **Domain**: `weihaocao.com`
   - **Service Type**: `HTTP`
   - **URL**: `localhost:4000`
3. Click **Save**

Cloudflare automatically creates a CNAME record pointing the subdomain to the
tunnel.

### 3.5 Test end-to-end

```powershell
curl https://metapi-106-backup.weihaocao.com/v1/models `
  -H "Authorization: Bearer sk-<your-proxy-token>"
# Should return: {"object":"list","data":[...]}
```

---

## Part 4 — Consumer Setup (Other Server / Oracle VM)

No software installation needed on the consumer side. Just use curl or any
OpenAI-compatible client.

### 4.1 curl

```bash
# List models
curl https://metapi-106-backup.weihaocao.com/v1/models \
  -H "Authorization: Bearer sk-<your-proxy-token>"

# Chat completion
curl https://metapi-106-backup.weihaocao.com/v1/chat/completions \
  -H "Authorization: Bearer sk-<your-proxy-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

### 4.2 OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://metapi-106-backup.weihaocao.com/v1",
    api_key="sk-<your-proxy-token>",
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "ping"}],
)
print(response.choices[0].message.content)
```

### 4.3 Environment variables

```bash
export OPENAI_BASE_URL=https://metapi-106-backup.weihaocao.com/v1
export OPENAI_API_KEY=sk-<your-proxy-token>
```

---

## Part 5 — Service Management

### Metapi service

```powershell
# Status
Get-Service metapi

# Start / Stop / Restart
Start-Service metapi
Stop-Service metapi
Restart-Service metapi

# View logs
Get-Content C:\Users\allen\Documents\GitHub\metapi\logs\metapi.out.log -Tail 50
Get-Content C:\Users\allen\Documents\GitHub\metapi\logs\metapi.err.log -Tail 50

# Rebuild after code update
cd C:\Users\allen\Documents\GitHub\metapi
git pull
npm run build:web && npm run build:server
Restart-Service metapi
```

### Cloudflared service

```powershell
# Status
Get-Service Cloudflared

# Start / Stop / Restart
Start-Service Cloudflared
Stop-Service Cloudflared
Restart-Service Cloudflared

# Check tunnel connections
cloudflared tunnel info metapi-106-backup
```

---

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) for detailed diagnostics.

### Quick health check

```powershell
# Run the diagnostic script
.\scripts\cloudflare-tunnel\diagnose.ps1
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Port 4000 closed | metapi service not running | `Start-Service metapi` |
| HTTP 530 on public URL | Tunnel route not configured | Add public hostname in dashboard |
| HTTP 401 on `/v1` | Wrong PROXY_TOKEN | Check `.env` `PROXY_TOKEN` |
| `Cannot install event logger` | Leftover registry key | See troubleshooting.md |
| Service starts then stops | NSSM throttle too low / config issue | See troubleshooting.md |
| Tunnel no active connections | cloudflared service not running | `Start-Service Cloudflared` |
| `better-sqlite3` load error | Native module not built | `npm rebuild better-sqlite3` |
