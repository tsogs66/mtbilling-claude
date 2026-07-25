# MT-Billing Activator (vendor tool)

One tool for **license activation** and **account recovery (forgot password)**.

The panel generates a stable **Hardware ID** (also shown as **Panel ID** on the login
Forgot-password screen) from the machine running the server. You paste that ID into
this activator; it returns:

| Output | Customer uses it on |
|--------|---------------------|
| **License Key** | System → License → Activate |
| **Password Reset Code** (`RST-…`) | Login → Forgot password |

## How this stays secure

Codes are **Ed25519 signatures**, not shared-secret HMACs. That distinction matters
because MT-Billing is self-hosted: every customer has the full server source,
including `server/src/panelId.ts`. If codes were HMAC-signed with a secret baked
into that file (the old scheme), anyone who read their own server's source could
compute valid codes for any hardware ID — a full authentication bypass.

With Ed25519, `panelId.ts` only embeds the **public** key, which can verify a
signature but cannot produce one. The matching **private** key lives only in
`activator/keys/vendor-private-key.pem` — generated once, kept off the vendor's
machine's git history, and never distributed to customers.

**Keep `keys/vendor-private-key.pem` private.** It's already gitignored
(`activator/keys/`, `*.pem`). Back it up somewhere safe (password manager, offline
drive) — if you lose it you cannot issue new codes; if you rotate it, every
previously issued unredeemed code stops validating (already-activated licenses on
customer panels are unaffected, since activation state is stored locally on their
panel, not re-checked against the key).

---

## One-time setup

```bash
cd activator
npm install
node generate-keys.cjs
```

This writes the private key to `keys/vendor-private-key.pem` and prints a public
key value. Paste that value into `server/src/panelId.ts` as `LICENSE_PUBLIC_KEY_X`
and commit *that* file (the public key is safe to publish — it's what lets every
customer's panel verify codes without being able to forge them).

Do this once per vendor deployment. Re-running `generate-keys.cjs` refuses to
overwrite an existing key.

---

## Option A — Standalone `.exe`

```bash
cd activator
npm run build:win
```

Produces **`activator/dist/mt-billing-activator.exe`**. Copy `keys/` alongside the
exe (same folder) so it can find the private key — `pkg` bundles the script but not
your key file, and the key should never be embedded in a distributable binary anyway.

```bat
mt-billing-activator.exe 1A2B-3C4D-5E6F-7890 --days 1y
mt-billing-activator.exe --license 1A2B-3C4D-5E6F-7890 --days 90d
mt-billing-activator.exe --reset 1A2B-3C4D-5E6F-7890
mt-billing-activator.exe 1A2B-3C4D-5E6F-7890 --key D:\keys\vendor-private-key.pem
```

Durations: `30d`, `90d`, `180d`, `1y`, `2y`, `life` (default). The duration is appended to the license key (e.g. `…-1Y`). The panel stores expiry and locks menus again when it lapses.

Double-click for interactive mode (prompts for the ID **and expiration**, prints both codes).

Private key resolution order: `--key <path>` → `MT_BILLING_VENDOR_KEY` env var →
`keys/vendor-private-key.pem` next to the tool.

## Option B — `activator.html` (offline in a browser)

1. Copy `activator.html` to the vendor PC.
2. Open `keys/vendor-private-key.pem` in a text editor, copy its contents.
3. Double-click `activator.html` → paste the private key PEM → paste Hardware /
   Panel ID → choose **License expiration** → **Generate**.
4. Copy the license key and/or reset code.

The page makes no network requests; the pasted key is used only in browser memory
for that tab and is never saved. It needs a browser with native Ed25519 support in
the Web Crypto API (recent Chrome, Edge, or Firefox) — if signing fails, use the
CLI tool instead. Prefer the CLI for routine use so the key touches disk in one
place.

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
3. Customer pastes `RST-...` and resets to default credentials
   (`admin` / `admin123`, or `ADMIN_USER` / `ADMIN_PASS` from `server/.env`).

---

## CLI helpers (Node)

```bash
node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life] --key activator/keys/vendor-private-key.pem
node server/scripts/password-reset-activator.mjs <PANEL-ID> --key activator/keys/vendor-private-key.pem
node activator/activator.cjs <HARDWARE-OR-PANEL-ID> --days 1y
```

`MT_BILLING_VENDOR_KEY` can also be set to a path (or the raw PEM text) instead of
passing `--key` every time.
