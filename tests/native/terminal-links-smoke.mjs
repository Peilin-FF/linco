// Opt-in: opens the Microsoft page in the system browser using the running dev app.
// Uses its existing native shell plugin; does not download/run any installer.
import { chromium } from '@playwright/test'

if (!process.argv.includes('--open-microsoft')) {
  throw new Error('Pass --open-microsoft to test the native browser handoff explicitly.')
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://localhost:1420/'))
if (!page) throw new Error('The separate development window is not running.')
console.log('Dev window connected:', page.url())
const result = await page.evaluate(async () => {
  const { openExternalUrl } = await import('/src/lib/externalLinks.ts')
  const url = 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'
  if (!window.isTauri) throw new Error('Not a native Tauri window; browser fallback is not a native test.')
  await openExternalUrl(url)
  return { url, native: true, result: 'Native browser-opening request completed' }
})
console.log(JSON.stringify(result))
// Disconnect without closing the user's dev window or its browser.
process.exit(0)
