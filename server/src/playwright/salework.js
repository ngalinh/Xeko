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
    // Persistent context nhớ session → user đã chọn sẵn tài khoản đúng.
    // Chỉ log tài khoản hiện tại, không tự động thay đổi.
    try {
      const currentAccount = await page.locator('.el-select .el-input__inner').first().inputValue();
      logger.info(`[salework] Tài khoản đang active: "${currentAccount}" (yêu cầu: "${zaloAccountName}")`);
    } catch {}
    await screenshot(page, '02-account-state');

    // --- Search group ---
    const groupSearchInput = await page.waitForSelector(
      'input[placeholder="Tìm kiếm"]',
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill('');
    await groupSearchInput.type(groupName, { delay: 50 });
    await page.waitForTimeout(1500);
    await screenshot(page, '03-search-filled');

    // Click group từ kết quả tìm kiếm
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
    await screenshot(page, '04-group-selected');

    // --- Chờ message input xuất hiện ---
    const msgInputSelector = [
      '.el-textarea__inner',
      'textarea.el-textarea__inner',
      '[placeholder*="Nhập tin nhắn"]',
      '[placeholder*="nhập tin nhắn"]',
      '[placeholder*="Nhập nội dung"]',
      '[contenteditable="true"]',
      'textarea',
    ].join(', ');

    await page.waitForSelector(msgInputSelector, { timeout: 8000 });

    // --- Upload ảnh TRƯỚC khi nhập nội dung ---
    if (imagePaths && imagePaths.length > 0) {
      await screenshot(page, '05a-before-upload');

      // Log các elements có thể là nút upload để debug
      const toolbarInfo = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, span, i, label'))
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            tag: el.tagName,
            class: el.className,
            title: el.title || el.getAttribute('aria-label') || '',
          }))
          .filter(el => el.title || /icon|upload|image|photo|picture|gallery/i.test(el.class));
      });
      logger.info(`[salework] Upload-related elements: ${JSON.stringify(toolbarInfo)}`);

      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });

        const uploadClicked = await tryClick(page, [
          '[title*="Thư viện hình ảnh"]',
          '[title*="hình ảnh"]',
          '[title*="Hình ảnh"]',
          '[aria-label*="hình ảnh"]',
          '[aria-label*="Hình ảnh"]',
          '.el-icon-picture',
          '.el-icon-image',
          'i[class*="picture"]',
          'i[class*="image"]',
          'i[class*="photo"]',
          '[class*="image-upload"]',
          '[class*="ImageUpload"]',
          '[class*="gallery"]',
          'label[for*="file"]',
        ], 4000);

        if (uploadClicked) {
          const fileChooser = await fileChooserPromise;
          await fileChooser.setFiles(imagePaths);
          await page.waitForTimeout(2000);
          await screenshot(page, '05b-images-attached');
          logger.info(`[salework] Đã upload ${imagePaths.length} ảnh`);
        } else {
          fileChooserPromise.catch(() => {});
          // Fallback: setInputFiles trực tiếp
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(imagePaths);
            await page.waitForTimeout(2000);
            await screenshot(page, '05b-images-via-input');
            logger.info(`[salework] Upload ảnh qua file input trực tiếp`);
          } else {
            logger.warn('[salework] Không tìm thấy nút upload ảnh — xem log elements ở trên');
            await screenshot(page, '05b-no-upload-btn');
          }
        }
      } catch (e) {
        logger.warn(`[salework] Không upload được ảnh: ${e.message}`);
        await screenshot(page, '05b-image-error');
      }
    }

    // --- Nhập nội dung SAU khi upload ảnh ---
    const msgInput = await page.$(msgInputSelector);
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

    // --- Gửi ---
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
    await screenshot(page, '07-sent');

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
