import { defineConfig } from '@playwright/test'
import config from './playwright.config'

// Run after demo:build with Vite preview listening on port 1433.
export default defineConfig({
  ...config,
  use: { ...config.use, baseURL: 'http://127.0.0.1:1433' },
  webServer: undefined,
})
