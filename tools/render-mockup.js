// Render glass-mockup.html → PNG via Playwright (Chromium)
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const url = 'file://' + path.resolve(__dirname, 'glass-mockup.html');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const out = path.resolve(__dirname, 'preview/glass-mockup-desktop.png');
  await page.screenshot({ path: out, fullPage: false });
  console.log('Wrote', out);

  // Mobile version
  await ctx.close();
  const mobileCtx = await browser.newContext({
    viewport: { width: 412, height: 900 },
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobileCtx.newPage();
  await mobilePage.goto(url, { waitUntil: 'networkidle' });
  await mobilePage.waitForTimeout(300);
  const out2 = path.resolve(__dirname, 'preview/glass-mockup-mobile.png');
  await mobilePage.screenshot({ path: out2, fullPage: true });
  console.log('Wrote', out2);

  await browser.close();
})();
