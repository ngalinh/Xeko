// Run after npm --prefix server ci: node scripts/test-navigation.cjs
// Uses isolated, mocked HTTP responses; never contacts production or signs anyone out.
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = createRequire(path.resolve(__dirname, '../server/package.json'))('playwright');
const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(match[1])) new vm.Script(match[2]);
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'xeko.test') return route.abort();
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      if (url.pathname === '/api/me') {
        return route.fulfill({ json: { success: true, email: 'tram@gmail.com', isXekoAdmin: true } });
      }
      if (url.pathname.includes('/api/')) {
        return route.fulfill({ json: { success: true, profiles: [], accounts: [], channels: [], data: [], rows: [], history: [], stats: {}, total: 0 } });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await context.newPage();
    await page.goto('https://xeko.test/');
    await page.locator('.page.active .header #accountTrigger').waitFor();
    const sidebar = page.locator('#appSidebar');
    const width = async () => Math.round((await sidebar.boundingBox()).width);
    assert.ok(await width() > 200);
    await page.locator('#sidebarToggle').click();
    await page.waitForFunction(() => Math.round(document.getElementById('appSidebar').getBoundingClientRect().width) === 72);
    assert.equal(await width(), 72);
    assert.equal(await page.locator('#navDashboard').getAttribute('aria-label'), 'Dashboard');
    await page.reload();
    await page.locator('.page.active #accountTrigger').waitFor();
    await page.waitForFunction(() => Math.round(document.getElementById('appSidebar').getBoundingClientRect().width) === 72);
    assert.equal(await width(), 72, 'desktop preference survives reload');
    await page.locator('#accountTrigger').click();
    assert.equal(await page.locator('#accountMenu').isVisible(), true);
    assert.equal(await page.getByRole('link', { name: /Trở về/ }).getAttribute('href'), 'https://ai.basso.vn/');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#accountMenu').isVisible(), false);
    await page.locator('#navGuide').click();
    assert.equal(await page.locator('#pageGuide > .header #accountTrigger').count(), 1);
    await page.locator('#accountTrigger').click();
    await page.locator('#pageGuide .guide-hero').click();
    assert.equal(await page.locator('#accountMenu').isVisible(), false);
    await page.locator('#navDashboard').click();
    if (process.env.NAV_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.NAV_SCREENSHOT_DIR, 'desktop-collapsed.png') });

    for (const mobileWidth of [390, 320, 768]) {
      await page.setViewportSize({ width: mobileWidth, height: 844 });
      await page.waitForFunction(() => document.getElementById('appSidebar').inert);
      assert.equal(await sidebar.evaluate(el => el.inert), true);
      assert.equal(await page.locator('.page.active #accountTrigger').isVisible(), true);
      await page.locator('.page.active .mobile-hamburger').click();
      assert.equal(await sidebar.evaluate(el => el.inert), false);
      assert.equal(await page.locator('.main-content').evaluate(el => el.inert), true);
      await page.locator('#sidebarToggle').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#navDashboard').evaluate(el => el === document.activeElement), true, 'drawer traps keyboard focus');
      await page.locator('#sidebarToggle').click();
      assert.equal(await sidebar.evaluate(el => el.inert), true);
      await page.locator('.page.active .mobile-hamburger').click();
      await page.keyboard.press('Escape');
      assert.equal(await sidebar.evaluate(el => el.inert), true);
      await page.locator('#accountTrigger').click();
      const bounds = await page.locator('#accountMenu').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= mobileWidth, 'account dropdown fits viewport');
      assert.equal(await page.locator('#accountMenuEmail').textContent(), 'tram@gmail.com');
      if (process.env.NAV_SCREENSHOT_DIR && mobileWidth === 390) await page.screenshot({ path: path.join(process.env.NAV_SCREENSHOT_DIR, 'mobile-account.png') });
      await page.keyboard.press('Escape');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page horizontal overflow');
      const chart = await page.locator('.dash-2col').boundingBox();
      assert.ok(chart.x + chart.width <= mobileWidth, 'chart fits mobile viewport');
      await page.locator('.page.active .mobile-hamburger').click();
      await page.locator('#navPost').click();
      assert.equal(await page.locator('#pageDangBai > .header #accountTrigger').isVisible(), true);
      await page.locator('.page.active .mobile-hamburger').click();
      await page.locator('#navDashboard').click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Math.round(document.getElementById('appSidebar').getBoundingClientRect().width) === 72);
    assert.equal(await width(), 72, 'mobile drawer does not overwrite desktop preference');
    await page.locator('#sidebarToggle').click();
    await page.waitForFunction(() => document.getElementById('appSidebar').getBoundingClientRect().width > 200);
    await page.locator('#accountTrigger').click();
    if (process.env.NAV_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.NAV_SCREENSHOT_DIR, 'desktop-account.png') });
    await page.evaluate(() => applyAuthUI({email: 'viewer@example.com', isXekoAdmin: false}));
    assert.equal(await page.locator('#navPermissions').isVisible(), false, 'permission-controlled navigation stays hidden');
    await context.close();
    console.log('PASS: inline JS syntax, desktop collapse/persistence, page navigation, account menu, mobile drawer and responsive widths 320/390/768.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
