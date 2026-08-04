# MT-Billing Windows installer

Installs the full panel on **Windows 10/11 or Windows Server** (x64) as a Windows service.
The API and web UI share one port (default **80**) — no nginx required (`SERVE_STATIC=1`).

## Quick install

1. Download [`mt-billing-windows-x64.zip`](https://github.com/tsogs66/MT-Billing/releases/download/windows-latest/mt-billing-windows-x64.zip)
2. Unzip anywhere
3. Right-click **`install.cmd`** → **Run as administrator**  
   (or: `powershell -ExecutionPolicy Bypass -File .\install.ps1`)

First sign-in: `admin` / `admin123` — change the password immediately.

Panel URL: `http://127.0.0.1/` (or `http://<pc-ip>/`)

## What it does

| Step | Detail |
|------|--------|
| Node.js | Uses existing Node 20+, or installs via winget, or downloads portable Node into `InstallDir\runtime` |
| App | Downloads MT-Billing source, `npm install`, builds client + server |
| Data | SQLite under `C:\ProgramData\MT-Billing` (`MT_DATA_DIR`) — survives app upgrades |
| Service | [WinSW](https://github.com/winsw/winsw) service **MTBillingAPI** (auto-start) |
| Firewall | Inbound TCP rule for the chosen port |

## Options

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -InstallDir 'D:\MT-Billing' `
  -DataDir 'D:\MT-Billing-Data' `
  -Port 4000 `
  -UseGit
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `-InstallDir` | `C:\Program Files\MT-Billing` | App files |
| `-DataDir` | `C:\ProgramData\MT-Billing` | Database + logs |
| `-Port` | `80` | UI + API listen port |
| `-UseGit` | off | `git clone` instead of zip download |
| `-SkipService` | off | Build only (use `start-console.bat`) |

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
# also delete SQLite:
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData
```

## Local PC Sync (edge)

After install, open **System Settings → Local PC Sync**, set role **Edge**, paste the hub sync token, and save.

## Requirements

- Windows 10/11 or Server 2019+ (x64)
- Administrator rights for install
- Internet access during install (Node packages + source download)
- ~2 GB RAM, ~2 GB free disk for build

## Build the release zip (maintainers)

On Linux/macOS from the repo root:

```bash
bash scripts/build-windows-zip.sh
# → dist/windows/mt-billing-windows-x64.zip
```

CI publishes that zip to the rolling [`windows-latest`](https://github.com/tsogs66/MT-Billing/releases/tag/windows-latest) release on pushes that touch `install/windows/**`.
