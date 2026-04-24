const { chromium } = require('playwright');
const path = require('path');
const config = require('../../config/default');
const logger = require('./logger');
const loginHistory = require('./login-history');

/**
 * Kiểm tra session Facebook của tất cả profile
 * Trả về danh sách trạng thái: { profile, name, status, message }
 */
async function checkAllSessions() {
  const results = [];

  for (const [key, profile] of Object.entries(config.profiles)) {
    const result = await checkSession(key, profile);
    results.push(result);
  }

  return results;
}

/**
 * Kiểm tra session 1 profile
 */
async function checkSession(profileKey, profile) {
  const userDataDir = path.resolve(__dirname, '../../', profile.userDataDir);

  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const url = page.url();

    // Kiểm tra có bị redirect về trang login không
    if (url.includes('login') || url.includes('checkpoint') || url.includes('recover')) {
      logger.info(`Session ${profile.name}: HẾT HẠN`);
      loginHistory.addEntry(profileKey, profile.name, 'session_expired', 'Session hết hạn');
      await page.close();
      await browser.close();
      return {
        profile: profileKey,
        name: profile.name,
        status: 'expired',
        message: 'Session hết hạn - cần đăng nhập lại',
      };
    }

    // Kiểm tra có thấy element của trang chủ không
    const isLoggedIn = await page.evaluate(() => {
      // Tìm các dấu hiệu đã đăng nhập
      return document.querySelector('[aria-label="Facebook"]') !== null ||
        document.querySelector('[aria-label="Trang chủ"]') !== null ||
        document.querySelector('[aria-label="Home"]') !== null ||
        document.querySelector('[role="banner"]') !== null ||
        document.querySelector('div[data-pagelet="Stories"]') !== null;
    });

    await page.close();
    await browser.close();

    if (isLoggedIn) {
      logger.info(`Session ${profile.name}: OK`);
      loginHistory.addEntry(profileKey, profile.name, 'session_check', 'Session OK');
      return {
        profile: profileKey,
        name: profile.name,
        status: 'active',
        message: 'Session hoạt động bình thường',
      };
    } else {
      logger.info(`Session ${profile.name}: KHÔNG XÁC ĐỊNH`);
      loginHistory.addEntry(profileKey, profile.name, 'session_check', 'Không xác định');
      return {
        profile: profileKey,
        name: profile.name,
        status: 'unknown',
        message: 'Không xác định được trạng thái - kiểm tra thủ công',
      };
    }
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    logger.error(`Lỗi kiểm tra session ${profile.name}: ${error.message}`);
    return {
      profile: profileKey,
      name: profile.name,
      status: 'error',
      message: `Lỗi kiểm tra: ${error.message}`,
    };
  }
}

module.exports = { checkAllSessions, checkSession };
