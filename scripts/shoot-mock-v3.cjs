// Screenshot helper for the v3 sparse minimalist mock (not an app gate).
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const file = 'file:///' + path.resolve('design/mock-redesign-v3/index.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(file);
  await page.waitForTimeout(600);
  await page.locator('.app').screenshot({ path: 'design/mock-redesign-v3/v3-analyze-1440.png' });
  await page.click('#tChat');
  await page.waitForTimeout(400);
  await page.locator('.app').screenshot({ path: 'design/mock-redesign-v3/v3-chat-1440.png' });
  await page.click('#tAnalyze');
  await page.click('#t800');
  await page.waitForTimeout(400);
  await page.locator('.app').screenshot({ path: 'design/mock-redesign-v3/v3-analyze-800.png' });
  await page.click('.modeswitch button[data-m="ai"]');
  await page.waitForTimeout(400);
  await page.locator('.app').screenshot({ path: 'design/mock-redesign-v3/v3-analyze-800-ai.png' });
  await browser.close();
  console.log('v3 shots done');
})().catch((e) => { console.error(e); process.exit(1); });
