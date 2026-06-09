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

**2. Access his data without hosting anything.**
In the app, click **🔗 חבר קובץ נתונים** and choose/create a file (e.g.
`gemstones.json`) **inside his OneDrive or Google Drive folder**. From then on the
app auto-saves into that file, and his existing cloud client syncs it. If that
folder is shared with you, you open the **same file** in your own copy of the app
(**📂 פתח קובץ קיים**), make changes, and they sync back to him.
The browser's local auto-save remains as a safety net regardless.

> File-sync needs Chrome or Edge on desktop. If unsupported, use 💾 Backup → send
> the file → ↺ Restore on the other side instead.

## Files
- `gemstone-tracker.html` — the entire app (open this).
- `original_template.xlsx` — his original Excel, kept locally for reference only
  (git-ignored; not committed).
