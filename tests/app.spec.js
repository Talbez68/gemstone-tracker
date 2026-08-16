import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The whole app is one static HTML file; we drive it over file://.
const APP_URL = pathToFileURL(path.resolve('gemstone-tracker.html')).href;
const STORAGE_KEY = 'gemstone-tracker-v2';

// A tiny valid PNG (2x2) used to exercise the certificate-photo upload path.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAB1zwv1V0j5ZgAAAABJRU5ErkJggg==';

// Seed a known, minimal trip before the app's scripts run, so tests are deterministic.
async function seed(page) {
  await page.addInitScript((key) => {
    const state = {
      currency: '$',
      activeTripId: 't1',
      trips: [{
        id: 't1', name: 'Test trip', date: '2026-07-03', activeId: 'v1',
        vendors: [{
          id: 'v1', name: 'ספק בדיקה', code: 'AB',
          rows: [{ serial: 'AB-01', weight: '', stones: '', shape: '', cost: '', cert: '', notes: '', sale: '', sold: false }],
        }],
      }],
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// --- minimal .xlsx writer, so import tests need no binary fixture on disk -----
// Entries are STORED (no compression), which the app reads without DecompressionStream.
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), size = f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + size;
  }
  const body = Buffer.concat(locals), cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}
// Each sheet: {name, rows} where a row is [מספר, סריה, משקל]. The header row is added here.
const HEADERS = ['מספר', 'סריה', 'משקל', 'מספר אבנים', 'צורה', 'עלות לקראט', 'סה"כ עלות', 'הערות', 'מכירה לקראט', 'סה"כ מכירה', 'נמכר'];
function buildXlsx(sheets) {
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cell = (col, rowNum, text) => (Number.isNaN(Number(text)) || text === ''
    ? `<c r="${col}${rowNum}" t="inlineStr"><is><t>${xmlEsc(text)}</t></is></c>`
    : `<c r="${col}${rowNum}"><v>${xmlEsc(text)}</v></c>`);
  const sheetXml = (rows) => {
    const all = [HEADERS, ...rows];
    const body = all.map((cells, i) => `<row r="${i + 1}">`
      + cells.map((v, c) => cell(String.fromCharCode(65 + c), i + 1, v)).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };
  const files = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows), 'utf8') }));
  files.push({
    name: 'xl/workbook.xml',
    data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>', 'utf8'),
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + '</Relationships>', 'utf8'),
  });
  return zipStore(files);
}

// Collect console errors + uncaught exceptions for every test; a broken app surfaces here.
function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

test.describe('Gemstone tracker', () => {
  test('loads with no JavaScript errors and renders the table', async ({ page }) => {
    const errors = trackErrors(page);
    await seed(page);
    await page.goto(APP_URL);
    await expect(page.locator('table').first()).toBeVisible();
    // header carries the expected Hebrew columns, including the certificate column
    const header = (await page.locator('thead tr').last().locator('th').allInnerTexts()).join('|');
    for (const col of ['סריה', 'משקל', 'צורה', 'תעודה', 'הערות', 'נמכר']) {
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
    const nums = row.locator('input.num'); // order: weight, stones, cost, sale
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
      { name: 'Gemesis', rows: [['1', 'RM-01', '3.6'], ['2', 'RM-02', '5.02'], ['3', 'RG-01', '2.5'], ['4', 'MS-01', '1.43'], ['5', 'MS-02', '3.02']] },
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
    expect(errors, 'no console/page errors during import').toEqual([]);
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
});
