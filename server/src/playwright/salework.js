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
    // The account search input is always visible on page (not inside a closed dropdown).
    // Flow: click input → type name → click matching item from filtered list.
    try {
      const accountInput = await page.waitForSelector(
        'input[placeholder*="tài khoản"], input[placeholder*="Tài khoản"]',
        { timeout: 5000 }
      );
      await accountInput.click();
      await accountInput.fill('');
      await accountInput.type(zaloAccountName, { delay: 50 });
      await page.waitForTimeout(800);
      await screenshot(page, '02-account-typed');

      // Click the matching account item from the filtered list
      const accountSelected = await tryClick(page, [
        `.el-select-dropdown__item:has-text("${zaloAccountName}")`,
        `.el-select-dropdown .el-select-dropdown__item:has-text("${zaloAccountName}")`,
        `[class*="account-item"]:has-text("${zaloAccountName}")`,
        `[class*="AccountItem"]:has-text("${zaloAccountName}")`,
        `[class*="item"]:has-text("${zaloAccountName}")`,
        `li:has-text("${zaloAccountName}")`,
      ], 5000);

      if (accountSelected) {
        logger.info(`[salework] Đã chọn tài khoản "${zaloAccountName}"`);
      } else {
        logger.warn(`[salework] Không tìm thấy item tài khoản "${zaloAccountName}"`);
        await screenshot(page, '02b-account-not-found');
      }
      await page.waitForTimeout(800);
      await screenshot(page, '02c-after-account');
    } catch (e) {
      logger.warn(`[salework] Lỗi chọn tài khoản "${zaloAccountName}": ${e.message}`);
      await screenshot(page, '02-account-error');
    }

    // --- Search group ---
    // There are 2 "Tìm kiếm" inputs: one for account, one for group.
    // Use the one that does NOT contain "tài khoản" in placeholder.
    const groupSearchInput = await page.waitForSelector(
      [
        'input[placeholder*="nhóm"]',
        'input[placeholder*="hội thoại"]',
        'input[placeholder*="cuộc trò chuyện"]',
        'input[placeholder*="Tìm kiếm"]:not([placeholder*="tài khoản"])',
        'input[placeholder*="tìm kiếm"]:not([placeholder*="tài khoản"])',
      ].join(', '),
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill('');
    await groupSearchInput.type(groupName, { delay: 50 });
    await page.waitForTimeout(1500);
    await screenshot(page, '04-search-filled');

    // Click group from result list — scroll into view if needed
    const groupLocator = page.locator([
      `[class*="conversation-item"]:has-text("${groupName}")`,
      `[class*="ConversationItem"]:has-text("${groupName}")`,
      `[class*="group-item"]:has-text("${groupName}")`,
      `[class*="chat-item"]:has-text("${groupName}")`,
      `.el-list-item:has-text("${groupName}")`,
      `[class*="item"]:has-text("${groupName}")`,
      `li:has-text("${groupName}")`,
    ].join(', ')).first();

    try {
      await groupLocator.waitFor({ timeout: 8000 });
      await groupLocator.scrollIntoViewIfNeeded();
      await groupLocator.click();
    } catch {
      // Fallback: plain text click
      await page.click(`text="${groupName}"`, { timeout: 5000 });
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

    // --- Send ---
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
