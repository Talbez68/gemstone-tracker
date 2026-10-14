import { defineConfig } from '@playwright/test';

// Drives the real Android app on an emulator (see run.sh). One device, one Chrome,
// so the tests run one after another.
export default defineConfig({
  testDir: '.',
  testMatch: 'twa.spec.js',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
});
