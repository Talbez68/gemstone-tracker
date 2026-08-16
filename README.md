# 💎 Gemstone Trader Tracker

A single-file, offline replacement for your dad's Excel workbook. No install, no
internet required, no server. Just **double-click `gemstone-tracker.html`** and it
opens in his browser (Chrome/Edge recommended on Windows).

It mirrors the original Excel exactly — Hebrew / right-to-left, the same columns
(מספר, סריה, משקל, מספר אבנים, צורה, עלות לקראט, סה"כ עלות, הערות, מכירה לקראט,
סה"כ מכירה, נמכר), a **tab per vendor**, and a **"סיכום כל הספקים"** tab that
combines everyone — like the old `Main` sheet.

## What it does
- **No formulas to break.** He types only the inputs; `סה"כ עלות` (= משקל × עלות
  לקראט) and `סה"כ מכירה` (= משקל × מכירה לקראט) calculate automatically.
- **Trips / business travels.** Each trip is its own saved workbook. Create a new
  trip, duplicate a past one, switch between them, and reopen old trips anytime.
- **Vendors.** Add / rename / delete vendors per trip (replaces copying Excel tabs).
- **Auto-save** to the browser, always on — nothing to remember.
- **Print / PDF** — the 🖨️ button gives a clean printout (or "Save as PDF").
- **Export to Excel** — ⬇️ writes a UTF-8 CSV (opens in Excel, Hebrew intact).
- **Backup / Restore** — 💾 saves a full backup file of everything; ↺ restores it.
- **Daily versions.** One snapshot per day, kept in the browser (14 days) *and* as
  a dated file in Drive under `backups/` (30 days). **↩️ שחזר גרסה קודמת** lists
  both, so a version saved on the laptop can be restored from the phone. A restore
  is pushed to Drive, so every device follows it — sync alone only ever holds
  "now", which is exactly why an accidental deletion needs this.

## Setup (one time)
1. Put `gemstone-tracker.html` somewhere easy — e.g. his Desktop.
2. Double-click it. Optionally right-click → "Pin to taskbar" / make a shortcut.
3. (Recommended) In the app, open **"איך משתמשים?"** once together.

## Helping him remotely
Two pieces, both free and serverless:

**1. Live support — operate/see his screen.**
Install **Chrome Remote Desktop** (https://remotedesktop.google.com) on his PC.
You can then view or control his screen to fix things or show him how.

**2. Sync his laptop and his Android phone — ☁️ Google Drive.**
In the app's menu, under **סנכרון בענן**, click **☁️ סנכרן עם Google Drive** and
sign in. Do that once per device with the **same Google account** and everything
syncs by itself, through a single `gemstones.json` in his own Drive.

- Works on desktop *and* Android.
- Everything lands in one Drive folder, **מעקב אבני חן**, kept tidy by the app:

  ```
  מעקב אבני חן/
    gemstones.json
    trips/
      <trip name>/
        certificates/     ← that trip's certificate photos
  ```

  **Photos sync across devices too**: one taken on the laptop is pulled from Drive
  the first time the phone shows that row, then cached locally for offline use.
  Renaming a trip re-files its photos under the new folder name, and photos left
  loose by earlier versions are moved into place on connect. Reads look files up
  by name rather than by path, so rearranging folders in Drive can't break sync.
- Uses the `drive.file` scope, so the app can only ever see what it created
  itself. Nothing else in his Drive is visible to it.
- Conflicts resolve last-write-wins, guarded by a timestamp: a device left open
  on a stale copy will pull the newer data instead of overwriting it.
- Only works when the app is opened from the **web link**, not from a copy
  downloaded to disk — OAuth can't authorize a `file://` page.

> An older desktop-only sync (🔗 חבר קובץ נתונים) was removed once Drive sync
> landed: it was built on the File System Access API, which no mobile browser
> implements, so it could never include his phone.

## Files
- `gemstone-tracker.html` — the entire app (open this).
- `original_template.xlsx` — his original Excel, kept locally for reference only
  (git-ignored; not committed).
