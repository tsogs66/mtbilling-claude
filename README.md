# MT-Billing

A self-hosted **MikroTik billing and PPPoE/IPoE management panel** (branding: *Pa-North*),
designed to run on **Ubuntu** (e.g. an Ubuntu VM/LXC on Proxmox).

It gives WISP / fiber ISP operators a single dashboard to manage RouterOS devices,
PPPoE & IPoE subscribers, billing plans, a fiber clients map (OLT → NAP → client
topology), sales reporting, hotspot vouchers, inventory and more.

## Features

- **Dashboard** – live host stats (CPU/RAM/disk of the Ubuntu host, via
  `systeminformation`), per-router status (active / offline / expired PPPoE),
  sales overview chart and queue-tree ranking.
- **PPPoE & IPoE Management** – users, offline users, active connections,
  profiles, servers and billing plans, with create/edit/delete.
- **Clients Map** – Leaflet map plotting OLT, NAP boxes and subscribers with
  **animated** server → OLT → NAP → ONU topology links and per-ONU online/offline
  status (pulsing markers, live counts, auto-refresh).
- **Billing / Payments** – executing a payment extends the subscription by whole
  month(s) anchored on the **original expiration date** (the billing day-of-month
  is preserved and never re-anchored to the payment day).
- **Uptime Monitor** – live reachability + latency monitoring of the most popular
  services, sites and games (Google, YouTube, Facebook, Steam, Roblox, Riot,
  Cloudflare/Google DNS, etc.) grouped by category with sparklines and uptime %.
- **Sales Report** – revenue chart (7d / 30d / 6m / 1y) and recent transactions.
- **Stock & Inventory**, **Hotspot vouchers**, **Company profile**, **System Logs**,
  plus placeholders for AI Scripting, Terminal, Network, Mikrotik Files, ZeroTier,
  Panel Roles, Updater, Super Router and License.
- **MikroTik RouterOS API integration** (`node-routeros`) with graceful fallback
  to a seeded local database, so the panel is fully usable during development
  without live hardware.

## Tech stack

| Layer    | Technology |
|----------|------------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, React Router, Recharts, Leaflet, Capacitor (Android) |
| Backend  | Node.js, Express, TypeScript (run via `tsx`), better-sqlite3, JWT auth |
| Database | SQLite (auto-created and seeded on first run at `server/data/mt-billing.db`) |

## Requirements

See **[SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md)** for full hardware and software minimums.

| Deployment | Minimum |
|------------|---------|
| **App (any host)** | 2 CPU · 2 GB RAM · 16 GB disk · Node.js 20+ · Ubuntu 22.04/24.04 or Debian 12 |
| **Proxmox LXC** | Proxmox VE 7.4+ · **2 vCPU · 4 GB RAM · 32 GB disk** (script defaults) |
| **Raspberry Pi** | Pi 3/4/5 64-bit · 16 GB+ microSD · flash `mt-billing-rpi-arm64.img.xz` |
| **Orange Pi 5** | OPi 5 · 16 GB+ storage · flash `mt-billing-opi-arm64.img.xz` |
| **Orange Pi One** | OPi One (H3) · 16 GB+ microSD · flash `mt-billing-opi-one-armhf.img.xz` |
| **PC (amd64) appliance** | UEFI x86_64 · 16 GB+ USB/SSD · flash `mt-billing-pc-amd64.img.xz` (run from media) |
| **PC USB installer** | UEFI x86_64 · flash `mt-billing-pc-usb-amd64.img.xz` to USB → installs onto internal disk |

## Getting started (development)

```bash
# From the repository root – installs root, server and client deps
npm install

# Start the API (http://localhost:4000) and the web UI (http://localhost:5173) together
npm run dev
```

Then open <http://localhost:5173> and sign in with the default credentials:

```
username: admin
password: admin123
```

The SQLite database is created and seeded automatically on first run.

### Android app (Capacitor)

Wraps the same React UI in a native Android shell. Full steps: **[client/ANDROID.md](./client/ANDROID.md)**.

```bash
npm install
npm run android:sync   # build web UI → sync into client/android
npm run android:open   # Android Studio → Build → Build APK(s)
# Debug APK: client/android/app/build/outputs/apk/debug/app-debug.apk
```

On first launch, enter your public panel URL (e.g. `https://billing.example.com`), then sign in as usual.

### Configuration

Server settings are read from `server/.env` (see `server/.env.example`):

| Variable     | Default                  | Purpose |
|--------------|--------------------------|---------|
| `PORT`       | `4000`                   | API port |
| `JWT_SECRET` | `change-me-in-production`| JWT signing secret |
| `ADMIN_USER` | `admin`                  | Default admin username (first run only) |
| `ADMIN_PASS` | `admin123`               | Default admin password (first run only) |

To connect a real router, add its host / API credentials in the `routers` table
(the API layer will use live RouterOS data when reachable and fall back to seeded
data otherwise).

## Useful scripts

| Command             | Description |
|---------------------|-------------|
| `npm run dev`       | Run server + client together (development) |
| `npm run build`     | Type-check and build the frontend for production |
| `npm run lint`      | Lint the frontend |
| `npm --prefix server run build` | Compile the backend to `server/dist` |
| `npm --prefix server run start` | Run the compiled backend |
| `npm run android:sync` | Build web UI and sync into the Capacitor Android project |
| `npm run android:open` | Open `client/android` in Android Studio |
| `scripts/proxmox-install.sh` | Proxmox host helper → `ct/mt-billing.sh` |
| `scripts/proxmox-update.sh` | Proxmox host helper → pull/build/restart inside LXC |
| `scripts/proxmox-reinstall.sh` | Proxmox host helper → clean reinstall to Git defaults |
| `scripts/fetch-update-from-github.sh` | Copy updater files from GitHub raw into `install/` |
| `install/mt-billing-update.sh` | Guest update script (git pull + build + restart) |
| `install/mt-billing-fix-now.sh` | One-shot: grant updater sudo + full update (Updater workaround) |
| `install/mt-billing-self-update.sh` | Unprivileged pull/build for the panel service user |
| `install/mt-billing-grant-updater-root.sh` | Allow panel UI to start root update / restart API |
| `install/mt-billing-reinstall.sh` | Guest reinstall script (wipe + reclone + optional DB reset) |
| `scripts/build-rpi-img.sh` | Build Raspberry Pi `.img` (+ `.img.xz`) for Etcher/Rufus |
| `scripts/build-opi-img.sh` | Build Orange Pi **5** `.img` (+ `.img.xz`) for Etcher/Rufus |
| `scripts/build-opi-one-img.sh` | Build Orange Pi **One** `.img` (+ `.img.xz`) for Etcher/Rufus |
| `scripts/build-pc-img.sh` | Build PC amd64 appliance `.img` (+ `.img.xz`) for Etcher/Rufus |
| `scripts/build-pc-usb-img.sh` | Build PC USB installer `.img` (+ `.img.xz`) → internal disk |
| `scripts/build-all-flash-images.sh` | Build RPi + OPi 5 + OPi One + PC + PC-USB flash images |
| `scripts/build-sbc-flash-image.sh` | Shared builder (`--board rpi\|opi\|opi-one\|pc\|pc-usb\|all`) |
| `scripts/sync-proxmox-embed.sh` | Sync `install/` into embedded Proxmox guest script |

## Deploying on Ubuntu (Proxmox)

### One-liner (public repo only)

GitHub raw URLs return **404 on private repositories**. Make the repo public first, or use the **local install** below.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh)"
```

Unattended:

```bash
mode=default bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh)"
```

### Local install (private repo — use this if curl returns 404)

On the **Proxmox host** as root:

```bash
git clone https://github.com/tsogs66/MT-Billing.git
cd MT-Billing
mode=default bash ct/mt-billing.sh
```

The guest install script is **embedded** inside `ct/mt-billing.sh`, so no second download is needed during container setup.

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `var_repo_branch` | `main` | Git branch to deploy |
| `var_admin_user` | `admin` | First-run admin username |
| `var_admin_pass` | `admin123` | First-run admin password |
| `var_jwt_secret` | *(random)* | JWT signing secret |
| `var_auto_update` | `1` | Enable systemd timer to pull `main` every 10 minutes |

Uses [community-scripts](https://github.com/community-scripts/ProxmoxVE) `build.func` for storage/network prompts and container creation. Guest install script: `install/mt-billing-install.sh`.

### Updating after new commits (Proxmox)

**Automatic (default on new installs):** a systemd timer inside the LXC polls GitHub every 10 minutes and applies fast-forward updates when `main` moves.

```bash
# Inside the LXC
systemctl status mt-billing-auto-update.timer
journalctl -u mt-billing-auto-update.service -n 50
```

**Copy update scripts only** (no full app pull yet):

```bash
# One-liner inside the LXC
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/scripts/fetch-update-from-github.sh | sudo bash

# Proxmox host → copy into container, then run update
sudo bash scripts/fetch-update-from-github.sh --run

# Copy + enable 10-minute auto-update timer
sudo bash scripts/fetch-update-from-github.sh --enable-timer
```

**Manual — from Proxmox host:**

```bash
sudo bash scripts/proxmox-update.sh
# or: CTID=101 sudo bash scripts/proxmox-update.sh
```

**Manual — inside the LXC/VM:**

```bash
sudo bash /opt/mt-billing/install/mt-billing-update.sh
```

**If the panel Updater button fails** (needs root once — grants privilege and updates):

```bash
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-now.sh | sudo bash
```

Or grant UI updates only, then use **Update from GitHub** again:

```bash
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-grant-updater-root.sh | sudo bash
```

### Public pay links (LAN IP)

For collectors on the same LAN/VPN as the LXC (no Cloudflare / DynDNS):

```bash
sudo bash /opt/mt-billing/install/mt-billing-public-host.sh --local-ip
```

Or in the panel: **Payment Links → Use LAN IP**. Links become
`http://<lxc-ip>/pay/...`.

### Public pay links (Cloudflare Tunnel)

Best option when the panel is behind NAT / CGNAT and you cannot port-forward.
Uses your Cloudflare account — no open ports on the router.

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels**,
   create a Cloudflared tunnel and copy the **install token**.
2. Add a **Public Hostname** (e.g. `pay.yourisp.com`) with service
   `http://127.0.0.1:80` (nginx) or your panel port.
3. On the LXC:

```bash
# One-shot from the shell
sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh \
  --token 'eyJh...' --hostname pay.yourisp.com

# Or from the panel: System Settings → Cloudflare Tunnel
# (first enable panel root helpers if needed)
sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh
```

Pay links become `https://pay.yourisp.com/pay/...`. Confirm under **Payment Links**.

### Public pay links (DynDNS)

Point a DynDNS (DuckDNS, No-IP, Dynu, etc.) hostname at your public IP, forward
ports **80** (and **443** for HTTPS) to the MT-Billing LXC, then inside the guest:

```bash
# HTTP (quick)
sudo bash /opt/mt-billing/install/mt-billing-public-host.sh yourname.duckdns.org

# HTTPS + pay-only public site (recommended)
sudo bash /opt/mt-billing/install/mt-billing-public-host.sh yourname.duckdns.org --https --pay-only
```

This configures nginx for that hostname and sets the panel **Public pay portal URL**
so copied links look like `https://yourname.duckdns.org/pay/...`.

Check only (exit 0 if an update is available):

```bash
bash /opt/mt-billing/install/mt-billing-update.sh --check
```

Disable auto-update on install: `var_auto_update=0 bash ct/mt-billing.sh`

### Reinstall to defaults (big Git update)

Use this when a normal pull is not enough (major schema/UI rewrite, broken tree, or you want a factory-fresh panel). Backs up `server/data` + `.env` under `/var/backups/mt-billing/`, reclones `main`, rebuilds, and by default **resets the SQLite DB** to seeded defaults.

**From the Proxmox host:**

```bash
sudo bash scripts/proxmox-reinstall.sh --yes
# or: CTID=101 sudo bash scripts/proxmox-reinstall.sh --yes --reset-db
# keep existing clients/routers DB:
CTID=101 sudo bash scripts/proxmox-reinstall.sh --yes --keep-db
```

**Inside the LXC:**

```bash
sudo bash /opt/mt-billing/install/mt-billing-reinstall.sh --yes
# keep database:
sudo bash /opt/mt-billing/install/mt-billing-reinstall.sh --yes --keep-db
# regenerate admin password / JWT:
sudo bash /opt/mt-billing/install/mt-billing-reinstall.sh --yes --fresh-env
```

One-liner from GitHub (inside LXC):

```bash
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-reinstall.sh | sudo bash -s -- --yes
```

**Enable on an existing LXC** (after pulling this repo change):

```bash
# Inside the LXC
cd /opt/mt-billing && git pull
sudo chmod +x install/mt-billing-update.sh
sudo cp install/mt-billing-auto-update.timer /etc/systemd/system/
sudo sed "s|var_repo_branch=main|var_repo_branch=main|g" install/mt-billing-auto-update.service | sudo tee /etc/systemd/system/mt-billing-auto-update.service
sudo systemctl daemon-reload
sudo systemctl enable --now mt-billing-auto-update.timer
```

### Manual install (inside an existing VM/LXC)

```bash
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-install.sh | bash
```

Or step by step:

1. Create an Ubuntu 22.04/24.04 VM or LXC on Proxmox.
2. Install Node.js 20+ and `git`.
3. Clone the repo, run `npm install`, then `npm run build` and
   `npm --prefix server run build`.
4. Serve `client/dist` with nginx and run the compiled API (`npm --prefix server run start`) via
   `systemd`. Point the reverse proxy at the API on `PORT`.

## Deploying on Raspberry Pi / Orange Pi / PC (flash image)

Build one disk image **per platform**, then flash with **Balena Etcher** or **Rufus** (DD Image mode):

```bash
sudo bash scripts/build-rpi-img.sh              # → dist/flash/mt-billing-rpi-arm64.img
sudo bash scripts/build-opi-img.sh              # → Orange Pi 5
sudo bash scripts/build-opi-one-img.sh          # → Orange Pi One
sudo bash scripts/build-pc-img.sh               # → appliance (run from USB/SSD)
sudo bash scripts/build-pc-usb-img.sh           # → USB installer → internal disk
sudo bash scripts/build-all-flash-images.sh
```

Details: [flash/README.md](./flash/README.md) · [SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md).
