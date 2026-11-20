const { firefox, webkit } = require('playwright');
const { safeLaunch } = require('../utils/playwright-launch');
const { parseProxy } = require('../utils/proxy');
const { extractCategoryProducts } = require('./category-products');

function validateCategoryUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Link category không hợp lệ.'); }
  if (u.protocol !== 'https:' || !['www.macys.com', 'macys.com'].includes(u.hostname) || u.port || u.username || u.password || !u.pathname.startsWith('/shop/') || u.pathname.startsWith('/shop/product/')) {
    throw new Error('Bản thử hỗ trợ link category HTTPS của Macy’s (/shop/...), không phải link sản phẩm.');
  }
  u.hash = '';
  return u.href;
}
async function getCategory(value, opts = {}) {
  const url = validateCategoryUrl(value);
  const launch = opts.engine === 'firefox' ? o => firefox.launch(o) : opts.engine === 'webkit' ? o => webkit.launch(o) : safeLaunch;
  const browser = await launch({ headless: false, proxy: parseProxy(opts.proxy) || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 1600 }, locale: 'en-US', timezoneId: 'America/New_York' });
    const page = await context.newPage();
    // Category navigation and redirects stay on the supported public retailer.
    await page.route('**/*', route => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        try { validateCategoryUrl(req.url()); } catch { return route.abort(); }
      }
      return route.continue();
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && !response.ok()) throw new Error('Macy’s trả HTTP ' + response.status() + '. Hãy thử lại sau hoặc kiểm tra proxy trong Cài đặt.');
    await page.waitForSelector('a[href*="/shop/product/"]', { timeout: 12000 }).catch(() => {});
    const products = new Map();
    let nextUrl = null;
    for (let i = 0; i < 7; i++) {
      if (/access denied|you don.t have permission to access/i.test(await page.locator('body').innerText({ timeout: 5000 }))) throw new Error('Macy’s đang báo Access Denied. Hãy thử lại sau hoặc kiểm tra proxy trong Cài đặt.');
      const data = await page.evaluate(extractCategoryProducts);
      data.products.forEach(p => products.set(p.id, p));
      if (data.nextUrl) {
        try { nextUrl = validateCategoryUrl(data.nextUrl); } catch {}
      }
      if (products.size >= 120) break;
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(700);
    }
    if (!products.size) throw new Error('Chưa tìm thấy sản phẩm có thumbnail. Trang có thể chưa tải xong, bị chặn hoặc đã đổi cấu trúc.');
    return { products: [...products.values()].slice(0, 120), nextUrl: nextUrl === url ? null : nextUrl, url };
  } finally { await browser.close(); }
}
module.exports = { getCategory, validateCategoryUrl };
