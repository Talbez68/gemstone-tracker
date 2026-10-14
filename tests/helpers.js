// Shared test helpers: the fake app state, a minimal .xlsx writer, and a fake
// Google Drive. Used by the desktop suite and the phone suite alike.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The whole app is one static HTML file; we drive it over file://.
export const APP_URL = pathToFileURL(path.resolve('gemstone-tracker.html')).href;
export const STORAGE_KEY = 'gemstone-tracker-v2';

// A tiny valid PNG (2x2) used to exercise the certificate-photo upload path.
export const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAB1zwv1V0j5ZgAAAABJRU5ErkJggg==';

// Seed a known, minimal trip before the app's scripts run, so tests are deterministic.
// With once, a reload keeps what the test did instead of re-seeding (an app restart).
export async function seed(page, { once = false } = {}) {
  await page.addInitScript(([key, once]) => {
    if (once && sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    const state = {
      currency: '$',
      activeTripId: 't1',
      trips: [{
        id: 't1', name: 'Test trip', date: '2026-07-03', activeId: 'v1',
        vendors: [{
          id: 'v1', name: 'ספק בדיקה', code: 'AB',
          rows: [{ serial: 'AB-01', weight: '', stones: '', shape: '', cost: '', cert: '', notes: '' }],
        }],
      }],
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, [STORAGE_KEY, once]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
export function buildXlsx(sheets) {
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
export async function stubDrive(page, seedRemote, seedCerts) {
  await page.addInitScript(([remote, certs]) => {
    window.google = { accounts: { oauth2: { initTokenClient: (cfg) => ({
      callback: cfg.callback,
      requestAccessToken() { window.__drive.authCalls++; const cb = this.callback; setTimeout(() => cb({ access_token: 'tok', expires_in: 3600 }), 0); },
    }) } } };

    // files keyed by name, the way Drive is queried here. Kept in sessionStorage so
    // the fake Drive survives a page reload, the way the real one would.
    const kept = JSON.parse(sessionStorage.getItem('__fakeDrive') || 'null');
    const D = window.__drive = kept || { files: {}, n: 1, uploads: 0, deleted: [] };
    D.authCalls = 0;                                  // per page load, not persisted
    // window.__driveShared (a test-side binding) lets two devices share one Drive
    const keep = () => {
      const snap = JSON.stringify({ files: D.files, n: D.n, uploads: D.uploads, deleted: D.deleted });
      sessionStorage.setItem('__fakeDrive', snap);
      if (window.__driveShared) window.__driveShared('save', snap);
    };
    const stamp = () => { const t = 't' + D.n++; keep(); return t; };
    if (!kept) {
      if (remote) D.files['gemstones.json@'] = { id: 'file1', name: 'gemstones.json', modifiedTime: 't0', parents: [], body: JSON.stringify(remote), webViewLink: 'https://drive.google.com/file/d/file1/view' };
      Object.entries(certs || {}).forEach(([n, body], i) => { D.files[n + '@'] = { id: 'cert' + i, name: n, modifiedTime: 't0', parents: [], body }; });
      if (!window.__driveShared) keep();               // a shared Drive is seeded by the test, not by each device
    }
    const byId = (id) => Object.values(D.files).find((f) => f.id === id);
    const qName = (u) => { const m = decodeURIComponent(u).match(/name='((?:[^'\\]|\\.)*)'/); return m && m[1].replace(/\\(.)/g, '$1'); };
    const key = (name, parent) => name + '@' + (parent || '');

    const realFetch = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, opts = {}) => {
      const u = String((url && url.url) || url);
      if (!u.startsWith('https://www.googleapis.com/')) return realFetch(url, opts);
      if (window.__driveShared) {                         // see what the other device wrote
        const s = await window.__driveShared('load');
        if (s) { const o = JSON.parse(s); D.files = o.files; D.n = o.n; D.uploads = o.uploads; D.deleted = o.deleted; }
      }
      const raw = async () => (opts.body instanceof Blob ? opts.body.text() : String(opts.body || ''));

      if (/\/upload\/drive\/v3\/files\?/.test(u)) {                     // create (multipart)
        const body = await raw();
        const meta = JSON.parse(body.slice(body.indexOf('\r\n\r\n') + 4, body.indexOf('\r\n--', body.indexOf('\r\n\r\n'))));
        const k = key(meta.name, (meta.parents || [])[0]);
        D.files[k] = { id: 'id' + D.n, name: meta.name, modifiedTime: stamp(), parents: meta.parents || [],
          body: body.slice(body.lastIndexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--')) };
        if (opts.body instanceof Blob) {                // keep the exact bytes too, so a photo survives the trip
          const bytes = new Uint8Array(await opts.body.arrayBuffer());
          const bin = Array.from(bytes, (c) => String.fromCharCode(c)).join('');
          D.files[k].b64 = btoa(bin.slice(bin.lastIndexOf('\r\n\r\n') + 4, bin.lastIndexOf('\r\n--'))); keep();
        }
        D.uploads++; keep();
        return json({ id: D.files[k].id, modifiedTime: D.files[k].modifiedTime, webViewLink: 'https://drive.google.com/file/d/' + D.files[k].id + '/view' });
      }
      if (/\/upload\/drive\/v3\/files\//.test(u)) {                     // update (raw media)
        const f = byId(u.match(/files\/([^?]+)/)[1]);
        f.body = await raw(); f.modifiedTime = stamp(); D.uploads++; keep();
        return json({ id: f.id, modifiedTime: f.modifiedTime });
      }
      if (/\/drive\/v3\/files\?/.test(u)) {
        if ((opts.method || 'GET') === 'POST') {                          // create a folder
          const meta = JSON.parse(await raw());
          const id = 'fold' + D.n;
          D.files[key(meta.name, (meta.parents || [])[0])] = { id, name: meta.name, modifiedTime: stamp(), mimeType: meta.mimeType, parents: meta.parents || [] };
          keep();
          return json({ id });
        }
        // a query may name a file, or just ask for everything inside a folder
        const q = decodeURIComponent(u), name = qName(u);
        const parent = (q.match(/'([^']+)' in parents/) || [])[1];
        const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
        const hits = Object.values(D.files).filter((f) => (name == null || (f.name || '') === name)
          && (!parent || (f.parents || []).includes(parent))
          && (!wantFolder || f.mimeType === 'application/vnd.google-apps.folder'));
        return json({ files: hits.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink, parents: f.parents || [] })) });
      }
      const idm = u.match(/\/drive\/v3\/files\/([^?]+)/);
      if (idm) {
        const f = byId(idm[1]);
        if ((opts.method || 'GET') === 'DELETE') { D.deleted.push(idm[1]); delete D.files[Object.keys(D.files).find((k) => D.files[k] === f)]; keep(); return json({}); }
        if ((opts.method || 'GET') === 'PATCH' && /addParents=/.test(u)) {       // move
          f.parents = [decodeURIComponent(u.match(/addParents=([^&]+)/)[1])]; keep();
          return json({ id: f.id });
        }
        if (u.includes('alt=media')) return new Response(f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.body, { status: 200 });
        return json({ modifiedTime: f.modifiedTime });
      }
      return json({});
    };
  }, [seedRemote || null, seedCerts || null]);
}
// A remote file body: the app's wrapper around a state carrying one named vendor.
export function remoteFile(savedAt, vendorName) {
  return {
    app: 'gemstone-tracker', savedAt,
    state: { currency: '$', savedAt, activeTripId: 't1', trips: [{
      id: 't1', name: 'Remote trip', date: '2026-07-03', activeId: 'v9',
      vendors: [{ id: 'v9', name: vendorName, code: 'ZZ', rows: [{ serial: 'ZZ-01', weight: '1.5', stones: '1', shape: '', cost: '', cert: '', notes: '' }] }],
    }] },
  };
}
export const driveFile = (page, name) => page.evaluate((n) => Object.values(window.__drive.files).find((f) => f.name === n), name);
export const driveBody = async (page) => JSON.parse((await driveFile(page, 'gemstones.json')).body);

// Pick a menu item the way he would: on a phone the menu is a drawer behind ☰.
export async function menu(page, selector) {
  if (await page.evaluate(() => matchMedia('(max-width:900px)').matches)) await page.locator('#menuToggle').click();
  await page.locator(selector).click();
}

// Collect console errors + uncaught exceptions for every test; a broken app surfaces here.
export function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}


// Serve the repo over http://localhost, so Drive sync (which refuses file://) can run.
export async function startServer() {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const server = http.createServer((req, res) => {
    const file = req.url.split('?')[0] === '/' ? '/gemstone-tracker.html' : req.url.split('?')[0];
    try {
      const body = fs.readFileSync(path.resolve('.' + decodeURIComponent(file)));
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json'
        : file.endsWith('.png') ? 'image/png' : 'text/html';
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    } catch { res.writeHead(404); res.end('no'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://localhost:${server.address().port}` };
}
