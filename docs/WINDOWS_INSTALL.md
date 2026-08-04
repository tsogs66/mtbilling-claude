# Windows install (MT-Billing)

Run the full MT-Billing panel on a Windows PC or server without Linux or USB flash images.

## Installer package

| Artifact | URL |
|----------|-----|
| Zip installer | https://github.com/tsogs66/MT-Billing/releases/download/windows-latest/mt-billing-windows-x64.zip |
| Release page | https://github.com/tsogs66/MT-Billing/releases/tag/windows-latest |

Unpack, then run **`install.cmd`** as Administrator. Details: [`install/windows/README.md`](../install/windows/README.md).

## Architecture

```
Browser ──► Express :PORT ──► /api/*  (JSON API)
                 └──► /*     (Vite SPA from client/dist)
SQLite under MT_DATA_DIR (default ProgramData\MT-Billing)
Windows service: MTBillingAPI (WinSW)
```

On Linux appliances, nginx fronts the SPA and proxies `/api` to Node on port 4000.
On Windows, set **`SERVE_STATIC=1`** so Express serves the SPA itself (installer default, often on port **80**).

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (installer default `80`) |
| `SERVE_STATIC` | `1` = serve `client/dist` |
| `STATIC_ROOT` | Optional absolute path to SPA build |
| `MT_DATA_DIR` | SQLite + JWT secret + backups directory |
| `ADMIN_USER` / `ADMIN_PASS` | First-boot admin (change after login) |

## Related

- Hub/edge sync: [LOCAL_PC_SYNC.md](./LOCAL_PC_SYNC.md)
- Linux PC USB flash: [flash/README.md](../flash/README.md)
