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

// --- fake Google Drive -------------------------------------------------------
// Stubs the GIS token client and the Drive REST endpoints in-page, so the sync
// logic is exercised for real without a Google login. `seedRemote` is the file
// already sitting in Drive, or null for "no file yet".
async function stubDrive(page, seedRemote, seedCerts) {
  await page.addInitScript(([remote, certs]) => {
    window.google = { accounts: { oauth2: { initTokenClient: (cfg) => ({
      callback: cfg.callback,
      requestAccessToken() { const cb = this.callback; setTimeout(() => cb({ access_token: 'tok', expires_in: 3600 }), 0); },
    }) } } };

    // files keyed by name, the way Drive is queried here
    const D = window.__drive = { files: {}, n: 1, uploads: 0, deleted: [] };
    const stamp = () => 't' + D.n++;
    if (remote) D.files['gemstones.json'] = { id: 'file1', modifiedTime: 't0', body: JSON.stringify(remote), webViewLink: 'https://drive.google.com/file/d/file1/view' };
    Object.entries(certs || {}).forEach(([n, body], i) => { D.files[n] = { id: 'cert' + i, modifiedTime: 't0', body }; });
    const byId = (id) => Object.values(D.files).find((f) => f.id === id);
    const qName = (u) => { const m = decodeURIComponent(u).match(/name='([^']+)'/); return m && m[1]; };

    const realFetch = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, opts = {}) => {
      const u = String((url && url.url) || url);
      if (!u.startsWith('https://www.googleapis.com/')) return realFetch(url, opts);
      const raw = async () => (opts.body instanceof Blob ? opts.body.text() : String(opts.body || ''));

      if (/\/upload\/drive\/v3\/files\?/.test(u)) {                     // create (multipart)
        const body = await raw();
        const meta = JSON.parse(body.slice(body.indexOf('\r\n\r\n') + 4, body.indexOf('\r\n--', body.indexOf('\r\n\r\n'))));
        D.files[meta.name] = { id: 'id' + D.n, modifiedTime: stamp(), parent: (meta.parents || [])[0],
          body: body.slice(body.lastIndexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--')) };
        D.uploads++;
        return json({ id: D.files[meta.name].id, modifiedTime: D.files[meta.name].modifiedTime, webViewLink: 'https://drive.google.com/file/d/' + D.files[meta.name].id + '/view' });
      }
      if (/\/upload\/drive\/v3\/files\//.test(u)) {                     // update (raw media)
        const f = byId(u.match(/files\/([^?]+)/)[1]);
        f.body = await raw(); f.modifiedTime = stamp(); D.uploads++;
        return json({ id: f.id, modifiedTime: f.modifiedTime });
      }
      if (/\/drive\/v3\/files\?/.test(u)) {
        if ((opts.method || 'GET') === 'POST') {                          // create a folder
          const meta = JSON.parse(await raw());
          D.files[meta.name] = { id: 'folder1', modifiedTime: stamp(), mimeType: meta.mimeType };
          return json({ id: 'folder1' });
        }
        const name = qName(u), f = name && D.files[name];
        return json({ files: f ? [{ id: f.id, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink }] : [] });
      }
      const idm = u.match(/\/drive\/v3\/files\/([^?]+)/);
      if (idm) {
        const f = byId(idm[1]);
        if ((opts.method || 'GET') === 'DELETE') { D.deleted.push(idm[1]); delete D.files[Object.keys(D.files).find((k) => D.files[k] === f)]; return json({}); }
        if (u.includes('alt=media')) return new Response(f.body, { status: 200 });
        return json({ modifiedTime: f.modifiedTime });
      }
      return json({});
    };
  }, [seedRemote || null, seedCerts || null]);
}
// A remote file body: the app's wrapper around a state carrying one named vendor.
function remoteFile(savedAt, vendorName) {
  return {
    app: 'gemstone-tracker', savedAt,
    state: { currency: '$', savedAt, activeTripId: 't1', trips: [{
      id: 't1', name: 'Remote trip', date: '2026-07-03', activeId: 'v9',
      vendors: [{ id: 'v9', name: vendorName, code: 'ZZ', rows: [{ serial: 'ZZ-01', weight: '1.5', stones: '1', shape: '', cost: '', cert: '', notes: '', sale: '', sold: false }] }],
    }] },
  };
}
const driveBody = (page) => page.evaluate(() => JSON.parse(window.__drive.files['gemstones.json'].body));

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

  test('already-imported float noise is cleaned up on load', async ({ page }) => {
    await page.addInitScript((key) => {
      const row = (over) => ({ serial: 'AB-01', weight: '', stones: '1', shape: '', cost: '', cert: '', notes: '', sale: '', sold: false, ...over });
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
          vendors: [{ id: 'v1', name: 'ספק חדש יותר', code: 'AB', rows: [{ serial: 'AB-01', weight: '2', stones: '1', shape: '', cost: '', cert: '', notes: '', sale: '', sold: false }] }] }],
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
      window.__drive.files['gemstones.json'].body = JSON.stringify({ app: 'gemstone-tracker', savedAt: '2099-01-01T00:00:00.000Z',
        state: { currency: '$', savedAt: '2099-01-01T00:00:00.000Z', activeTripId: 't1', trips: [{ id: 't1', name: 'From phone', date: '2026-07-03', activeId: 'v9',
          vendors: [{ id: 'v9', name: 'ספק מהטלפון', code: 'ZZ', rows: [{ serial: 'ZZ-01', weight: '1', stones: '1', shape: '', cost: '', cert: '', notes: '', sale: '', sold: false }] }] }] } });
      window.__drive.files['gemstones.json'].modifiedTime = 'tPhone';
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
    const drive = await page.evaluate(() => window.__drive.files);
    expect(drive['מעקב אבני חן'].mimeType).toBe('application/vnd.google-apps.folder');
    expect(drive['gemstones.json'].parent).toBe('folder1');
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
      page.evaluate(() => Object.entries(window.__drive.files).filter(([n, f]) => /^cert_/.test(n) && f.parent === 'folder1').length),
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
    await page.evaluate(() => { window.__drive.files['cert_late01.jpg'] = { id: 'late1', modifiedTime: 't9', body: 'PRETEND-JPEG-BYTES' }; });
    await expect(page.locator('img.cert-thumb').first()).toBeVisible({ timeout: 15000 });
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
