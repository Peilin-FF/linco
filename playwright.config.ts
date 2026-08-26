import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1431',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 1431 --strictPort',
    url: 'http://127.0.0.1:1431/tests/browser/terminal-webgl.html',
    reuseExistingServer: true,
    timeout: 120000
  }
})
