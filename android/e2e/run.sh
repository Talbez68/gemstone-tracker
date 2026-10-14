#!/usr/bin/env bash
# Runs on a GitHub runner with an Android emulator attached (see
# .github/workflows/android.yml): installs the real APK, opens it, and drives the
# app inside it through Chrome's DevTools socket. Screenshots go to $OUT.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=android/e2e/out; mkdir -p "$OUT"
APP=com.talbez68.gemstonetracker/com.google.androidbrowserhelper.trusted.LauncherActivity
shot(){ adb exec-out screencap -p > "$OUT/$1.png" || true; }
ui(){ adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml 2>/dev/null; }
top(){ adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'; }

adb wait-for-device
echo "--- browsers on the emulator"; adb shell pm list packages | grep -iE 'chrome|webview|browser'
adb shell dumpsys package com.android.chrome | grep -m1 versionName

# Chrome reads its flags from here on a debuggable image: skip its first-run screens
adb shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
adb shell am set-debug-app --persistent com.android.chrome
adb shell am force-stop com.android.chrome

adb install -r android/gemstone-tracker.apk || exit 1

# 1. the app as installed: opens the live web app in Chrome, not a WebView
adb shell am start -W -n "$APP"
sleep 20
echo "--- top activity after launch"; top | tee "$OUT/launch-activity.txt"
# the live site comes over the network; give it up to a minute to draw
for i in $(seq 12); do
  ui > "$OUT/01-launch-live.xml"
  grep -q 'מעקב אבני חן' "$OUT/01-launch-live.xml" && break
  sleep 5
done
shot 01-launch-live

# 2. the same app, pointed at this branch's copy of the web app, so the tests
#    exercise the code in this PR. localhost keeps it a secure origin (Drive needs that).
python3 -m http.server 8080 >/dev/null 2>&1 &
adb reverse tcp:8080 tcp:8080
adb shell am force-stop com.android.chrome
adb shell am start -W -n "$APP" -d "http://localhost:8080/gemstone-tracker.html"
sleep 15
shot 02-launch-branch
adb forward tcp:9222 localabstract:chrome_devtools_remote
curl -s http://127.0.0.1:9222/json/version; echo
curl -s http://127.0.0.1:9222/json/list; echo

npx playwright test -c android/e2e
status=$?
shot 99-end
exit $status
