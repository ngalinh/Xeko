const path = require('path');
const fs = require('fs');
const { safeLaunch } = require('../utils/playwright-launch');
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

// Mở 1 URL sản phẩm, chụp screenshot + đọc giá hiển thị trên trang.
// Không cần profile/login — mỗi lần chạy mở browser ẩn danh riêng.
async function getDeal(url) {
  ensureDealDir();
  const browser = await safeLaunch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

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
