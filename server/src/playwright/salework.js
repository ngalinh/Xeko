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
      // Check if the account dropdown is already open (search input visible)
      const alreadyOpen = await page.isVisible('input[placeholder*="tài khoản"]');

      if (!alreadyOpen) {
        await tryClick(page, [
          '.el-select .el-input__inner',
          '.el-select',
        ], 5000);
        await page.waitForTimeout(600);
      }

      await screenshot(page, '02-dropdown-open');

      // Type account name in the search input inside the dropdown
      await page.fill('input[placeholder*="tài khoản"]', zaloAccountName);
      await page.waitForTimeout(600);
      await screenshot(page, '02b-account-typed');

      // Use locator().filter() — most reliable way to match text in Playwright
      await page.locator('li').filter({ hasText: zaloAccountName }).first().click({ timeout: 5000 });
      await page.waitForTimeout(600);
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
    // Group search input has placeholder exactly "Tìm kiếm" (not "Tìm kiếm tài khoản...")
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

    // --- Upload images via filechooser event ---
    if (imagePaths && imagePaths.length > 0) {
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });

        // Try clicking the image/attachment upload button
        const uploadClicked = await tryClick(page, [
          '[class*="upload"] button',
          '[class*="attach"]',
          '[class*="image-upload"]',
          '[class*="ImageUpload"]',
          'button[title*="ảnh"], button[title*="hình"], button[title*="image"]',
          '[class*="toolbar"] button:nth-child(1)',
          '[class*="Toolbar"] button:nth-child(1)',
          'label[for*="file"]',
          'label[class*="upload"]',
        ], 3000);

        if (!uploadClicked) {
          // Fallback: force-click any hidden file input
          fileChooserPromise.catch(() => {});
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await page.setInputFiles('input[type="file"]', imagePaths);
            await page.waitForTimeout(2000);
            await screenshot(page, '07-images-set');
          } else {
            logger.warn('[salework] Không tìm thấy nút upload ảnh hoặc input[type="file"]');
          }
        } else {
          // Upload button was clicked — set files via filechooser dialog
          const fileChooser = await fileChooserPromise;
          await fileChooser.setFiles(imagePaths);
          await page.waitForTimeout(2000);
          await screenshot(page, '07-images-attached');
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
