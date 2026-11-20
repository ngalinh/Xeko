const path = require('path');
const fs = require('fs');
const { safeLaunch } = require('../utils/playwright-launch');
const { firefox, webkit } = require('playwright');
const { parseProxy } = require('../utils/proxy');
const logger = require('../utils/logger');
const { collectGalleryImages, collectAllColorImages, inspectPictureImages, inspectJsonLd } = require('./product-images');

const DEAL_SCREENSHOT_DIR = path.resolve(__dirname, '../../logs/deals');

function ensureDealDir() {
  if (!fs.existsSync(DEAL_SCREENSHOT_DIR)) {
    fs.mkdirSync(DEAL_SCREENSHOT_DIR, { recursive: true });
  }
}

async function extractPrice(page) {
  return page.evaluate(require('./product-price')).catch(() => null);
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
// Chromium dùng wrapper hiện có; Firefox/WebKit dùng Playwright trực tiếp.
// Workflow deploy cài cả ba engine vào cùng PLAYWRIGHT_BROWSERS_PATH.
async function launchBrowser(engine, launchOpts) {
  try {
    if (engine === 'firefox') return await firefox.launch(launchOpts);
    if (engine === 'webkit') return await webkit.launch(launchOpts);
    return await safeLaunch(launchOpts);
  } catch (error) {
    if (/Executable doesn'?t exist|Looks like Playwright was just installed/i.test(error.message || '')) {
      throw new Error(`Chưa cài trình duyệt ${engine} trên máy chạy Xeko. Cần chạy lại workflow deploy để cài đủ browser.`, { cause: error });
    }
    throw error;
  }
}

async function getDeal(url, opts = {}) {
  ensureDealDir();
  const proxy = parseProxy(opts.proxy) || undefined;
  const engine = ['firefox', 'webkit'].includes(opts.engine) ? opts.engine : 'chromium';
  const browser = await launchBrowser(engine, { headless: false, proxy });
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
        await page.goto(homepage, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(randomDelayMs(1500, 3000));
      } catch (e) {
        logger.warn(`[get-deal] mở trang chủ thất bại, bỏ qua bước khởi động: ${e.message}`);
      }
    }

    // Macy's (va cac web lon khac) dung bot-management: khi bi chan, trang tra ve
    // HTTP 403/503 voi mot trang "Access Denied" rong khong co gia/anh. Moi lan
    // request duoc cham diem rui ro rieng nen thu lai sau 1 khoang nghi ngan co
    // the qua duoc du lan truoc bi chan; neu van bi chan ca 2 lan moi bao loi.
    let mainResponse;
    let mainStatus;
    for (let attempt = 1; attempt <= 2; attempt++) {
      mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(randomDelayMs(3000, 5000));
      mainStatus = mainResponse ? mainResponse.status() : null;
      if (mainStatus === null || (mainStatus >= 200 && mainStatus < 300)) break;
      if (attempt < 2) {
        logger.warn(`[get-deal] ${url} trả về HTTP ${mainStatus} ở lần ${attempt}, chờ rồi thử lại...`);
        await page.waitForTimeout(randomDelayMs(15000, 20000));
      }
    }
    if (mainStatus !== null && (mainStatus < 200 || mainStatus >= 300)) {
      const blockedTitle = await page.title().catch(() => '');
      throw new Error(`Trang trả về lỗi (HTTP ${mainStatus}${blockedTitle ? ': ' + blockedTitle : ''}) sau 2 lần thử — có thể bị chặn bot, hãy thử lại sau.`);
    }

    // Proxy (nhat la residential) thuong cham hon ket noi thang — trang co the
    // chua kip render xong khi het thoi gian cho ban dau. Neu body con gan nhu
    // trong, cho them 1 lan nua truoc khi chup/bo cuoc.
    let bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (bodyText.trim().length < 50) {
      await page.waitForTimeout(5000);
      bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    }

    const brand = await page.evaluate(require('./product-brand')).catch(() => '');
    const price = await extractPrice(page);
    const { images, gallery, colors } = opts.allColors
      ? await collectAllColorImages(page)
      : await collectGalleryImages(page);
    // Tạm thời: chẩn đoán ảnh lọt từ đâu khi gallery không tìm thấy thumbnail
    // nào (found=0) nhưng vẫn ra ảnh — xem ghi chú ở inspectPictureImages.
    const pictureImages = await page.evaluate(inspectPictureImages).catch(() => []);
    const jsonLdProducts = await page.evaluate(inspectJsonLd).catch(() => []);

    const fileName = `${Date.now()}.png`;
    await page.screenshot({ path: path.join(DEAL_SCREENSHOT_DIR, fileName), fullPage: false });

    // Thong tin debug — de biet trang thuc su tra ve gi (bi redirect, bi chan
    // bang ma loi, hay chi la chua render kip) thay vi doan mo qua anh chup.
    const debug = {
      gallery,
      colors,
      pictureImages,
      jsonLdProducts,
      finalUrl: page.url(),
      httpStatus: mainResponse ? mainResponse.status() : null,
      pageTitle: await page.title().catch(() => null),
      bodyTextLength: bodyText.trim().length,
      bodyTextPreview: bodyText.trim().slice(0, 300),
    };

    logger.info(`[get-deal] ${url} (engine=${engine}) -> price=${price || '(không đọc được)'} debug=${JSON.stringify(debug)}`);
    return { brand, price, images, screenshotFile: fileName, debug: { ...debug, engine } };
  } finally {
    await browser.close();
  }
}

module.exports = { getDeal, DEAL_SCREENSHOT_DIR };
