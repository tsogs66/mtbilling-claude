# Android app (Capacitor)

MT-Billing ships a **Capacitor** wrapper around the React client so you can build
an Android APK that talks to your existing panel over HTTPS.

| | |
|--|--|
| App ID | `com.tsogs.mtbilling` |
| App name | **MT-Billing** |
| Native project | `client/android/` |

The phone app does **not** run the Node API — it is a remote client to your panel.

---

## What you need (build PC)

- Node.js **20+**
- **Android Studio** (Ladybug / recent) with Android SDK Platform **35**
- JDK **17** or **21**
- A device or emulator

---

## Build the APK (recommended)

From a clean clone of the repo:

```bash
# 1) Install dependencies (root installs server + client)
npm install

# 2) Build the web UI and sync into the Android project
npm run android:sync

# 3) Open Android Studio
npm run android:open
```

In Android Studio:

1. Wait for Gradle sync to finish.
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)** (debug),  
   or use a **release** variant after you create a signing keystore.
3. Install the APK on your phone.

**Debug APK path (typical):**

```text
client/android/app/build/outputs/apk/debug/app-debug.apk
```

### CLI alternative (no Studio UI)

Requires `ANDROID_HOME` / SDK + JDK:

```bash
npm install
npm run android:sync
cd client/android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Release:

```bash
cd client/android
./gradlew assembleRelease
```

(You must configure signing in `app/build.gradle` or via Android Studio for Play Store.)

---

## First launch on the phone

1. Install the APK.
2. Enter your **public panel URL** (same hostname as in a browser), e.g.
   `https://opione.tsogs.cloud` or `https://billing.yourdomain.com`.
3. The app checks `/api/health`, then shows the normal login screen.
4. Sign in (default seed: `admin` / `admin123`).

Change the server later from the login screen (**Change server URL**).

### Optional: bake the server URL into the build

Skips the connect screen:

```bash
cd client
VITE_API_BASE=https://billing.yourdomain.com npm run cap:sync
npm run cap:open
```

---

## After every UI change

Re-sync before rebuilding the APK:

```bash
npm run android:sync
# then rebuild in Android Studio or: cd client/android && ./gradlew assembleDebug
```

`client/android/app/src/main/assets/public` is **gitignored** — always regenerate with sync.

---

## Notes

- Prefer **HTTPS** on the panel (Let’s Encrypt / Cloudflare). Cleartext HTTP is allowed for LAN testing only.
- Terminal WebSockets use `wss://` against the same host.
- Play Store: create a keystore and use a signed **release** build.

## Mobile optimizations

| Area | Behavior |
|------|----------|
| **Layout** | Bottom tab bar + “More” sheet (full menu); `100dvh` shell, safe-area insets |
| **Tables** | Horizontal touch-scroll on `DataTable` views; first column (name/user) stays pinned on mobile |
| **Modals** | Bottom-sheet style on small screens |
| **Terminal** | Stacked controls + shorter xterm on narrow viewports |
| **Topology map** | Full-bleed map stage with mobile panel sizing |
| **PWA** | `manifest.webmanifest` for browser “Add to Home screen” |
| **Native shell** | Android back closes More menu → history → minimize; keyboard resizes body |
| **Receipts** | Payment receipts use Share → printer app (not system Print, which freezes WebView) |

Native behaviors: `client/src/lib/nativeShell.ts`.

## Project layout

| Path | Role |
|------|------|
| `client/capacitor.config.ts` | Capacitor app id / plugins |
| `client/android/` | Native Android Studio project |
| `client/src/config.ts` | API base URL (web vs native) |
| `client/src/pages/ServerSetup.tsx` | First-run panel URL screen |
