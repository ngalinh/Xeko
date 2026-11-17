const path = require('path');
const fs = require('fs');
const { safeLaunch } = require('../utils/playwright-launch');
const { parseProxy } = require('../utils/proxy');
const logger = require('../utils/logger');

const DEAL_SCREENSHOT_DIR = path.resolve(__dirname, '../../logs/deals');

function ensureDealDir() {
  if (!fs.existsSync(DEAL_SCREENSHOT_DIR)) {
    fs.mkdirSync(DEAL_SCREENSHOT_DIR, { recursive: true });
  }
}

// Selector giá phổ biến trên web bán lẻ (Macy's và tương tự) — thử lần lượt,
// selector nào match trước (có số trong text) thì dùng.
const PRICE_SELECTORS = [
  '[data-testid="product-price"]',
  '[data-auto="price-sales"]',
  '.price-sales',
  '[class*="price"]',
];

async function extractPrice(page) {
  for (const selector of PRICE_SELECTORS) {
    try {
      const text = await page.locator(selector).first().innerText({ timeout: 2000 });
      if (text && /\d/.test(text)) return text.trim();
    } catch {
      // selector không có trên trang này — thử selector tiếp theo
    }
  }
  return null;
}

function randomDelayMs(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function homepageOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

// Mở 1 URL sản phẩm, chụp screenshot + đọc giá hiển thị trên trang.
// Không cần profile/login — mỗi lần chạy mở browser riêng.
//
// Các web bán lẻ lớn (Macy's...) dùng bot-management (Akamai/PerimeterX) hay
// chặn request tới thẳng 1 trang sản phẩm mà không có cookie/session/referrer
// nào trước đó, và hay phát hiện được Chrome chạy headless. Để giảm khả năng
// bị chặn: chạy headed (không phải headless), set locale/timezone Mỹ, và ghé
// trang chủ trước để có cookie/session giống người dùng thật rồi mới qua
// trang sản phẩm — không đảm bảo luôn qua được (bot-management ngày càng
// tinh vi), nhưng tăng cơ hội so với gọi thẳng URL.
async function getDeal(url, opts = {}) {
  ensureDealDir();
  const proxy = parseProxy(opts.proxy) || undefined;
  const browser = await safeLaunch({ headless: false, proxy });
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 1600 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();

    const homepage = homepageOf(url);
    if (homepage && homepage !== url) {
      try {
        await page.goto(homepage, { waitUntil: 'load', timeout: 45000 });
        await page.waitForTimeout(randomDelayMs(1500, 3000));
      } catch (e) {
        logger.warn(`[get-deal] mở trang chủ thất bại, bỏ qua bước khởi động: ${e.message}`);
      }
    }

    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(randomDelayMs(3000, 5000));

    // Proxy (nhat la residential) thuong cham hon ket noi thang — trang co the
    // chua kip render xong khi het thoi gian cho ban dau. Neu body con gan nhu
    // trong, cho them 1 lan nua truoc khi chup/bo cuoc.
    let bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (bodyText.trim().length < 50) {
      await page.waitForTimeout(5000);
      bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    }

    const price = await extractPrice(page);

    const fileName = `${Date.now()}.png`;
    await page.screenshot({ path: path.join(DEAL_SCREENSHOT_DIR, fileName), fullPage: false });

    logger.info(`[get-deal] ${url} -> price=${price || '(không đọc được)'}`);
    return { price, screenshotFile: fileName };
  } finally {
    await browser.close();
  }
}

module.exports = { getDeal, DEAL_SCREENSHOT_DIR };
