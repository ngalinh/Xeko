const { firefox, webkit } = require('playwright');
const { safeLaunch } = require('../utils/playwright-launch');
const { parseProxy } = require('../utils/proxy');
const logger = require('../utils/logger');
const { extractCategoryProducts } = require('./category-products');

// Chặn SSRF cơ bản: chỉ nhận https, không cổng/thông tin đăng nhập trong URL,
// từ chối hostname nội bộ/private rõ ràng. Không còn giới hạn riêng Macy's —
// người dùng đã chọn chế độ "Theo category" rõ ràng ở UI, không cần suy đoán
// qua hình dạng URL nữa (so với trước đây phải phân biệt category/sản phẩm).
const PRIVATE_HOSTNAME_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?)/i;
function validateCategoryUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Link category không hợp lệ.'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || PRIVATE_HOSTNAME_RE.test(u.hostname)) {
    throw new Error('Link category phải là URL https hợp lệ.');
  }
  u.hash = '';
  return u.href;
}

function homepageOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

function randomDelayMs(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

// Giống launchBrowser của get-deal.js: hỗ trợ Firefox/WebKit trực tiếp qua
// Playwright, Chrome thật qua channel, còn lại dùng wrapper Chromium bundled
// hiện có (safeLaunch tự cài browser thiếu nếu cần).
async function launchBrowser(engine, launchOpts) {
  try {
    if (engine === 'firefox') return await firefox.launch(launchOpts);
    if (engine === 'webkit') return await webkit.launch(launchOpts);
    if (engine === 'chrome') return await safeLaunch({ ...launchOpts, channel: 'chrome' });
    return await safeLaunch(launchOpts);
  } catch (error) {
    if (engine === 'chrome' && /Executable doesn'?t exist|distribution 'chrome' is not found|executable.*not found/i.test(error.message || '')) {
      throw new Error('Không tìm thấy Google Chrome trên máy chạy Xeko. Cài Google Chrome rồi thử lại.', { cause: error });
    }
    if (/Executable doesn'?t exist|Looks like Playwright was just installed/i.test(error.message || '')) {
      throw new Error(`Chưa cài trình duyệt ${engine} trên máy chạy Xeko. Cần chạy lại workflow deploy để cài đủ browser.`, { cause: error });
    }
    throw error;
  }
}

// Macy's co luc chan han 1 engine nhung engine khac lai qua duoc — tu dong
// doi sang Firefox / Chrome that neu engine dang dung bi chan, truoc khi bao
// loi han cho nguoi dung. Giong het co che da dung cho get-deal.js.
const FALLBACK_ENGINES = ['firefox', 'chrome'];

async function getCategory(value, opts = {}) {
  const url = validateCategoryUrl(value);
  const proxy = parseProxy(opts.proxy) || undefined;
  const initialEngine = ['firefox', 'webkit', 'chrome'].includes(opts.engine) ? opts.engine : 'chromium';
  const engines = [initialEngine, ...FALLBACK_ENGINES.filter(e => e !== initialEngine)];
  for (let i = 0; i < engines.length; i++) {
    try {
      return await attemptGetCategory(url, engines[i], proxy);
    } catch (error) {
      if (i === engines.length - 1 || !/bị chặn bot/i.test(error.message || '')) throw error;
      logger.warn(`[get-category] ${url} bị chặn với engine ${engines[i]}, tự đổi sang ${engines[i + 1]}...`);
    }
  }
}

async function attemptGetCategory(url, engine, proxy) {
  const browser = await launchBrowser(engine, { headless: false, proxy });
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 1600 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();
    // Category navigation and redirects stay on the supported public retailer.
    await page.route('**/*', route => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        try { validateCategoryUrl(req.url()); } catch { return route.abort(); }
      }
      return route.continue();
    });

    // Ghe trang chu truoc de co cookie/session giong nguoi dung that roi moi
    // qua trang danh muc — giong het bien phap da dung cho get-deal.js.
    const homepage = homepageOf(url);
    if (homepage && homepage !== url) {
      try {
        await page.goto(homepage, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(randomDelayMs(1500, 3000));
      } catch (e) {
        logger.warn(`[get-category] mở trang chủ thất bại, bỏ qua bước khởi động: ${e.message}`);
      }
    }

    // Thu lai sau 1 khoang nghi ngan neu bi chan — moi lan request duoc cham
    // diem rui ro rieng nen co the qua duoc du lan truoc bi chan.
    let response;
    let status;
    for (let attempt = 1; attempt <= 2; attempt++) {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = response ? response.status() : null;
      if (status === null || (status >= 200 && status < 300)) break;
      if (attempt < 2) {
        logger.warn(`[get-category] ${url} trả về HTTP ${status} ở lần ${attempt}, chờ rồi thử lại...`);
        await page.waitForTimeout(randomDelayMs(15000, 20000));
      }
    }
    if (status !== null && (status < 200 || status >= 300)) {
      throw new Error(`Trang trả HTTP ${status} sau 2 lần thử — có thể bị chặn bot, hãy thử lại sau hoặc kiểm tra proxy trong Cài đặt.`);
    }

    // Best-effort: đợi có ảnh xuất hiện (tín hiệu trang đã tải nội dung) —
    // không còn chờ riêng selector link sản phẩm của Macy's.
    await page.waitForSelector('img', { timeout: 12000 }).catch(() => {});
    const products = new Map();
    let nextUrl = null;
    for (let i = 0; i < 7; i++) {
      if (/access denied|you don.t have permission to access/i.test(await page.locator('body').innerText({ timeout: 5000 }))) throw new Error('Trang đang báo Access Denied — có thể bị chặn bot, hãy thử lại sau hoặc kiểm tra proxy trong Cài đặt.');
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
