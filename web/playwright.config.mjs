import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, actionTimeout: 15000, navigationTimeout: 15000 },
  webServer: {
    command: 'npm run dev -- --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
});
