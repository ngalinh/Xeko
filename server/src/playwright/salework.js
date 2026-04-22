const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DEBUG_SCREENSHOT_DIR = '/tmp/salework-debug';

function getSaleworkProfile(accountKey) {
  return path.resolve(__dirname, `../../../playwright-data/salework-${accountKey}`);
}

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

async function postToZaloGroup({ zaloAccountName, accountKey, groupName, message, imagePaths }) {
  const profilePath = getSaleworkProfile(accountKey);

  if (!fs.existsSync(profilePath)) {
    return {
      success: false,
      error: `Chưa đăng nhập Salework cho tài khoản "${zaloAccountName}". Hãy xoá và thêm lại tài khoản qua UI để mở browser đăng nhập.`,
    };
  }

  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    slowMo: 300,
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = browser.pages()[0] || await browser.newPage();

    await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot(page, '01-loaded');

    // Per-account profile: account is already selected from the setup session.
    try {
      const currentAccount = await page.locator('.el-select .el-input__inner').first().inputValue();
      logger.info(`[salework] Profile "${accountKey}" — tài khoản active: "${currentAccount}"`);
    } catch {}
    await screenshot(page, '02-account-state');

    // --- Search group ---
    const groupSearchInput = await page.waitForSelector(
      [
        'input[placeholder*="nhóm"]',
        'input[placeholder*="hội thoại"]',
        'input[placeholder*="Tìm kiếm cuộc"]',
        'input[placeholder*="tin nhắn"]',
        '.el-input__inner:not([placeholder*="tài khoản"])',
      ].join(', '),
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill(groupName);
    await page.waitForTimeout(1500);
    await screenshot(page, '03-search-filled');

    // Click group from result list
    const groupClicked = await tryClick(page, [
      `[class*="conversation-item"]:has-text("${groupName}")`,
      `[class*="ConversationItem"]:has-text("${groupName}")`,
      `[class*="group-item"]:has-text("${groupName}")`,
      `[class*="chat-item"]:has-text("${groupName}")`,
      `[class*="item"]:has-text("${groupName}")`,
      `li:has-text("${groupName}")`,
      `text="${groupName}"`,
    ], 8000);

    if (!groupClicked) {
      await screenshot(page, '04-group-not-found');
      throw new Error(`Không tìm thấy nhóm "${groupName}"`);
    }
    await page.waitForTimeout(1000);
    await screenshot(page, '04-group-selected');

    // --- Upload images BEFORE typing message ---
    if (imagePaths && imagePaths.length > 0) {
      await screenshot(page, '05a-before-upload');
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
          '[class*="image-upload"]',
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
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(imagePaths);
            await page.waitForTimeout(2000);
            await screenshot(page, '05b-images-via-input');
            logger.info(`[salework] Upload ảnh qua file input trực tiếp`);
          } else {
            logger.warn('[salework] Không tìm thấy nút upload ảnh');
            await screenshot(page, '05b-no-upload-btn');
          }
        }
      } catch (e) {
        logger.warn(`[salework] Không upload được ảnh: ${e.message}`);
        await screenshot(page, '05b-image-error');
      }
    }

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

module.exports = { postToZaloGroup, getSaleworkProfile };
