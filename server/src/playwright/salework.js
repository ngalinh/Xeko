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
    // Flow: click .el-select để mở dropdown → click vào ô search bên trong → gõ tên → click item
    try {
      // Bước 1: mở dropdown nếu chưa mở
      if (!await page.isVisible('input[placeholder*="tài khoản"]')) {
        await page.locator('.el-select').first().click({ timeout: 5000 });
        await page.waitForSelector('input[placeholder*="tài khoản"]', { state: 'visible', timeout: 4000 });
      }
      await screenshot(page, '02-dropdown-open');

      // Bước 2: click vào ô search trong dropdown rồi gõ tên tài khoản
      await page.locator('input[placeholder*="tài khoản"]').click({ timeout: 3000 });
      await page.locator('input[placeholder*="tài khoản"]').type(zaloAccountName, { delay: 80 });
      await page.waitForTimeout(600);
      await screenshot(page, '02b-account-typed');

      // Bước 3: click item trong danh sách
      await page.locator('li').filter({ hasText: zaloAccountName }).first().click({ timeout: 5000 });
      await page.waitForTimeout(500);
      await screenshot(page, '02c-account-selected');
      logger.info(`[salework] Đã chọn tài khoản "${zaloAccountName}"`);
    } catch (e) {
      logger.warn(`[salework] Lỗi chọn tài khoản "${zaloAccountName}": ${e.message}`);
      await screenshot(page, '02-error');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await screenshot(page, '03-after-account');

    // --- Search group ---
    const groupSearchInput = await page.waitForSelector(
      'input[placeholder="Tìm kiếm"]',
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill('');
    await groupSearchInput.type(groupName, { delay: 50 });
    await page.waitForTimeout(1500);
    await screenshot(page, '04-search-filled');

    // Click group from result list
    const groupLocator = page.locator([
      `[class*="conversation-item"]:has-text("${groupName}")`,
      `[class*="contact-item"]:has-text("${groupName}")`,
      `[class*="group-item"]:has-text("${groupName}")`,
      `[class*="chat-item"]:has-text("${groupName}")`,
      `[class*="item"]:has-text("${groupName}")`,
      `li:has-text("${groupName}")`,
    ].join(', ')).first();

    try {
      await groupLocator.waitFor({ timeout: 8000 });
      await groupLocator.scrollIntoViewIfNeeded();
      await groupLocator.click();
    } catch {
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
    // Strategy: click attachment/image button, capture filechooser event, set files.
    // If no button found, fall back to setInputFiles on any file input.
    if (imagePaths && imagePaths.length > 0) {
      try {
        // Attach a filechooser listener BEFORE clicking to avoid race condition
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });

        const uploadClicked = await tryClick(page, [
          // Common Vietnamese CRM upload button selectors
          '[class*="btn-upload"]',
          '[class*="BtnUpload"]',
          '[class*="upload-image"]',
          '[class*="UploadImage"]',
          '[class*="attach-image"]',
          '[class*="image-btn"]',
          // Icon buttons near message input
          '[class*="toolbar"] [class*="image"]',
          '[class*="toolbar"] [class*="photo"]',
          '[class*="footer"] [class*="image"]',
          '[class*="footer"] [class*="photo"]',
          // Generic label for file input
          'label[for*="file"]',
          'label[class*="upload"]',
        ], 3000);

        if (uploadClicked) {
          const fileChooser = await fileChooserPromise;
          await fileChooser.setFiles(imagePaths);
          await page.waitForTimeout(2000);
          await screenshot(page, '07-images-attached');
        } else {
          // Cancel the pending filechooser promise
          fileChooserPromise.catch(() => {});
          // Fallback: use setInputFiles directly on the file input element
          const fileInputs = await page.$$('input[type="file"]');
          if (fileInputs.length > 0) {
            await page.setInputFiles('input[type="file"]', imagePaths);
            await page.waitForTimeout(2000);
            await screenshot(page, '07-images-set');
          } else {
            logger.warn('[salework] Không tìm thấy nút upload ảnh — bỏ qua ảnh');
            await screenshot(page, '07-no-upload-btn');
          }
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
