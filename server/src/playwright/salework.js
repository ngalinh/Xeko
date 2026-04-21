const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const SALEWORK_PROFILE = path.resolve(__dirname, '../../../playwright-data/salework');
const DEBUG_SCREENSHOT_DIR = '/tmp/salework-debug';

function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_SCREENSHOT_DIR)) {
    fs.mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
  }
}

async function screenshot(page, label) {
  try {
    ensureDebugDir();
    const filePath = `${DEBUG_SCREENSHOT_DIR}/${Date.now()}-${label}.png`;
    await page.screenshot({ path: filePath, fullPage: false });
    logger.info(`[salework] screenshot: ${filePath}`);
  } catch (e) {
    // non-fatal
  }
}

async function tryClick(page, selectors, timeout = 3000) {
  for (const sel of Array.isArray(selectors) ? selectors : [selectors]) {
    try {
      await page.click(sel, { timeout });
      return true;
    } catch {}
  }
  return false;
}

async function postToZaloGroup({ zaloAccountName, groupName, message, imagePaths }) {
  const browser = await chromium.launchPersistentContext(SALEWORK_PROFILE, {
    headless: false,
    slowMo: 300,
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = browser.pages()[0] || await browser.newPage();

    await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot(page, '01-loaded');

    // --- Account selection ---
    try {
      // Ant Design Select: click the selector to open dropdown
      const opened = await tryClick(page, [
        '.ant-select-selector',
        '[class*="account"] .ant-select-selector',
        '[class*="Account"] .ant-select-selector',
        '.ant-select:first-of-type .ant-select-selector',
        '[class*="account-select"]',
        '[class*="AccountSelect"]',
      ], 5000);

      if (opened) {
        await page.waitForTimeout(800);
        await screenshot(page, '02-dropdown-open');

        // Select option by text — Ant Design renders options in a portal
        const optionSelected = await tryClick(page, [
          `.ant-select-item-option-content:text("${zaloAccountName}")`,
          `.ant-select-item[title="${zaloAccountName}"]`,
          `.ant-select-item-option:has-text("${zaloAccountName}")`,
          `li:has-text("${zaloAccountName}")`,
          `[class*="option"]:has-text("${zaloAccountName}")`,
        ], 5000);

        if (!optionSelected) {
          logger.warn(`[salework] Không tìm thấy option cho "${zaloAccountName}" trong dropdown`);
          await screenshot(page, '02b-dropdown-no-option');
        }
        await page.waitForTimeout(800);
      } else {
        logger.warn(`[salework] Không mở được dropdown tài khoản cho "${zaloAccountName}"`);
        await screenshot(page, '02-no-dropdown');
      }
    } catch (e) {
      logger.warn(`[salework] Lỗi chọn tài khoản "${zaloAccountName}": ${e.message}`);
      await screenshot(page, '02-account-error');
    }

    await screenshot(page, '03-after-account');

    // --- Search group ---
    const searchInput = await page.waitForSelector(
      [
        'input[placeholder*="Tìm kiếm"]',
        'input[placeholder*="Tìm"]',
        'input[placeholder*="tìm"]',
        'input[placeholder*="Search"]',
        '[class*="search"] input',
        '.ant-input-search input',
        '.ant-input[type="text"]',
        'input.ant-input',
      ].join(', '),
      { timeout: 10000 }
    );
    await searchInput.click();
    await searchInput.fill(groupName);
    await page.waitForTimeout(1500);
    await screenshot(page, '04-search-filled');

    // Click group from result list
    const groupClicked = await tryClick(page, [
      `[class*="group-item"]:has-text("${groupName}")`,
      `[class*="GroupItem"]:has-text("${groupName}")`,
      `[class*="conversation"]:has-text("${groupName}")`,
      `[class*="Conversation"]:has-text("${groupName}")`,
      `[class*="item"]:has-text("${groupName}")`,
      `.ant-list-item:has-text("${groupName}")`,
      `li:has-text("${groupName}")`,
      `text="${groupName}"`,
    ], 8000);

    if (!groupClicked) {
      await screenshot(page, '05-group-not-found');
      throw new Error(`Không tìm thấy nhóm "${groupName}" trong danh sách`);
    }
    await page.waitForTimeout(1000);
    await screenshot(page, '05-group-selected');

    // --- Type message ---
    const msgInput = await page.waitForSelector(
      [
        '[placeholder*="Nhập tin nhắn"]',
        '[placeholder*="nhập tin nhắn"]',
        '[placeholder*="Nhập nội dung"]',
        'textarea.ant-input',
        '[contenteditable="true"]',
        '.ant-input[placeholder*="tin nhắn"]',
      ].join(', '),
      { timeout: 8000 }
    );
    await msgInput.click();

    // contenteditable needs type() not fill()
    const tagName = await msgInput.evaluate(el => el.tagName.toLowerCase());
    const isEditable = await msgInput.evaluate(el => el.contentEditable === 'true');
    if (isEditable) {
      await msgInput.evaluate(el => { el.textContent = ''; });
      await msgInput.type(message, { delay: 20 });
    } else {
      await msgInput.fill(message);
    }
    await page.waitForTimeout(500);
    await screenshot(page, '06-message-typed');

    // --- Upload images ---
    if (imagePaths && imagePaths.length > 0) {
      try {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(imagePaths);
          await page.waitForTimeout(2000);
          await screenshot(page, '07-images-attached');
        } else {
          logger.warn('[salework] Không tìm thấy input[type="file"] để upload ảnh');
        }
      } catch (e) {
        logger.warn(`[salework] Không upload được ảnh: ${e.message}`);
        await screenshot(page, '07-image-error');
      }
    }

    // --- Send ---
    const sent = await tryClick(page, [
      'button:has-text("Gửi")',
      'button:has-text("Send")',
      '.ant-btn-primary:has-text("Gửi")',
      '.ant-btn-primary',
      '[class*="send-btn"]',
      '[class*="SendBtn"]',
      'button[type="submit"]',
    ], 5000);

    if (!sent) {
      // Try Enter key as fallback
      await msgInput.press('Enter');
    }
    await page.waitForTimeout(1500);
    await screenshot(page, '08-sent');

    logger.info(`[salework] Đã đăng lên Zalo group "${groupName}" qua tài khoản "${zaloAccountName}"`);
    return { success: true };
  } catch (e) {
    logger.error(`[salework] Lỗi đăng Zalo: ${e.message}`);
    try {
      const page = browser.pages()[0];
      if (page) await screenshot(page, '99-error');
    } catch {}
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { postToZaloGroup, SALEWORK_PROFILE };
