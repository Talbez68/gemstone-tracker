# 📱 Android app

The Android app is a **Trusted Web Activity (TWA)**: a small Android app whose
only job is to open the same web app the PC uses,
`https://talbez68.github.io/gemstone-tracker/gemstone-tracker.html`,
full-screen in Chrome, with its own icon on the home screen.

## Why this shape, and how the data is shared

- **Same data on PC and phone.** The app already keeps everything in
  `gemstones.json` in his Google Drive (☁️ סנכרן עם Google Drive). The Android
  app runs the very same page on the very same web address, so Drive sign-in and
  sync work exactly as they do on the PC: sign in once on the phone with the
  same Google account and both devices work on one file.
- **Why not a WebView / Capacitor app.** Google blocks its sign-in screen inside
  embedded WebViews, and a bundled copy would run on a different origin that the
  Drive OAuth client doesn't allow. Either would break sync. A TWA is real Chrome,
  so nothing in the web app has to change.
- **Always up to date.** Every push to GitHub Pages reaches the phone on the next
  launch; the APK only needs rebuilding if the wrapper itself changes.
- **Offline.** The service worker (`sw.js`) caches the app, so it opens with no
  signal and syncs when the connection comes back, same as in the browser.

## Installing it on the phone

1. Open **https://github.com/Talbez68/gemstone-tracker/releases/tag/android-latest**
   on the phone and tap `gemstone-tracker.apk`.
2. Allow Chrome to install apps when Android asks (one time).
3. Open **אבני חן**, then menu → **סנכרון בענן → ☁️ סנכרן עם Google Drive**,
   with the same Google account as the PC.

## One-time setup (for the maintainer)

**1. Signing secrets.** Add four repository secrets
(Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Every update must be signed with the same key, or Android refuses to install it
over the old one. Without the secrets CI still builds a debug APK (artifact on
the workflow run), but it isn't published as a release.

**2. Full-screen (no address bar).** Chrome hides its address bar only after it
verifies the app against the site, by reading
`https://talbez68.github.io/.well-known/assetlinks.json`. That file has to sit at
the root of the domain, which for GitHub Pages means a repository named
`Talbez68.github.io` containing `.well-known/assetlinks.json` (copy
[`assetlinks.json`](assetlinks.json) from here) and an empty `.nojekyll` file
(otherwise Pages skips the dot-folder). Until then the app works fully, just with
a thin Chrome bar at the top.

## Building locally

Needs JDK 17 and the Android SDK (Android Studio installs both).

```
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```
