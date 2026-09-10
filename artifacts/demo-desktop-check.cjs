const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    page.on('requestfailed', request => console.log('REQUEST FAILED', request.url(), request.failure()));
    await page.goto('http://127.0.0.1:1431/tests/browser/workbench.html?files');
    await page.getByRole('button', { name: 'Code', exact: true }).waitFor({ timeout: 20000 });
    console.log('Desktop fixture loaded.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
