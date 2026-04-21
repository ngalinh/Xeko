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

    // --- Account selection (Element UI el-select) ---
    try {
      // Click the el-select input to open dropdown
      const opened = await tryClick(page, [
        '[class*="account"] .el-input__inner',
        '[class*="Account"] .el-input__inner',
        '[class*="account"] .el-select',
        '.el-select .el-input__inner',
      ], 5000);

      if (opened) {
        await page.waitForTimeout(600);
        await screenshot(page, '02-dropdown-open');

        // Type to filter account name in the search input inside dropdown
        try {
          const accountSearchInput = await page.$('input[placeholder*="tài khoản"]');
          if (accountSearchInput) {
            await accountSearchInput.fill(zaloAccountName);
            await page.waitForTimeout(500);
          }
        } catch {}

        // Click matching option in el-select dropdown
        const optionSelected = await tryClick(page, [
          `.el-select-dropdown__item:has-text("${zaloAccountName}")`,
          `.el-select-dropdown .el-select-dropdown__item:has-text("${zaloAccountName}")`,
          `li.el-select-dropdown__item:has-text("${zaloAccountName}")`,
          `.el-option:has-text("${zaloAccountName}")`,
        ], 5000);

        if (!optionSelected) {
          logger.warn(`[salework] Không tìm thấy option cho "${zaloAccountName}" trong dropdown`);
          await screenshot(page, '02b-no-account-option');
        }
        await page.waitForTimeout(800);
        await screenshot(page, '02c-account-selected');
      } else {
        logger.warn(`[salework] Không mở được dropdown tài khoản cho "${zaloAccountName}"`);
        await screenshot(page, '02-no-dropdown');
      }
    } catch (e) {
      logger.warn(`[salework] Lỗi chọn tài khoản "${zaloAccountName}": ${e.message}`);
      await screenshot(page, '02-account-error');
    }

    await screenshot(page, '03-after-account');

    // --- Search group (avoid account search input by using specific placeholder) ---
    // The page has multiple el-input__inner: "Tìm kiếm tài khoản..." and "Tìm kiếm nhóm/hội thoại..."
    const groupSearchInput = await page.waitForSelector(
      [
        'input[placeholder*="nhóm"]',
        'input[placeholder*="hội thoại"]',
        'input[placeholder*="Tìm kiếm cuộc"]',
        'input[placeholder*="tin nhắn"]',
        // Fallback: second el-input__inner (first is account search)
        '.el-input__inner:not([placeholder*="tài khoản"])',
      ].join(', '),
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill(groupName);
    await page.waitForTimeout(1500);
    await screenshot(page, '04-search-filled');

    // Click group from result list (Element UI list items)
    const groupClicked = await tryClick(page, [
      `.el-list-item:has-text("${groupName}")`,
      `[class*="conversation-item"]:has-text("${groupName}")`,
      `[class*="ConversationItem"]:has-text("${groupName}")`,
      `[class*="group-item"]:has-text("${groupName}")`,
      `[class*="chat-item"]:has-text("${groupName}")`,
      `[class*="item"]:has-text("${groupName}")`,
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
        '.el-textarea__inner',
        'textarea.el-textarea__inner',
        '[placeholder*="Nhập tin nhắn"]',
        '[placeholder*="nhập tin nhắn"]',
        '[placeholder*="Nhập nội dung"]',
        '[contenteditable="true"]',
        'textarea',
      ].join(', '),
      { timeout: 8000 }
    );
    await msgInput.click();

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

    // --- Send (Element UI button) ---
    const sent = await tryClick(page, [
      'button.el-button--primary:has-text("Gửi")',
      '.el-button--primary:has-text("Gửi")',
      'button:has-text("Gửi")',
      '.el-button--primary',
      '[class*="send"]:has-text("Gửi")',
      'button[type="submit"]',
    ], 5000);

    if (!sent) {
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
