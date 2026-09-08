import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '../tests/demo',
  timeout: 180000,
  workers: 1,
  outputDir: '../test-results/public-demo',
  use: { baseURL: process.env.LINCO_DEMO_TEST_URL || 'http://127.0.0.1:1432', channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: process.env.LINCO_DEMO_TEST_URL ? undefined : { command: 'npm run demo:dev', cwd: '..', url: 'http://127.0.0.1:1432', reuseExistingServer: true, timeout: 120000 },
})
