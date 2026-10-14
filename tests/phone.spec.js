import { test, expect, devices } from '@playwright/test';
import {
  STORAGE_KEY, PNG_B64, seed, XLSX_MIME, buildXlsx, stubDrive, trackErrors, startServer,
} from './helpers.js';

// The Android app opens this very page in Chrome on the phone. These tests use it
// the way he does there: by touch, through the ☰ drawer, on a narrow screen, over
// the real http origin that Drive sync needs. They only run in the "android" project.
test.beforeEach(({}, info) => test.skip(info.project.name !== 'android', 'phone-only flows'));

let server, origin;
test.beforeAll(async () => { ({ server, origin } = await startServer()); });
test.afterAll(() => server && server.close());

const open = async (page) => {
  await page.goto(`${origin}/gemstone-tracker.html`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
};
const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
// answer the app's prompt()/confirm() dialogs in order, the way he would tap them
const answer = (page, replies) => {
  const queue = [...replies];
  page.on('dialog', (d) => {
    if (d.type() === 'alert' || d.type() === 'beforeunload') return d.accept();
    const r = queue.shift();
    return r === false ? d.dismiss() : d.accept(typeof r === 'string' ? r : undefined);
  });
};
const drawer = async (page) => {
  await page.locator('#menuToggle').tap();
  await expect(page.locator('body')).toHaveClass(/menu-open/);
};
const noSideways = async (page, where) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${where}: the page must not scroll sideways on a phone`).toBeLessThanOrEqual(1);
};

test('every screen is reachable from the ☰ drawer, and none is wider than the phone', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await open(page);
  await noSideways(page, 'tracker');

  // the drawer opens, and tapping beside it closes it again
  await drawer(page);
  await page.locator('#menuBackdrop').tap({ position: { x: 10, y: 300 } });
  await expect(page.locator('body')).not.toHaveClass(/menu-open/);

  for (const [nav, view] of [['#navPreview', '#previewView'], ['#navHistory', '#historyView'],
    ['#navStats', '#statsView'], ['#navShip', '#shipView'], ['#navGuide', '#guideView'], ['#navTracker', '#main']]) {
    await drawer(page);
    await page.locator(nav).tap();
    await expect(page.locator('body'), `${nav} closes the drawer`).not.toHaveClass(/menu-open/);
    await expect(page.locator(view)).toBeVisible();
    await noSideways(page, nav);
  }
  expect(errors).toEqual([]);
});

test('a purchase is entered by touch, with its certificate photo, and survives a restart', async ({ page }) => {
  await seed(page, { once: true });
  answer(page, ['ספק מהטלפון', 'TP']);
  await open(page);

  await page.locator('.tab-add').tap();                                   // ➕ ספק חדש
  await expect(page.locator('.tab.active')).toHaveText('ספק מהטלפון');
  await page.locator('.add-row-bar .btn-add').tap();                       // ➕ הוסף שורות
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  const row = rows.nth(1);
  await expect(row.locator('input').first()).toHaveValue('TP-02');         // serial from the vendor code

  const nums = row.locator('input.num');                                   // weight, stones, cost
  await nums.nth(0).tap(); await nums.nth(0).fill('2.5');
  await nums.nth(1).tap(); await nums.nth(1).fill('3');
  await nums.nth(2).tap(); await nums.nth(2).fill('400');
  await expect(row.locator('td.auto[data-auto="totCost"]')).toContainText('1,000');

  // the ➕ in the certificate column opens the phone's camera / file picker
  const chooser = page.waitForEvent('filechooser');
  await row.locator('button.cert-add').tap();
  await (await chooser).setFiles({ name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
  await expect(row.locator('img.cert-thumb')).toBeVisible();

  // tapping the photo opens it full size
  await row.locator('img.cert-thumb').tap();
  await expect(page.locator('#certClose')).toBeVisible();
  await page.locator('#certClose').tap();

  await expect.poll(async () => (await stored(page)).trips[0].vendors[1].rows[1].weight).toBe('2.5');

  // the app is closed and opened again: everything is still there, photo included
  await page.reload();
  await expect(page.locator('.tab.active')).toHaveText('ספק מהטלפון');
  const again = page.locator('tbody tr').nth(1);
  await expect(again.locator('input.num').nth(2)).toHaveValue('400');
  await expect(again.locator('img.cert-thumb')).toBeVisible();
  await expect.poll(() => again.locator('img.cert-thumb').evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);

  // and the all-vendors summary adds it up
  await page.locator('.tab.summary').tap();
  await expect(page.locator('#main')).toContainText('1,000');
});

test('trips are created, duplicated, renamed and deleted from the phone', async ({ page }) => {
  await seed(page);
  // new trip name · duplicate name · "names only?" → no, copy the data · rename · delete → yes
  answer(page, ['טיול חדש', 'טיול חדש (עותק)', false, 'טיול שונה', true]);
  await open(page);
  const trips = async () => (await stored(page)).trips.map((t) => t.name);

  await page.getByRole('button', { name: '➕ נסיעה חדשה' }).tap();
  await expect.poll(trips).toEqual(['Test trip', 'טיול חדש']);
  await page.getByRole('button', { name: '⧉ שכפל נסיעה' }).tap();
  await expect.poll(trips).toEqual(['Test trip', 'טיול חדש', 'טיול חדש (עותק)']);
  await page.getByRole('button', { name: '✏️ שנה שם' }).first().tap();
  await expect.poll(trips).toEqual(['Test trip', 'טיול חדש', 'טיול שונה']);
  await page.getByRole('button', { name: '🗑️ מחק נסיעה' }).tap();
  await expect.poll(trips).toEqual(['Test trip', 'טיול חדש']);

  // the trip picker switches between them
  await page.locator('#tripSelect').selectOption('t1');
  await expect.poll(async () => (await stored(page)).activeTripId).toBe('t1');
});

test("backup, restore and Excel import go through the phone's file picker", async ({ page }) => {
  await seed(page);
  answer(page, [true, 'מאקסל']);                // restore → yes, overwrite · import → trip name
  await open(page);

  // 💾 backup downloads one file holding everything
  await drawer(page);
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '💾 גיבוי הכל' }).tap();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^gemstones_backup_\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(backup.trips[0].vendors[0].name).toBe('ספק בדיקה');

  // ↺ restore it after a change, from the picker
  await page.evaluate(() => { state.trips[0].vendors[0].name = 'שונה'; save(); render(); });
  await drawer(page);
  let chooser = page.waitForEvent('filechooser');
  await page.locator('label.menu-item', { hasText: 'שחזור גיבוי' }).tap();
  await (await chooser).setFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect.poll(async () => (await stored(page)).trips[0].vendors[0].name).toBe('ספק בדיקה');

  // 📥 an old Excel workbook comes in as a new trip
  await drawer(page);
  chooser = page.waitForEvent('filechooser');
  await page.locator('label.menu-item', { hasText: 'ייבוא מאקסל ישן' }).tap();
  await (await chooser).setFiles({ name: 'old.xlsx', mimeType: XLSX_MIME,
    buffer: buildXlsx([{ name: 'גיליון', rows: [['1', 'QQ-01', '1.25']] }]) });
  await expect.poll(async () => (await stored(page)).trips.map((t) => t.name)).toContain('מאקסל');
});

test('print, e-mail and the shipping invoice all start from the phone', async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    window.__printed = 0; window.print = () => { window.__printed++; };
    window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return {}; };
  });
  answer(page, []);
  await open(page);

  await drawer(page);
  await page.getByRole('button', { name: '🖨️ הדפסה / PDF' }).tap();
  expect(await page.evaluate(() => window.__printed)).toBe(1);

  await drawer(page);
  await page.getByRole('button', { name: '📧 שלח במייל' }).tap();
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(2);
  expect((await page.evaluate(() => window.__opened))[0]).toContain('mail.google.com');

  await drawer(page);
  await page.locator('#navShip').tap();
  await expect(page.locator('#shipNum')).toHaveText('64911');
  await page.locator('#shipTo').tap();
  await page.locator('#shipTo').fill('CONSIGNEE LTD');
  await page.locator('#shipView .pv-install').tap();                     // the invoice's own print button
  expect(await page.evaluate(() => window.__printed)).toBe(3);
  await expect.poll(async () => (await stored(page)).trips[0].shipment.to).toBe('CONSIGNEE LTD');
});

test('an earlier version is restored from the phone', async ({ page }) => {
  await seed(page);
  answer(page, [true]);
  await open(page);
  await page.evaluate(async () => {
    await snapPut({ day: '2026-02-03', ts: '2026-02-03T00:00:00.000Z',
      data: Object.assign(JSON.parse(JSON.stringify(state)), { trips: [{ ...state.trips[0], name: 'גרסה ישנה' }] }) });
  });
  await drawer(page);
  await page.getByRole('button', { name: '↩️ שחזר גרסה קודמת' }).tap();
  const box = page.locator('#rstOverlay');
  await expect(box).toContainText('2026-02-03');
  await box.getByRole('button', { name: 'שחזר' }).first().tap();
  await expect.poll(async () => (await stored(page)).trips[0].name).toBe('גרסה ישנה');
});

test('Drive is connected by tapping the menu button', async ({ page }) => {
  await seed(page);
  await stubDrive(page, null);
  answer(page, []);
  await open(page);
  await drawer(page);
  await page.getByRole('button', { name: '☁️ סנכרן עם Google Drive' }).tap();
  await expect(page.locator('#driveUI .sync-chip')).toContainText('gemstones.json');
  await expect.poll(() => page.evaluate(() => Object.values(window.__drive.files).some((f) => f.name === 'gemstones.json'))).toBe(true);
});

// The point of the Android app: the PC and the phone work on the same data.
// Two devices, one Drive: each sees what the other did, in both directions.
test('the PC and the phone work on the same data through Drive', async ({ browser }) => {
  test.setTimeout(120_000);
  let drive = JSON.stringify({ files: {}, n: 1, uploads: 0, deleted: [] });
  const device = async (descriptor, local) => {
    const ctx = await browser.newContext({ ...descriptor });
    const page = await ctx.newPage();
    await page.exposeFunction('__driveShared', (op, snap) => { if (op === 'save') drive = snap; return drive; });
    if (local) await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await page.goto(`${origin}/gemstone-tracker.html`);
    return { ctx, page };
  };
  const pc = await device(devices['Desktop Chrome'], true);
  const phone = await device(devices['Pixel 7'], false);
  const weight = (p, i) => p.page.locator('tbody tr').nth(i).locator('input.num').first();
  const pull = (p) => p.page.evaluate(() => drivePull());           // what the 30-second check does

  // the PC connects first and uploads its trip
  await pc.page.evaluate(() => connectDrive());
  await weight(pc, 0).fill('1.2');
  await expect.poll(() => JSON.parse(drive).files['gemstones.json@' + Object.values(JSON.parse(drive).files)
    .find((f) => f.name === 'מעקב אבני חן').id]?.body || '').toContain('1.2');

  // the phone starts empty, connects with the same account, and gets the PC's data
  await phone.page.locator('#menuToggle').tap();
  await phone.page.getByRole('button', { name: '☁️ סנכרן עם Google Drive' }).tap();
  await expect(phone.page.locator('.tab.active')).toHaveText('ספק בדיקה');
  await expect(weight(phone, 0)).toHaveValue('1.2');

  // an edit on the phone, with a photo, reaches the PC
  await weight(phone, 0).tap(); await weight(phone, 0).fill('4.75');
  const chooser = phone.page.waitForEvent('filechooser');
  await phone.page.locator('tbody tr').first().locator('button.cert-add').tap();
  await (await chooser).setFiles({ name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
  await expect(phone.page.locator('img.cert-thumb')).toBeVisible();
  await expect.poll(async () => { await pull(pc); return weight(pc, 0).inputValue(); }, { timeout: 15_000 }).toBe('4.75');
  await expect.poll(() => pc.page.locator('img.cert-thumb').first().evaluate((i) => i.naturalWidth).catch(() => 0),
    { timeout: 20_000 }).toBeGreaterThan(0);

  // and a new vendor added on the PC reaches the phone
  pc.page.removeAllListeners('dialog');
  const replies = ['ספק מהמחשב', 'PC'];
  pc.page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(replies.shift()) : d.accept()));
  await pc.page.locator('.tab-add').click();
  await expect(pc.page.locator('.tab.active')).toHaveText('ספק מהמחשב');
  await expect.poll(async () => { await pull(phone); return phone.page.locator('.tab').allInnerTexts(); }, { timeout: 15_000 })
    .toContain('ספק מהמחשב');

  await pc.ctx.close(); await phone.ctx.close();
});
