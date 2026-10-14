import { test, expect, chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { STORAGE_KEY, PNG_B64, stubDrive } from '../../tests/helpers.js';

// These run against the real APK on an Android emulator (run.sh has installed and
// opened it). The app is driven through Chrome's DevTools socket, so every step
// happens inside the Android app itself, in Android's own Chrome.
const APP = 'com.talbez68.gemstonetracker/com.google.androidbrowserhelper.trusted.LauncherActivity';
const BRANCH_URL = 'http://localhost:8080/gemstone-tracker.html';
const OUT = 'android/e2e/out';
const adb = (cmd) => execSync(`adb ${cmd}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
const shot = (name) => { try { fs.writeFileSync(`${OUT}/${name}.png`, execSync('adb exec-out screencap -p')); } catch {} };
const topActivity = () => adb('shell dumpsys activity activities').split('\n')
  .find((l) => /topResumedActivity|mResumedActivity/.test(l)) || '';
// uiautomator can't dump while something animates (e.g. a download snackbar)
const screenText = () => { try { adb('shell uiautomator dump /sdcard/ui.xml'); return adb('shell cat /sdcard/ui.xml'); } catch { return ''; } };
const downloads = () => adb('shell ls /sdcard/Download/ 2>/dev/null || true');

let browser;
async function connect() {
  if (browser) await browser.close().catch(() => {});
  browser = undefined;
  if (!/CustomTabActivity|accounts\.google|printspooler/.test(topActivity())) await launch();
  adb('forward tcp:9222 localabstract:chrome_devtools_remote');
  for (let i = 0; i < 30; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) {
    console.log('no devtools. top:', topActivity(), 'chrome pid:', adb('shell pidof com.android.chrome || true').trim());
    console.log('screen:', (screenText().match(/text="[^"]+"/g) || []).join(' '));
    console.log('sockets:', adb("shell cat /proc/net/unix | grep devtools || true"));
    throw new Error('could not reach Chrome on the device');
  }
  // Playwright redirects downloads to a folder on the CI machine, which doesn't
  // exist on the phone; give downloads back to Chrome, as on a real phone
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch((e) => console.log('download behavior:', e.message));
  for (let i = 0; i < 30; i++) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(BRANCH_URL));
    if (page) { page.setDefaultTimeout(30_000); return page; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('no app page. top:', topActivity());
  console.log('targets:', execSync('curl -s http://127.0.0.1:9222/json/list', { encoding: 'utf8' }));
  console.log('screen:', (screenText().match(/text="[^"]+"/g) || []).join(' '));
  shot('no-page-' + Date.now());
  throw new Error('the app page never showed up');
}
const launch = async () => {
  for (let i = 0; i < 3; i++) {
    console.log(adb(`shell am start -W -n ${APP} -d ${BRANCH_URL}`));
    await new Promise((r) => setTimeout(r, 8000));
    const top = topActivity();
    console.log('top after launch:', top);
    if (/CustomTabActivity/.test(top)) return;
  }
};
// close the Android app completely and open it again from the launcher
async function restartApp() {
  // he leaves the app (Home) so Chrome saves the page, then Android ends it
  adb('shell input keyevent KEYCODE_HOME');
  await new Promise((r) => setTimeout(r, 4000));
  // stop both the app's own task and Chrome, so the relaunch starts from scratch
  // instead of bringing back a task whose Chrome is half dead
  adb('shell am force-stop com.talbez68.gemstonetracker');
  adb('shell am force-stop com.android.chrome');
  await new Promise((r) => setTimeout(r, 2000));
  await launch();
  return connect();
}
const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
const backToApp = async () => {
  for (let i = 0; i < 4 && !/CustomTabActivity|gemstonetracker/.test(topActivity()); i++) {
    adb('shell input keyevent KEYCODE_BACK'); await new Promise((r) => setTimeout(r, 1500));
  }
};

test.afterAll(async () => { if (browser) await browser.close().catch(() => {}); });

test('the installed app opens the live web app in Chrome, not in a WebView', async () => {
  const launched = fs.readFileSync(`${OUT}/launch-activity.txt`, 'utf8');
  // a Trusted Web Activity runs in Chrome's own custom-tab activity
  expect(launched).toContain('com.android.chrome');
  expect(launched).toMatch(/CustomTabActivity/);
  const xml = fs.readFileSync(`${OUT}/01-launch-live.xml`, 'utf8');
  expect(xml, 'the live app rendered on screen').toContain('מעקב אבני חן');
});

test('it loads with no errors, and an edit survives closing the app', async () => {
  let page = await connect();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
  await page.reload();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(errors).toEqual([]);

  const replies = ['ספק באנדרואיד', 'AN'];
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(replies.shift()) : d.accept()));
  await page.locator('.tab-add').click();
  await expect(page.locator('.tab.active')).toHaveText('ספק באנדרואיד');
  const nums = page.locator('tbody tr').first().locator('input.num');
  await nums.nth(0).fill('3.25');
  await nums.nth(2).fill('120');
  await expect(page.locator('tbody tr').first().locator('td.auto[data-auto="totCost"]')).toContainText('390');
  await expect.poll(async () => (await stored(page)).trips[0].vendors.at(-1).rows[0].weight).toBe('3.25');
  shot('03-edited');

  page = await restartApp();
  await expect(page.locator('.tab.active')).toHaveText('ספק באנדרואיד');
  await expect(page.locator('tbody tr').first().locator('input.num').nth(0)).toHaveValue('3.25');
  shot('04-after-restart');
});

test('a certificate photo is added from the phone and kept', async () => {
  let page = await connect();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('tbody tr').first().locator('button.cert-add').click();
  await (await chooser).setFiles({ name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
  await expect(page.locator('tbody tr').first().locator('img.cert-thumb')).toBeVisible();
  page = await restartApp();
  await expect.poll(() => page.locator('img.cert-thumb').first().evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  shot('05-photo');
});

test('backup saves a file into the phone\'s Downloads', async () => {
  const page = await connect();
  const before = adb('shell ls /sdcard/Download/ 2>/dev/null || true');
  // a real tap on the menu button, as Chrome only allows a download from a user action
  await page.evaluate(() => document.body.classList.add('menu-open'));
  await page.getByRole('button', { name: '💾 גיבוי הכל' }).click();
  for (let i = 0; i < 15 && !/gemstones_backup_/.test(downloads()); i++) await new Promise((r) => setTimeout(r, 1000));
  shot('06-backup');
  // Chrome may ask to confirm a download; accept it if it does
  if (/Download|הורד/.test(screenText()) && !/gemstones_backup_/.test(adb('shell ls /sdcard/Download/ || true'))) {
    const m = screenText().match(/text="(Download|הורדה|הורד)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) adb(`shell input tap ${(+m[2] + +m[4]) >> 1} ${(+m[3] + +m[5]) >> 1}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const after = adb('shell ls /sdcard/Download/ || true');
  if (!/gemstones_backup_/.test(after)) {
    console.log('logcat downloads:', adb('logcat -d -t 3000').split('\n').filter((l) => /download/i.test(l)).slice(-25).join('\n'));
    // which kind of download does Chrome here manage at all?
    for (const [kind, js] of [
      ['plain-url', "Object.assign(document.createElement('a'),{href:'manifest.json',download:'probe_url.json'})"],
      ['data-url', "Object.assign(document.createElement('a'),{href:'data:application/json,%7B%7D',download:'probe_data.json'})"],
      ['blob', "Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob(['{}'],{type:'application/json'})),download:'probe_blob.json'})"],
    ]) {
      await page.evaluate((code) => { window.__probe = eval(code); document.body.appendChild(window.__probe); }, js);
      await page.evaluate(() => window.__probe.click());
      await new Promise((r) => setTimeout(r, 4000));
      console.log('probe', kind, '->', adb('shell ls /sdcard/Download/ || true').trim() || '(nothing)',
        '| screen:', (screenText().match(/text="[^"]*download[^"]*"/gi) || []).join(' '));
    }
  }
  expect(after, `Downloads before: ${before}`).toMatch(/gemstones_backup_\d{4}-\d{2}-\d{2}.*\.json/);
  await backToApp();
});

test('printing opens Android\'s print screen (Save as PDF)', async () => {
  const page = await connect();
  await page.evaluate(() => setTimeout(() => window.print(), 0));
  await expect.poll(() => topActivity(), { timeout: 20_000 }).toMatch(/printspooler/);
  shot('07-print');
  await backToApp();
  await expect.poll(() => topActivity()).not.toMatch(/printspooler/);
});

test('the Drive button opens Google sign-in', async () => {
  const page = await connect();
  await page.evaluate(() => { document.body.classList.add('menu-open'); });
  await page.getByRole('button', { name: '☁️ סנכרן עם Google Drive' }).click();
  // Google's sign-in opens on top of the app; it must not be blocked as a popup
  await expect.poll(() => browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(' '), { timeout: 30_000 })
    .toContain('accounts.google.com');
  shot('08-google-signin');
  await backToApp();
});

// The point of the app: the PC and the phone work on the same data. The "PC" is a
// desktop Chrome on the CI machine; the phone is this Android app. One Drive.
test('the PC and the Android app share their data through Drive', async () => {
  let drive = JSON.stringify({ files: {}, n: 1, uploads: 0, deleted: [] });
  const share = (op, snap) => { if (op === 'save') drive = snap; return drive; };

  const desktop = await chromium.launch();
  const pc = await (await desktop.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await pc.exposeFunction('__driveShared', share);
  await stubDrive(pc, null);
  pc.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('ספק מהמחשב') : d.accept()));
  await pc.goto(BRANCH_URL);
  await pc.evaluate(() => connectDrive());
  await pc.locator('tbody tr').first().locator('input.num').first().fill('7.5');
  await expect.poll(() => drive).toContain('7.5');

  let phone = await connect();
  await phone.exposeFunction('__driveShared', share);
  await stubDrive(phone, null);
  phone.on('dialog', (d) => d.accept());
  // the phone starts from nothing (the app re-saves on unload, so clear it before it loads)
  await phone.addInitScript((k) => { if (!sessionStorage.getItem('__wiped')) { sessionStorage.setItem('__wiped', '1'); localStorage.removeItem(k); } }, STORAGE_KEY);
  await phone.reload();
  console.log('phone fake Drive:', await phone.evaluate(() => ({ shared: typeof window.__driveShared, fake: !!window.__drive, url: location.href })));
  await phone.evaluate(() => connectDrive());
  await expect(phone.locator('tbody tr').first().locator('input.num').first()).toHaveValue('7.5');
  shot('09-phone-got-pc-data');

  await phone.locator('tbody tr').first().locator('input.num').first().fill('8.25');
  await expect.poll(async () => { await pc.evaluate(() => drivePull()); return pc.locator('tbody tr').first().locator('input.num').first().inputValue(); },
    { timeout: 30_000 }).toBe('8.25');
  await desktop.close();
});
