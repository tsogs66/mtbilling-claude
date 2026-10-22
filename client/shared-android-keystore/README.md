# Shared debug keystore

All CI and recommended local **debug** APK builds use this keystore so updates install
on top of an existing app (same `applicationId` + signing certificate).

Passwords match the standard Android debug defaults (`android` / `androiddebugkey`).

If you previously installed an APK signed with a different key, uninstall once, then
install a build from this repo or GitHub Actions.
