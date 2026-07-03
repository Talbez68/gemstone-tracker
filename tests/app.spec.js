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
