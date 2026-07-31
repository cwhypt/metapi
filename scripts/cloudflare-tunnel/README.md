# Cloudflare Tunnel Deployment Scripts

Scripts for setting up and managing metapi with Cloudflare Tunnel on Windows.

## Scripts

| Script | Purpose |
|--------|---------|
| `generate-tokens.ps1` | Generate strong random tokens for `.env` |
| `install-metapi-service.ps1` | Install metapi as a Windows service (NSSM, auto-start) |
| `install-cloudflared-service.ps1` | Install cloudflared as a Windows service with tunnel token |
| `rebuild-and-restart.ps1` | Pull, rebuild, and restart metapi after code updates |
| `diagnose.ps1` | Run all health checks (services, ports, tunnel, public URL) |

## Quick Start

```powershell
# 1. Generate tokens
.\generate-tokens.ps1
# Copy output into .env in the project root

# 2. Install dependencies and build
cd ..\..
npm ci --no-audit --no-fund
npm run build:web
npm run build:server

# 3. Install metapi service (run as Admin)
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File scripts\cloudflare-tunnel\install-metapi-service.ps1"

# 4. Install cloudflared service (run as Admin, with your tunnel token)
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File scripts\cloudflare-tunnel\install-cloudflared-service.ps1 -Token eyJhIjoi..."

# 5. Add public hostname route in Cloudflare dashboard:
#    metapi-106-backup.weihaocao.com -> HTTP -> localhost:4000

# 6. Verify everything
.\diagnose.ps1
```

## Configuration

Edit `diagnose.ps1` to set your `$ProxyToken` and `$PublicUrl` before running.

## Documentation

- [Setup guide](../../docs/deployment/cloudflare-tunnel-setup.md)
- [Troubleshooting](../../docs/deployment/troubleshooting.md)
