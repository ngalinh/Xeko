const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const url = 'file://' + path.resolve(__dirname, 'glass-mockup-v2.html');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  const out = path.resolve(__dirname, 'preview/glass-mockup-v2-desktop.png');
  await page.screenshot({ path: out });
  console.log('Wrote', out);
  await browser.close();
})();
