import { defineConfig, devices } from '@playwright/test';

// The app is a single static HTML file opened over file:// — no dev server needed.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // PW_EXECUTABLE lets a local machine reuse a pre-installed Chromium; CI leaves it
  // unset and uses the browser installed by `npx playwright install`.
  use: {
    headless: true,
    trace: 'on-first-retry',
    launchOptions: process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
