import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  APP_URL, STORAGE_KEY, PNG_B64, seed, XLSX_MIME, buildXlsx, stubDrive, remoteFile, driveFile, driveBody, menu, trackErrors,
} from './helpers.js';

test.describe('Gemstone tracker', () => {
  test('loads with no JavaScript errors and renders the table', async ({ page }) => {
    const errors = trackErrors(page);
    await seed(page);
    await page.goto(APP_URL);
    await expect(page.locator('table').first()).toBeVisible();
    // header carries the expected Hebrew columns, including the certificate column
    const header = (await page.locator('thead tr').last().locator('th').allInnerTexts()).join('|');
    for (const col of ['סריה', 'משקל', 'צורה', 'תעודה', 'הערות']) {
      expect(header, `header should contain ${col}`).toContain(col);
    }
    expect(errors, 'no console/page errors on load').toEqual([]);
  });

  test('table columns stay aligned (header = body = footer)', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const table = page.locator('.table-scroll table').first();
    const head = await table.locator('thead tr').last().locator('th').count();
    const body = await table.locator('tbody tr').first().locator('td').count();
    expect(body).toBe(head);
    // footer has one <td colspan=2>, so it carries head-1 cells
    const foot = await table.locator('tfoot tr').first().locator('td').count();
    expect(foot).toBe(head - 1);
  });

  test('auto-calculates total cost from weight × cost-per-carat', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const row = page.locator('tbody tr').first();
    const nums = row.locator('input.num'); // order: weight, stones, cost
    await nums.nth(0).fill('2');
    await nums.nth(2).fill('100');
    await expect(row.locator('td.auto[data-auto="totCost"]')).toContainText('200');
  });

  test('rejects non-numeric input in numeric columns', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const weight = page.locator('tbody tr').first().locator('input.num').first();
    await weight.click();
    await weight.pressSequentially('12a'); // the "a" must be rejected, keeping "12"
    await expect(weight).toHaveValue('12');
  });

  test('certificate column: empty cell offers add, upload stores a photo', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const cell = page.locator('td.col-cert').first();
    await expect(cell.locator('button.cert-add')).toBeVisible();

    await page.locator('td.col-cert input[type=file]').first().setInputFiles({
      name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64'),
    });

    await expect(cell.locator('img.cert-thumb')).toBeVisible();
    const cert = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).trips[0].vendors[0].rows[0].cert,
      STORAGE_KEY,
    );
    expect(cert).toMatch(/^cert_/); // row now references a stored image filename
  });

  test('user guide renders with sequential steps and covers certificates', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    await page.evaluate(() => showView('guide'));
    const nums = await page.$$eval('.guide-step .num', (els) => els.map((e) => e.textContent.trim()));
    expect(nums.length).toBeGreaterThan(10);
    expect(nums).toEqual(nums.map((_, i) => String(i + 1))); // 1,2,3,… with no gaps
    const titles = (await page.locator('.guide-step h3').allInnerTexts()).join('|');
    expect(titles).toContain('תעודה'); // certificate step present
  });

  // the guide is the only manual he has, so it has to keep up with the app
  test('the guide covers every screen and every button of the app', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    await page.evaluate(() => showView('guide'));
    const text = await page.locator('#guideView').innerText();

    // every menu item is explained somewhere in the guide
    const menu = await page.$$eval('.sidemenu .menu-item', (els) => els.map((e) => e.innerText.trim()));
    for (const item of menu) {
      const label = item.replace(/^\P{L}+/u, '').split('\n')[0].trim();   // drop the leading emoji
      expect(text, `guide should cover the menu item "${label}"`).toContain(label);
    }
    // and the pieces of the tracker screen that are easy to miss
    for (const must of ['מטבע', 'הערות', 'תאריך', 'שכפל נסיעה', 'שמור למסך הבית',
                        'POLISHED DIAMONDS', 'Invoice Number', 'Invoice Date']) {
      expect(text, `guide should explain ${must}`).toContain(must);
    }
    // photos do travel between devices now — the old warning must not linger
    expect(text).not.toContain('לא</b> עוברות');
    expect(text).not.toMatch(/במכשיר שבו צירפתם אותן בלבד/);
  });

  test('Excel export is removed; Excel import remains', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const state = await page.evaluate(() => ({
      exportCSV: typeof window.exportCSV,
      importXLSX: typeof window.importXLSX,
      hasExportText: document.body.innerHTML.includes('ייצוא לאקסל'),
    }));
    expect(state.exportCSV).toBe('undefined');
    expect(state.importXLSX).toBe('function');
    expect(state.hasExportText).toBe(false);
  });

  test('Excel import splits a mixed sheet into one vendor per code, and skips empty sheets', async ({ page }) => {
    const errors = trackErrors(page);
    await seed(page);
    await page.goto(APP_URL);

    // his real workbook shape: a "Gemesis" tab holding several codes, and an empty "ELI" tab
    const xlsx = buildXlsx([
      { name: 'Main', rows: [['1', 'GD-01', '1']] },          // summary tab – never imported
      { name: 'Elul', rows: [['1', 'GD-01', '1'], ['2', 'GD-02', '2']] },
      // Excel stores 2.03 / 5.02 as binary-float noise; import must round it back
      { name: 'Gemesis', rows: [['1', 'RM-01', '3.6'], ['2', 'RM-02', '5.0199999999999996'], ['3', 'RG-01', '2.5'], ['4', 'MS-01', '1.43'], ['5', 'MS-02', '2.0299999999999998']] },
      { name: 'ELI', rows: [] },                              // header only – no data
    ]);

    page.on('dialog', (d) => d.accept('נסיעה מיובאת'));       // trip-name prompt, then the summary alert
    await page.setInputFiles('input[type=file][accept=".xlsx"]', { name: 'august.xlsx', mimeType: XLSX_MIME, buffer: xlsx });

    // save is debounced; wait for the imported trip to land, then inspect it
    const activeTrip = (key) => {
      const s = JSON.parse(localStorage.getItem(key));
      return s.trips.find((t) => t.id === s.activeTripId);
    };
    // one tab per code, named after the code; "Gemesis" and the empty "ELI" produce no tab of their own
    await expect.poll(async () =>
      (await page.evaluate(activeTrip, STORAGE_KEY))?.vendors.map((v) => v.name),
    ).toEqual(['GD', 'RM', 'RG', 'MS']);
    const trip = await page.evaluate(activeTrip, STORAGE_KEY);

    expect(trip.vendors.map((v) => v.code)).toEqual(['GD', 'RM', 'RG', 'MS']);
    expect(trip.vendors.map((v) => v.rows.length)).toEqual([2, 2, 1, 2]);
    // rows keep their serials and land under their own code
    expect(trip.vendors[1].rows.map((r) => r.serial)).toEqual(['RM-01', 'RM-02']);
    expect(trip.vendors[3].rows.map((r) => r.serial)).toEqual(['MS-01', 'MS-02']);
    // weights come in clean, not as 5.0199999999999996 / 2.0299999999999998
    expect(trip.vendors[1].rows.map((r) => r.weight)).toEqual(['3.6', '5.02']);
    expect(trip.vendors[3].rows.map((r) => r.weight)).toEqual(['1.43', '2.03']);
    expect(errors, 'no console/page errors during import').toEqual([]);
  });

  test('a vendor code can be longer than 2 letters, and new rows follow it', async ({ page }) => {
    const errors = trackErrors(page);
    await seed(page);
    await page.goto(APP_URL);

    // too long is still refused (alert), and the old code stays
    const answers = ['GEMSTONE', 'gems'];
    const seen = [];
    page.on('dialog', (d) => {
      seen.push(d.type());
      if (d.type() === 'prompt') return d.accept(answers.shift());
      if (d.type() === 'confirm') return d.accept();   // renumber the existing rows
      return d.accept();
    });
    const codeBtn = page.locator('.vendor-actions button').first();
    await codeBtn.click();
    expect(seen).toEqual(['prompt', 'alert']);
    await expect(page.locator('.vcode-badge').first()).toHaveText('AB');

    await codeBtn.click();
    await expect(page.locator('.vcode-badge').first()).toHaveText('GEMS');
    await page.locator('.btn-add').click();

    const serials = () => page.evaluate((key) => {
      const s = JSON.parse(localStorage.getItem(key));
      return s.trips[0].vendors[0].rows.map((r) => r.serial);
    }, STORAGE_KEY);
    await expect.poll(serials).toEqual(['GEMS-01', 'GEMS-02']);
    expect(errors, 'no console/page errors').toEqual([]);
  });

  test('Excel import keeps codes longer than 2 letters', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const xlsx = buildXlsx([
      { name: 'Elul', rows: [['1', 'ELUL-01', '1'], ['2', 'ELUL-02', '2'], ['3', 'GD-01', '1.5']] },
    ]);
    page.on('dialog', (d) => d.accept('נסיעה מיובאת'));
    await page.setInputFiles('input[type=file][accept=".xlsx"]', { name: 'long.xlsx', mimeType: XLSX_MIME, buffer: xlsx });
    const codes = () => page.evaluate((key) => {
      const s = JSON.parse(localStorage.getItem(key));
      return s.trips.find((t) => t.id === s.activeTripId)?.vendors.map((v) => v.code);
    }, STORAGE_KEY);
    await expect.poll(codes).toEqual(['ELUL', 'GD']);
  });

  test('already-imported float noise is cleaned up on load', async ({ page }) => {
    await page.addInitScript((key) => {
      const row = (over) => ({ serial: 'AB-01', weight: '', stones: '1', shape: '', cost: '', cert: '', notes: '', ...over });
      localStorage.setItem(key, JSON.stringify({
        currency: '$', activeTripId: 't1',
        trips: [{ id: 't1', name: 'Test trip', date: '2026-07-03', activeId: 'v1',
          vendors: [{ id: 'v1', name: 'AB', code: 'AB', rows: [
            row({ weight: '2.0299999999999998', cost: '21585.999999999996' }),
            row({ serial: 'AB-02', weight: '2.03', cost: '1500' }),   // typed by hand – must not change
          ] }] }],
      }));
    }, STORAGE_KEY);
    await page.goto(APP_URL);
    const rows = await page.evaluate(() => state.trips[0].vendors[0].rows.map((r) => [r.weight, r.cost]));
    expect(rows).toEqual([['2.03', '21586'], ['2.03', '1500']]);
  });

  test('the old file-handle sync is gone; Google Drive is the only sync', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const gone = await page.evaluate(() => ['connectNewFile', 'connectExistingFile', 'renderSyncUI', 'loadFromSync', 'writeSyncFile']
      .map((f) => typeof window[f]));
    expect(gone).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    const html = await page.evaluate(() => document.body.innerHTML);
    expect(html).not.toContain('חבר קובץ נתונים');
    expect(html).not.toContain('פתח קובץ קיים');
    expect(await page.evaluate(() => typeof connectDrive)).toBe('function');
  });

  test('the band headings are legible against the header background', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).map((n) => {
        const c = n / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const styles = await page.evaluate(() => ['band-taken'].map((cls) => {
      const el = document.querySelector('.band .' + cls), cs = getComputedStyle(el);
      return { text: el.textContent.trim(), color: cs.color, bg: cs.backgroundColor };
    }));
    for (const s of styles) {
      expect(s.text.length, 'band heading has text').toBeGreaterThan(0);
      const [a, b] = [lum(s.color), lum(s.bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      expect(ratio, `${s.text} contrast`).toBeGreaterThanOrEqual(4.5);   // WCAG AA
    }
  });

  test('the guide documents Drive sync and drops the removed features', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    await page.evaluate(() => showView('guide'));
    const text = await page.locator('#guideView').innerText();

    // the sync and backup behaviour a user has to know about
    for (const must of ['Google Drive', 'backups', 'רענן', '30 שניות', 'אותו חשבון', 'gemstones.json']) {
      expect(text, `guide should explain ${must}`).toContain(must);
    }
    // features that no longer exist must not be documented
    for (const gone of ['חבר תיקיית גיבוי', 'חבר קובץ נתונים', 'פתח קובץ קיים', 'ייצוא לאקסל']) {
      expect(text, `guide should not mention ${gone}`).not.toContain(gone);
    }
    // the sync step carries both screenshots
    const syncStep = page.locator('.guide-step', { has: page.locator('h3', { hasText: 'סנכרון בין המחשב לטלפון' }) });
    await expect(syncStep).toHaveCount(1);
    expect(await syncStep.locator('img.guide-shot').count()).toBe(2);
    expect(await page.evaluate(() => Object.keys(GUIDE_IMG))).toEqual(expect.arrayContaining(['drive', 'driveoff', 'backup']));
  });

  test('data persists to localStorage after editing', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    await page.locator('tbody tr').first().locator('input.num').nth(0).fill('1.75');
    // debounced save; wait until it lands
    await expect.poll(async () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)).trips[0].vendors[0].rows[0].weight, STORAGE_KEY),
    ).toBe('1.75');
  });

  // the all-vendors summary is the sheet he shows other people: company logo for a
  // heading (screen and print alike) and English column names
  test('the all-vendors summary is headed by the logo and labelled in English', async ({ page }) => {
    await seed(page);
    await page.goto(APP_URL);
    const nums = page.locator('tbody tr').first().locator('input.num');
    await nums.nth(0).fill('2');
    await nums.nth(2).fill('300');
    await page.locator('.tab.summary').click();

    const panel = page.locator('.panel');
    await expect(panel.locator('.sum-logo')).toBeVisible();          // not print-only
    await expect(panel.locator('.vendor-head h2')).toHaveCount(0);   // Hebrew heading gone

    const header = (await panel.locator('.sum-table thead th').allInnerTexts()).join('|');
    for (const col of ['#', 'Serial', 'Weight (ct)', 'Stones', 'Shape', 'Cost / ct',
                       'Total Cost', 'Cert', 'Notes']) {
      expect(header, `header should contain ${col}`).toContain(col);
    }
    // the totals live in the cards alone — the table carries rows, no footer
    await expect(panel.locator('.sum-table tfoot')).toHaveCount(0);
    await expect(panel.locator('.totals')).toContainText('Total Carats');
    await expect(panel.locator('.totals')).toContainText('Total Cost');
    await expect(panel.locator('.totals')).not.toContainText('Total Stones');

    // nothing but the logo above the table — no trip label, no heading
    await expect(panel.locator('.sum-head')).toHaveText('');
    // and no Hebrew anywhere on the sheet
    expect(await panel.innerText()).not.toMatch(/[֐-׿]/);

    // both totals reach paper, and with no tfoot there is no footer left to
    // repeat under every printed page
    await page.emulateMedia({ media: 'print' });
    await expect(panel.locator('.totals .card')).toHaveCount(2);
    for (const card of ['Total Carats', 'Total Cost']) {
      await expect(panel.locator('.totals .card', { hasText: card })).toBeVisible();
    }
    await page.emulateMedia({ media: null });

    // it reads left-to-right: '#' sits to the left of 'Notes'
    expect(await panel.locator('.sum-panel, .sum-table').first().evaluate(
      (el) => getComputedStyle(el).direction)).toBe('ltr');
    const first = await panel.locator('.sum-table thead th').first().boundingBox();
    const last = await panel.locator('.sum-table thead th').last().boundingBox();
    expect(first.x, '# column is left of the Notes column').toBeLessThan(last.x);
  });

  // he buys, he does not track what he sold — there is no selling side to the app
  test('nothing about selling is left anywhere in the app', async ({ page }) => {
    const errors = trackErrors(page);
    await seed(page);
    await page.goto(APP_URL);

    // no sale columns, no ✔ sold checkbox, no מכירות band
    const header = (await page.locator('thead tr').last().locator('th').allInnerTexts()).join('|');
    for (const gone of ['מכירה', 'נמכר', 'רווח']) {
      expect(header, `header must not mention ${gone}`).not.toContain(gone);
    }
    expect(await page.locator('.band .band-sales').count()).toBe(0);
    expect(await page.locator('td.col-sold, tbody input[type=checkbox]').count()).toBe(0);
    expect(await page.evaluate(() => typeof rowSale)).toBe('undefined');
    expect(await page.evaluate(() => COLS.map((c) => c.key)))
      .toEqual(['serial', 'weight', 'stones', 'shape', 'cost', 'totCost', 'cert', 'notes']);

    // a new row carries buying fields only
    expect(await page.evaluate(() => Object.keys(blankRow())))
      .toEqual(['serial', 'weight', 'stones', 'shape', 'cost', 'cert', 'notes']);

    // every screen is free of selling words
    for (const view of ['tracker', 'preview', 'history', 'stats', 'guide']) {
      await page.evaluate((v) => showView(v), view);
      const txt = await page.locator('main').innerText();
      for (const gone of ['מכירה', 'נמכר', 'רווח', 'מרווח']) {
        expect(txt, `${view} must not mention ${gone}`).not.toContain(gone);
      }
    }
    expect(errors, 'no console/page errors').toEqual([]);
  });

  test('the vendor statistics page reports what he bought', async ({ page }) => {
    await page.addInitScript((key) => {
      const row = (serial, weight, cost) =>
        ({ serial, weight, stones: '1', shape: 'Round', cost, cert: '', notes: '' });
      localStorage.setItem(key, JSON.stringify({
        currency: '$', activeTripId: 't1',
        trips: [{ id: 't1', name: 'Test trip', date: '2026-07-03', activeId: 'v1',
          vendors: [{ id: 'v1', name: 'ספק בדיקה', code: 'AB',
            rows: [row('AB-01', '2', '300'), row('AB-02', '3', '100')] }] }],
      }));
    }, STORAGE_KEY);
    await page.goto(APP_URL);
    await page.evaluate(() => showView('stats'));

    const card = page.locator('.st-vendor').first();
    // 2×300 + 3×100 = 900 over 5 ct  ->  180 per carat, 450 per stone
    await expect(card.locator('.st-headline')).toContainText('$ 900');
    await expect(card.locator('.st-headline')).toContainText('$ 180');
    await expect(card.locator('.st-headline')).toContainText('5');
    await expect(card.locator('.st-grid')).toContainText('$ 450');
    // sorting offers buying measures only
    const opts = await page.locator('.st-sort select option').allInnerTexts();
    expect(opts).toEqual(['עלות כוללת', 'עלות לקראט', 'סה"כ קראט', 'מספר אבנים', 'מספר נסיעות']);
  });
});

// משלוח — one shipping invoice per trip, always a single line
test.describe('Shipment invoice (משלוח)', () => {
  // two vendors, so the single line has to add up across the whole trip:
  // 2×300 + 3×100 = 900 over 5 ct, and 1.5×200 = 300 over 1.5 ct  ->  6.5 ct / 1,200.00
  async function seedTrip(page) {
    await page.addInitScript((key) => {
      const row = (serial, weight, cost) =>
        ({ serial, weight, stones: '1', shape: 'Round', cost, cert: '', notes: '' });
      localStorage.setItem(key, JSON.stringify({
        currency: '$', activeTripId: 't1',
        trips: [{ id: 't1', name: 'Test trip', date: '2026-07-03', activeId: 'v1',
          vendors: [
            { id: 'v1', name: 'ספק בדיקה', code: 'AB', rows: [row('AB-01', '2', '300'), row('AB-02', '3', '100')] },
            { id: 'v2', name: 'ספק שני', code: 'CD', rows: [row('CD-01', '1.5', '200')] },
          ] }],
      }));
    }, STORAGE_KEY);
  }

  test('one line carries the trip totals, described as polished diamonds', async ({ page }) => {
    const errors = trackErrors(page);
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');

    const doc = page.locator('.ship-doc');
    await expect(doc).toBeVisible();
    await expect(doc.locator('.ship-logo')).toBeVisible();            // the logo heads the form
    await expect(doc.locator('.ship-title')).toHaveText('INVOICE');
    await expect(doc.locator('.ship-from')).toContainText('RAMAT GAN');

    const header = (await doc.locator('.ship-table thead th').allInnerTexts()).join('|');
    expect(header).toBe('Line|Qty|Weight (gr.)|Carats|Description|Note|Price P/Uni|Total USD');

    // exactly one item line, whatever the trip holds
    await expect(doc.locator('.ship-table tr.ship-line')).toHaveCount(1);
    const cells = await doc.locator('.ship-table tr.ship-line td').allInnerTexts();
    expect(cells).toEqual(['1', '', '', '6.50', 'POLISHED DIAMONDS', '', '', '1,200.00']);

    await expect(doc.locator('.ship-origin')).toContainText('ISRAEL');
    await expect(doc.locator('.ship-totals')).toContainText('6.50');
    await expect(doc.locator('.ship-totals')).toContainText('1,200.00');
    await expect(doc.locator('.ship-kp')).toContainText('conflict free');
    await expect(doc.locator('.ship-sign')).toContainText('012470670');

    // it is the sheet handed to the shipper: English, left-to-right
    expect(await doc.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
    expect(await doc.innerText()).not.toMatch(/[֐-׿]/);               // no Hebrew on the form itself
    expect(errors, 'no console/page errors').toEqual([]);
  });

  test('the To box takes free text, and opens with the last consignee', async ({ page }) => {
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');

    const to = page.locator('#shipTo');
    await expect(to).toHaveValue('');                                 // nothing shipped yet, nothing to offer
    await to.fill('SOME OTHER SHIPPER\nLINE TWO\nLINE THREE');
    await page.locator('#shipDate').fill('2026-08-20');               // the date he may still correct

    await expect.poll(async () => page.evaluate((key) => {
      const s = JSON.parse(localStorage.getItem(key)), sh = s.trips[0].shipment || {};
      return [sh.to, sh.date, s.shipTo];
    }, STORAGE_KEY)).toEqual([
      'SOME OTHER SHIPPER\nLINE TWO\nLINE THREE', '2026-08-20',
      'SOME OTHER SHIPPER\nLINE TWO\nLINE THREE',
    ]);

    // the next trip's invoice opens with the same consignee, ready to reuse
    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Second trip') : d.dismiss()));
    await page.evaluate(() => addTrip());
    await menu(page, '#navShip');
    await expect(page.locator('#shipTo')).toHaveValue('SOME OTHER SHIPPER\nLINE TWO\nLINE THREE');
    await page.evaluate(() => { state.activeTripId = state.trips[0].id; save(); render(); showView('ship'); });

    // and it comes back the next time that trip's form is opened
    await expect(page.locator('#shipTo')).toHaveValue('SOME OTHER SHIPPER\nLINE TWO\nLINE THREE');
    await expect(page.locator('#shipDate')).toHaveValue('2026-08-20');
    await expect(page.locator('#shipToOut')).toHaveText('SOME OTHER SHIPPER\nLINE TWO\nLINE THREE');
    // the box grew to hold all three lines instead of clipping them
    const box = page.locator('#shipTo');
    expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(2);
  });

  // the number is the app's own, carrying on from the invoices already written by hand
  test('the invoice number runs on by itself and cannot be typed over', async ({ page }) => {
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');

    await expect(page.locator('#shipNum')).toHaveText('64911');       // 64910 was the last one on paper
    expect(await page.locator('#shipNum').evaluate((el) => el.tagName)).not.toBe('INPUT');
    await expect(page.locator('.ship-meta input#shipNum')).toHaveCount(0);

    // the same trip keeps its number; a second trip takes the next one
    await menu(page, '#navTracker');
    await menu(page, '#navShip');
    await expect(page.locator('#shipNum')).toHaveText('64911');

    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Second trip') : d.dismiss()));
    await page.evaluate(() => addTrip());
    await menu(page, '#navShip');
    await expect(page.locator('#shipNum')).toHaveText('64912');

    // and back on the first trip, still 64911
    await page.evaluate(() => { state.activeTripId = state.trips[0].id; save(); render(); showView('ship'); });
    await expect(page.locator('#shipNum')).toHaveText('64911');
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).lastInvoiceNo, STORAGE_KEY)).toBe(64912);
  });

  // "the date of the invoice generation": stamped once, and it stays put
  test('the date is the day the invoice was generated, and stays frozen', async ({ page }) => {
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');

    const todayISO = await page.evaluate(() => today());
    await expect(page.locator('#shipDate')).toHaveValue(todayISO);    // not the trip's own date
    expect(todayISO).not.toBe('2026-07-03');

    // a later visit does not re-stamp it: pretend the invoice was generated last month
    await page.evaluate(() => { activeTrip().shipment.date = '2026-06-01'; save(); });
    await menu(page, '#navTracker');
    await menu(page, '#navShip');
    await expect(page.locator('#shipDate')).toHaveValue('2026-06-01');
    await expect(page.locator('#shipDateOut')).toHaveText('01-06-2026');
  });

  test('printing gives the plain form: no app chrome, date as text', async ({ page }) => {
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');
    await page.emulateMedia({ media: 'print' });

    await expect(page.locator('.ship-doc')).toBeVisible();
    await expect(page.locator('.ship-doc .ship-logo')).toBeVisible();
    for (const chrome of ['header', '.sidemenu', '.tripbar', '.tabs', '.ship-head', '.pv-trippick', '#shipDate']) {
      await expect(page.locator(chrome).first(), `${chrome} must not print`).toBeHidden();
    }
    // the date prints as plain text, not as a browser date picker
    const [y, m, d] = (await page.evaluate(() => today())).split('-');
    await expect(page.locator('#shipDateOut')).toBeVisible();
    await expect(page.locator('#shipDateOut')).toHaveText(`${d}-${m}-${y}`);
    await expect(page.locator('#shipNum')).toBeVisible();             // the number prints too
    await page.emulateMedia({ media: null });
  });

  test('a duplicated trip is issued its own invoice', async ({ page }) => {
    await seedTrip(page);
    await page.goto(APP_URL);
    await menu(page, '#navShip');
    await page.locator('#shipTo').fill('SOME OTHER SHIPPER');
    await expect(page.locator('#shipNum')).toHaveText('64911');

    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Copy trip') : d.accept()));
    await page.evaluate(() => duplicateTrip());
    await menu(page, '#navShip');
    await expect(page.locator('#shipNum')).toHaveText('64912');       // never a second invoice 64911
    await expect(page.locator('#shipTo')).toHaveValue('SOME OTHER SHIPPER');
  });
});

// Google OAuth refuses file:// origins, so the Drive tests run over http://localhost.
test.describe('Google Drive sync', () => {
  let server, origin;

  test.beforeAll(async () => {
    const http = await import('node:http');
    const fs = await import('node:fs');
    server = http.createServer((req, res) => {
      const file = req.url.split('?')[0] === '/' ? '/gemstone-tracker.html' : req.url.split('?')[0];
      try {
        const body = fs.readFileSync(path.resolve('.' + file));
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(body);
      } catch { res.writeHead(404); res.end('no'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://localhost:${server.address().port}`;
  });
  test.afterAll(() => server && server.close());

  const open = async (page) => {
    await page.goto(`${origin}/gemstone-tracker.html`);
    await page.evaluate(() => navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())));
  };
  const vendorNames = (page) => page.evaluate(() => state.trips.flatMap((t) => t.vendors.map((v) => v.name)));

  test('connecting with no file in Drive creates one and uploads the local data', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    const body = await driveBody(page);
    expect(body.state.trips[0].vendors[0].name).toBe('ספק בדיקה');
    expect(body.savedAt).toBeTruthy();
    // the chip names the file, and he gets a button that opens it in Drive
    await expect(page.locator('#driveUI .sync-chip')).toContainText('gemstones.json');
    await expect(page.locator('#driveUI button', { hasText: 'הצג ב' })).toBeVisible();
    expect(await page.evaluate(() => driveLink)).toContain('drive.google.com');
  });

  test('connecting adopts the Drive copy when it is newer than this device', async ({ page }) => {
    await seed(page);                                        // local state has no savedAt at all
    await stubDrive(page, remoteFile('2026-08-16T10:00:00.000Z', 'ספק מהטלפון'));
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    expect(await vendorNames(page)).toEqual(['ספק מהטלפון']);
  });

  test('connecting pushes local data up when Drive holds an older copy', async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({
        currency: '$', savedAt: '2026-08-16T12:00:00.000Z', activeTripId: 't1',
        trips: [{ id: 't1', name: 'Newer local', date: '2026-07-03', activeId: 'v1',
          vendors: [{ id: 'v1', name: 'ספק חדש יותר', code: 'AB', rows: [{ serial: 'AB-01', weight: '2', stones: '1', shape: '', cost: '', cert: '', notes: '' }] }] }],
      }));
    }, STORAGE_KEY);
    await stubDrive(page, remoteFile('2026-08-16T09:00:00.000Z', 'ספק ישן'));
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    expect(await vendorNames(page)).toEqual(['ספק חדש יותר']);       // local kept
    expect((await driveBody(page)).state.trips[0].vendors[0].name).toBe('ספק חדש יותר');   // and pushed
  });

  test('a stale tab cannot clobber newer data written by the other device', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());

    // the phone saves something newer straight into Drive, behind this tab's back
    await page.evaluate(() => {
      Object.values(window.__drive.files).find((f) => f.name === 'gemstones.json').body = JSON.stringify({ app: 'gemstone-tracker', savedAt: '2099-01-01T00:00:00.000Z',
        state: { currency: '$', savedAt: '2099-01-01T00:00:00.000Z', activeTripId: 't1', trips: [{ id: 't1', name: 'From phone', date: '2026-07-03', activeId: 'v9',
          vendors: [{ id: 'v9', name: 'ספק מהטלפון', code: 'ZZ', rows: [{ serial: 'ZZ-01', weight: '1', stones: '1', shape: '', cost: '', cert: '', notes: '' }] }] }] } });
      Object.values(window.__drive.files).find((f) => f.name === 'gemstones.json').modifiedTime = 'tPhone';
    });
    // this tab now edits and pushes – it must back off and take the newer copy instead
    await page.evaluate(async () => { state.trips[0].vendors[0].name = 'עריכה מקומית'; save(); await drivePush(); });
    expect(await vendorNames(page)).toEqual(['ספק מהטלפון']);
    expect((await driveBody(page)).state.trips[0].vendors[0].name).toBe('ספק מהטלפון');
  });

  test('the data file and photos live in one folder, not loose in My Drive', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    const root = await driveFile(page, 'מעקב אבני חן');
    expect(root.mimeType).toBe('application/vnd.google-apps.folder');
    expect((await driveFile(page, 'gemstones.json')).parents).toEqual([root.id]);
  });

  test('adding a certificate photo uploads it to Drive', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await page.locator('.cert-add').first().click();
    await page.locator('.cert-cell input[type=file]').first()
      .setInputFiles({ name: 'gia.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
    await expect.poll(async () =>
      page.evaluate(() => Object.values(window.__drive.files).filter((f) => /^cert_/.test(f.name || '')).length),
    ).toBe(1);
  });

  test('a photo taken on the other device is fetched from Drive', async ({ page }) => {
    // what his phone sees: the row references a photo it has never held locally
    const remote = remoteFile('2099-01-01T00:00:00.000Z', 'ספק מהמחשב');
    remote.state.trips[0].vendors[0].rows[0].cert = 'cert_abc123.jpg';
    await seed(page);
    await stubDrive(page, remote, { 'cert_abc123.jpg': 'PRETEND-JPEG-BYTES' });
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    const size = await page.evaluate(async () => (await certBlob('cert_abc123.jpg'))?.size || 0);
    expect(size).toBeGreaterThan(0);
    // and it is cached locally, so it works offline from now on
    expect(await page.evaluate(async () => (await certImgGet('cert_abc123.jpg'))?.size || 0)).toBeGreaterThan(0);
    // the thumbnail renders instead of the "missing" placeholder
    await expect(page.locator('img.cert-thumb').first()).toBeVisible();
  });

  test('a photo that reaches Drive late still shows up, without a manual refresh', async ({ page }) => {
    const remote = remoteFile('2099-01-01T00:00:00.000Z', 'ספק מהמחשב');
    remote.state.trips[0].vendors[0].rows[0].cert = 'cert_late01.jpg';
    await seed(page);
    await stubDrive(page, remote, null);                 // row references a photo Drive doesn't have yet
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await expect(page.locator('.cert-missing').first()).toBeVisible();
    // the other device finishes uploading a moment later
    await page.evaluate(() => { window.__drive.files['cert_late01.jpg@'] = { id: 'late1', name: 'cert_late01.jpg', parents: [], modifiedTime: 't9', body: 'PRETEND-JPEG-BYTES' }; });
    await expect(page.locator('img.cert-thumb').first()).toBeVisible({ timeout: 15000 });
  });

  test('a refresh reuses the saved token instead of asking Google again', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    expect(await page.evaluate(() => window.__drive.authCalls)).toBe(1);

    await open(page);                                     // reload the page
    await expect.poll(async () => page.evaluate(() => driveOn)).toBe(true);
    await expect.poll(async () => page.evaluate(() => !!driveToken)).toBe(true);
    // no second sign-in popup: the stored token was still valid
    expect(await page.evaluate(() => window.__drive.authCalls)).toBe(0);
    expect(await page.evaluate(() => driveNeedsAuth)).toBe(false);
  });

  // walk מעקב אבני חן / trips / <trip> / certificates and return the leaf folder id
  const certFolderId = async (page, tripName) => page.evaluate((trip) => {
    const all = Object.values(window.__drive.files);
    const child = (name, parent) => all.find((f) => f.name === name && (parent === undefined || (f.parents || []).includes(parent)));
    const root = child('מעקב אבני חן'); if (!root) return null;
    const trips = child('trips', root.id); if (!trips) return null;
    const one = child(trip, trips.id); if (!one) return null;
    return (child('certificates', one.id) || {}).id || null;
  }, tripName);

  test('a photo is filed under trips/<trip name>/certificates', async ({ page }) => {
    await seed(page);                                   // seeded trip is called "Test trip"
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await page.locator('.cert-add').first().click();
    await page.locator('.cert-cell input[type=file]').first()
      .setInputFiles({ name: 'gia.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });

    await expect.poll(async () => certFolderId(page, 'Test trip')).not.toBeNull();
    const folder = await certFolderId(page, 'Test trip');
    const photo = await page.evaluate(() => Object.values(window.__drive.files).find((f) => /^cert_/.test(f.name || '')));
    expect(photo.parents).toEqual([folder]);
  });

  test('a device that is already connected sorts its photos on the next load', async ({ page }) => {
    const remote = remoteFile('2099-01-01T00:00:00.000Z', 'ספק');
    remote.state.trips[0].name = 'נסיעת אוגוסט';
    remote.state.trips[0].vendors[0].rows[0].cert = 'cert_old01.jpg';
    await seed(page);
    await stubDrive(page, remote, { 'cert_old01.jpg': 'PRETEND-JPEG-BYTES' });
    page.on('dialog', (d) => d.accept());
    await open(page);
    // connect the way an older build did, without any tidy-up
    await page.evaluate(async () => {
      await driveAuth(true);
      const f = await driveFindFile();
      driveFileId = f.id; driveOn = true;
      await idbSet('drive', { fileId: driveFileId });
      await drivePull(true);
    });
    expect(await page.evaluate(() => driveFindByName('cert_old01.jpg', 'id,parents').then((f) => f.parents))).toEqual([]);

    await open(page);                                   // just reopening the app must sort it out
    await expect.poll(async () => certFolderId(page, 'נסיעת אוגוסט')).not.toBeNull();
    const folder = await certFolderId(page, 'נסיעת אוגוסט');
    await expect.poll(async () => (await driveFile(page, 'cert_old01.jpg')).parents).toEqual([folder]);
  });

  test('photos already loose in Drive are moved into the trip folder on connect', async ({ page }) => {
    // what an older version left behind: the photo sits in the top-level folder
    const remote = remoteFile('2099-01-01T00:00:00.000Z', 'ספק');
    remote.state.trips[0].name = 'נסיעת אוגוסט';
    remote.state.trips[0].vendors[0].rows[0].cert = 'cert_old01.jpg';
    await seed(page);
    await stubDrive(page, remote, { 'cert_old01.jpg': 'PRETEND-JPEG-BYTES' });
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());

    await expect.poll(async () => certFolderId(page, 'נסיעת אוגוסט')).not.toBeNull();
    const folder = await certFolderId(page, 'נסיעת אוגוסט');
    await expect.poll(async () => (await driveFile(page, 'cert_old01.jpg')).parents).toEqual([folder]);
  });

  test("a trip name with an apostrophe doesn't break the Drive query", async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await page.evaluate(() => { state.trips[0].name = "Dad's trip"; save(); });
    await page.locator('.cert-add').first().click();
    await page.locator('.cert-cell input[type=file]').first()
      .setInputFiles({ name: 'gia.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
    await expect.poll(async () => certFolderId(page, "Dad's trip")).not.toBeNull();
  });

  test('a dated backup is written on open, without waiting for an edit', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await open(page);                                   // reopen and touch nothing

    const listBackups = () => page.evaluate(() => {
      const all = Object.values(window.__drive.files);
      const child = (name, parent) => all.find((f) => f.name === name && (parent === undefined || (f.parents || []).includes(parent)));
      const root = child('מעקב אבני חן'); if (!root) return null;
      const folder = child('backups', root.id); if (!folder) return null;
      return all.filter((f) => (f.parents || []).includes(folder.id)).map((f) => f.name);
    });
    await expect.poll(listBackups).not.toBeNull();
    const names = await listBackups();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^gemstones_\d{4}-\d{2}-\d{2}\.json$/);
  });

  test('a dated backup is written into the Drive backups folder', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await page.evaluate(() => driveBackupToday());

    const backups = await page.evaluate(() => {
      const all = Object.values(window.__drive.files);
      const child = (name, parent) => all.find((f) => f.name === name && (parent === undefined || (f.parents || []).includes(parent)));
      const root = child('מעקב אבני חן'), folder = child('backups', root.id);
      return all.filter((f) => (f.parents || []).includes(folder.id)).map((f) => f.name);
    });
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^gemstones_\d{4}-\d{2}-\d{2}\.json$/);
  });

  test('restoring a Drive backup pushes it, so the other device follows', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());

    // connectDrive() writes today's backup in the background, creating the backups
    // folder on its way. Wait for that to land before planting an older backup:
    // otherwise the background create replaces the folder this test just made, and
    // the planted file is left parented to an id nothing owns.
    const isBackup = /^gemstones_\d{4}-\d{2}-\d{2}\.json$/;
    await expect.poll(() => page.evaluate((re) => Object.values(window.__drive.files)
      .some((f) => new RegExp(re).test(f.name || '')), isBackup.source)).toBe(true);

    // a backup from an earlier day, holding a vendor the current data no longer has,
    // filed in the same folder the app itself uses
    await page.evaluate((re) => {
      const old = { app: 'gemstone-tracker', savedAt: '2026-01-02T00:00:00.000Z',
        state: { currency: '$', savedAt: '2026-01-02T00:00:00.000Z', activeTripId: 't1', trips: [{ id: 't1', name: 'Old trip', date: '2026-01-02', activeId: 'v1',
          vendors: [{ id: 'v1', name: 'ספק שנמחק', code: 'AB', rows: [{ serial: 'AB-01', weight: '9', stones: '1', shape: '', cost: '', cert: '', notes: '' }] }] }] } };
      const folder = Object.values(window.__drive.files).find((f) => new RegExp(re).test(f.name || '')).parents[0];
      window.__drive.files['gemstones_2026-01-02.json@' + folder] =
        { id: 'b1', name: 'gemstones_2026-01-02.json', parents: [folder], modifiedTime: 't0', body: JSON.stringify(old) };
    }, isBackup.source);

    // that day shows up in the restore list even though this device never saw it
    const days = await page.evaluate(async () => (await restorableDays()).map((r) => r.day));
    expect(days).toContain('2026-01-02');
    await page.evaluate(() => restoreSnapshot('2026-01-02'));

    // restored locally...
    expect(await page.evaluate(() => state.trips[0].vendors[0].name)).toBe('ספק שנמחק');
    // ...and pushed, so the other device pulls the restore rather than undoing it
    await expect.poll(async () => (await driveBody(page)).state.trips[0].vendors[0].name).toBe('ספק שנמחק');
  });

  // a Drive listing that fails must not look like "there are no cloud backups"
  test('an unreadable Drive is admitted in the restore dialog, not hidden', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    // one local snapshot, so there is a real list to show alongside the warning
    await page.evaluate(async () => { await snapPut({ day: '2026-02-03', ts: '2026-02-03T00:00:00.000Z', data: JSON.parse(JSON.stringify(state)) }); });

    // the backups listing now fails the way a dropped connection would. Only the
    // "everything inside this folder" query is broken; folder lookups still work.
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (u, o) => {
        const s = decodeURIComponent(String((u && u.url) || u));
        return (s.includes('/drive/v3/files?') && s.includes('in parents') && !s.includes('name='))
          ? Promise.reject(new Error('offline')) : real(u, o);
      };
    });

    await page.evaluate(() => openRestore());
    const box = page.locator('#rstOverlay');
    await expect(box).toContainText('לא הצלחנו לקרוא את הגיבויים');
    await expect(box).toContainText('2026-02-03');            // local versions still offered
    expect(await page.evaluate(() => driveBackupsUnread)).toBe(true);

    // and when Drive reads fine, no warning is shown
    await page.evaluate(() => closeRestore());
    await page.reload();
    await page.evaluate(() => openRestore());
    await expect(page.locator('#rstOverlay')).not.toContainText('לא הצלחנו לקרוא את הגיבויים');
  });

  test('a local edit is pushed to Drive automatically', async ({ page }) => {
    await seed(page);
    await stubDrive(page, null);
    page.on('dialog', (d) => d.accept());
    await open(page);
    await page.evaluate(() => connectDrive());
    await page.locator('tbody tr').first().locator('input.num').nth(0).fill('3.5');
    await expect.poll(async () => (await driveBody(page)).state.trips[0].vendors[0].rows[0].weight).toBe('3.5');
  });
});
