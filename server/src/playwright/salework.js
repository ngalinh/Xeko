const { chromium } = require('playwright');
const path = require('path');
const logger = require('../utils/logger');

const SALEWORK_PROFILE = path.resolve(__dirname, '../../../playwright-data/salework');

// NOTE: Selectors below are best-guess based on common patterns.
// They need to be verified by inspecting the live zalo.salework.net UI.
async function postToZaloGroup({ zaloAccountName, groupName, message, imagePaths }) {
  const browser = await chromium.launchPersistentContext(SALEWORK_PROFILE, {
    headless: false,
    slowMo: 500,
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = browser.pages()[0] || await browser.newPage();

    await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.click('[class*="account-select"], [class*="AccountSelect"], .ant-select', { timeout: 5000 });
      await page.waitForTimeout(500);
      await page.click(`text="${zaloAccountName}"`, { timeout: 5000 });
      await page.waitForTimeout(1000);
    } catch (e) {
      logger.warn(`Không thể chọn tài khoản "${zaloAccountName}": ${e.message}`);
    }

    const searchInput = await page.waitForSelector('input[placeholder*="Tìm kiếm"], input[class*="search"]', { timeout: 10000 });
    await searchInput.click();
    await searchInput.fill(groupName);
    await page.waitForTimeout(2000);

    await page.click(`text="${groupName}"`, { timeout: 8000 });
    await page.waitForTimeout(1000);

    const msgInput = await page.waitForSelector('[placeholder*="Nhập tin nhắn"], [contenteditable="true"]', { timeout: 8000 });
    await msgInput.click();
    await msgInput.fill(message);

    if (imagePaths && imagePaths.length > 0) {
      try {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(imagePaths);
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        logger.warn(`Không upload được ảnh: ${e.message}`);
      }
    }

    await page.click('button:has-text("Gửi"), [class*="send-btn"], [class*="SendBtn"]', { timeout: 5000 });
    await page.waitForTimeout(1000);

    logger.info(`Đã đăng lên Zalo group "${groupName}" qua tài khoản "${zaloAccountName}"`);
    return { success: true };
  } catch (e) {
    logger.error(`Lỗi đăng Zalo: ${e.message}`);
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { postToZaloGroup, SALEWORK_PROFILE };
