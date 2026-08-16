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

- Works on desktop *and* Android — unlike the older file-based sync below.
- Uses the `drive.file` scope, so the app can only ever see the one file it
  created. Nothing else in his Drive is visible to it.
- Conflicts resolve last-write-wins, guarded by a timestamp: a device left open
  on a stale copy will pull the newer data instead of overwriting it.
- Only works when the app is opened from the **web link**, not from a copy
  downloaded to disk — OAuth can't authorize a `file://` page.
- Certificate photos are not synced through Drive yet; they stay on the device
  that uploaded them (and in the backup folder, if one is connected).

**3. The older desktop-only file sync.**
**🔗 חבר קובץ נתונים** picks a file inside his OneDrive/Google Drive *folder* and
auto-saves into it, letting his desktop cloud client sync it. If that folder is
shared with you, open the **same file** via **📂 פתח קובץ קיים**.

> This one needs Chrome or Edge **on desktop** — the File System Access API it
> relies on does not exist in any mobile browser, and the Drive Android app keeps
> no local folder for it to point at. Use the Google Drive sync above for phones.

## Files
- `gemstone-tracker.html` — the entire app (open this).
- `original_template.xlsx` — his original Excel, kept locally for reference only
  (git-ignored; not committed).
