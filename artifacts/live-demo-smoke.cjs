const { chromium, expect } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto('https://peilin-ff.github.io/linco/');
    expect(response.status()).toBe(200);
    const basil = page.getByRole('button', { name: 'Water Basil', exact: true });
    await expect(basil).toBeVisible({ timeout: 60000 });
    for (let i = 0; i < 3; i++) await basil.click();
    await expect(basil).toContainText('In bloom!');
    await page.getByRole('button', { name: 'Add a sunflower', exact: false }).click();
    await page.locator('#agent-composer').press('Enter');
    await expect(page.getByRole('button', { name: 'Water Sunflower', exact: true })).toBeVisible();
    await page.locator('.demo-turn-review summary').click();
    await expect(page.getByRole('region', { name: 'This-turn diff for src/garden.json' }).locator('.bg-diff-added')).toContainText(['Lavender', 'Sunflower']);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.locator('[data-file-entry="README.md"]').click();
    await expect(page.locator('[data-workspace-view="files"] .cm-content[contenteditable="true"]:visible')).toContainText('# Pocket Garden');
    await page.locator('[data-file-entry="package.json"]').click();
    await expect(page.locator('[data-workspace-view="files"] .cm-content[contenteditable="true"]:visible')).toContainText('pocket-garden-demo');
    for (const path of ['social-preview.png', 'sitemap.xml']) {
      const asset = await page.request.get('https://peilin-ff.github.io/linco/' + path);
      expect(asset.status()).toBe(200);
    }
    expect(errors).toEqual([]);
    console.log('PASS: live page, garden interaction, scripted agent, social image, sitemap, and no browser errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
