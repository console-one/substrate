import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — UI smoke + cut-D verification.
 *
 * Tests boot the contextgraph server in-process per spec (no global
 * webServer) so each test gets a fresh DB and an isolated port.
 */

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 5_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
