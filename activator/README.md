# MT-Billing Activator (vendor tool)

One tool for **license activation** and **account recovery (forgot password)**.

The panel generates a stable **Hardware ID** (also shown as **Panel ID** on the login
Forgot-password screen) from the machine running the server. You paste that ID into
this activator; it returns:

| Output | Customer uses it on |
|--------|---------------------|
| **License Key** | System → License → Activate |
| **Password Reset Code** (`RST-…`) | Login → Forgot password |

Keep this tool private — it embeds the signing secrets.

Algorithms match `server/src/panelId.ts` (`normalizeCode`, `expectedLicenseKey`,
`expectedPasswordResetCode`).

---

## Option A — Standalone `.exe`

```bash
cd activator
npm install
npm run build:win
```

Produces **`activator/dist/mt-billing-activator.exe`**.

```bat
mt-billing-activator.exe 1A2B-3C4D-5E6F-7890 --days 1y
mt-billing-activator.exe --license 1A2B-3C4D-5E6F-7890 --days 90d
mt-billing-activator.exe --reset 1A2B-3C4D-5E6F-7890
```

Durations: `30d`, `90d`, `180d`, `1y`, `2y`, `life` (default). The duration is appended to the license key (e.g. `…-1Y`). The panel stores expiry and locks menus again when it lapses.

Double-click for interactive mode (prompts for the ID **and expiration**, prints both codes).

## Option B — `activator.html` (offline in a browser)

1. Copy `activator.html` to the vendor PC.
2. Double-click → paste Hardware / Panel ID → choose **License expiration** → **Generate**.
3. Copy the license key and/or reset code.

---

## Workflows

### License activation

1. Customer opens **System → License** and copies **Hardware ID**.
2. Vendor runs the activator → **License Key**.
3. Customer pastes the key and clicks **Activate**.

### Account recovery (forgot password)

1. Customer opens **Forgot password?** on the login page and copies **Panel ID**
   (same value as Hardware ID on that machine).
2. Vendor runs the activator → **Password Reset Code**.
3. Customer pastes `RST-XXXX-XXXX-XXXX-XXXX` and resets to default credentials
   (`admin` / `admin123`, or `ADMIN_USER` / `ADMIN_PASS` from `server/.env`).

---

## CLI helpers (Node)

```bash
node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life]
node server/scripts/password-reset-activator.mjs <PANEL-ID>
node activator/activator.cjs <HARDWARE-OR-PANEL-ID> --days 1y
```
