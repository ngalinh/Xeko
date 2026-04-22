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
  } catch {}
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function selectZaloAccount(page, accountName) {
  logger.info(`[salework] Chọn tài khoản: ${accountName}`);

  const openSelectors = [
    '.el-select',
    '.el-select .el-input__inner',
    '.el-select__caret',
    'div.ant-select',
    '[class*="ant-select-selector"]',
    'span.ant-select-selection-item',
  ];

  for (const sel of openSelectors) {
    try {
      await page.click(sel, { force: true, timeout: 3000 });
      logger.info(`[salework] Mở dropdown bằng: ${sel}`);
      break;
    } catch {}
  }

  try {
    await page.click('text=Tất cả tài khoản', { force: true, timeout: 3000 });
  } catch {}

  await delay(1500);

  const selected = await page.evaluate((name) => {
    const els = document.querySelectorAll('div, span, li, a, [class*="option"], [class*="item"], [class*="dropdown"]');
    for (const el of els) {
      if (el.textContent?.trim() === name) {
        el.click();
        return true;
      }
    }
    return false;
  }, accountName);

  if (selected) {
    logger.info(`[salework] Đã chọn tài khoản: ${accountName}`);
    await delay(1000);
    await page.click('body', { position: { x: 700, y: 400 }, force: true });
    await delay(1000);
    return true;
  }

  try {
    await page.click(`text="${accountName}"`, { timeout: 3000 });
    await delay(1000);
    return true;
  } catch {}

  logger.warn(`[salework] Không tìm thấy tài khoản "${accountName}"`);
  return false;
}

async function searchAndClickGroup(page, groupName) {
  logger.info(`[salework] Tìm nhóm: ${groupName}`);

  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    await delay(2000);
  }

  await screenshot(page, '03-search-filled');

  const results = await page.$$('div, span, li, a');
  for (const el of results) {
    const text = await el.textContent().catch(() => '');
    if (text && text.includes(groupName) && text.trim().length < groupName.length + 50) {
      await el.click();
      logger.info(`[salework] Click nhóm: ${groupName}`);
      await delay(2000);
      return true;
    }
  }

  logger.error(`[salework] Không tìm thấy nhóm: ${groupName}`);
  return false;
}

async function sendMessage(page, message, imagePaths = []) {
  logger.info(`[salework] Gửi: "${message?.substring(0, 30)}" + ${imagePaths.length} ảnh`);

  if (imagePaths.length > 0) {
    let uploaded = false;

    // Thử 1: setInputFiles trực tiếp
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        logger.info(`[salework] Upload ${imagePaths.length} ảnh (direct)`);
        break;
      } catch { continue; }
    }

    // Thử 2: filechooser — Promise.all như code cũ
    if (!uploaded) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            const toolbar = await page.$$('[class*="toolbar"] button, [class*="toolbar"] div[role="button"], [class*="action"] svg');
            for (const btn of toolbar) {
              const title = await btn.getAttribute('title').catch(() => '');
              if (title?.includes('nh') || title?.includes('image') || title?.includes('hoto')) {
                await btn.click();
                return;
              }
            }
            const icons = await page.$$('svg, [class*="icon"]');
            for (const icon of icons) {
              const parent = await icon.$('xpath=..');
              const title = await parent?.getAttribute('title').catch(() => '');
              if (title?.includes('Hình') || title?.includes('ảnh') || title?.includes('image')) {
                await icon.click();
                return;
              }
            }
          })(),
        ]);
        await fileChooser.setFiles(imagePaths);
        uploaded = true;
        logger.info(`[salework] Upload ${imagePaths.length} ảnh (filechooser)`);
      } catch (e) {
        logger.error(`[salework] Upload thất bại: ${e.message}`);
      }
    }

    await delay(2000);
    await screenshot(page, '05-after-upload');
  }

  if (message) {
    const msgInput = await page.$('[placeholder*="Nhập tin nhắn"], [placeholder*="nhập tin nhắn"], [contenteditable="true"], textarea');
    if (msgInput) {
      await msgInput.click();
      await delay(300);
      await msgInput.fill(message);
      logger.info('[salework] Đã nhập tin nhắn');
      await delay(500);
    }
  }

  await delay(1000);

  const sendSelectors = [
    'button:has-text("Gửi")',
    'button:has-text("Send")',
    '[class*="send"] button',
  ];
  for (const sel of sendSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        logger.info('[salework] Click nút Gửi');
        await delay(2000);
        return true;
      }
    } catch { continue; }
  }

  await page.keyboard.press('Enter');
  logger.info('[salework] Gửi bằng Enter');
  await delay(2000);
  return true;
}

async function postToZaloGroup({ zaloAccountName, accountKey, groupName, message, imagePaths }) {
  const profilePath = getSaleworkProfile(accountKey);

  if (!fs.existsSync(profilePath)) {
    return {
      success: false,
      error: `Chưa đăng nhập Salework cho tài khoản "${zaloAccountName}". Hãy xoá và thêm lại tài khoản qua UI.`,
    };
  }

  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    slowMo: 500,
    viewport: { width: 1400, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const page = await browser.newPage();

  try {
    logger.info(`[salework] === account=${zaloAccountName}, group=${groupName} ===`);

    await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);
    await screenshot(page, '01-loaded');

    await selectZaloAccount(page, zaloAccountName);
    await screenshot(page, '02-account-selected');

    if (!(await searchAndClickGroup(page, groupName))) {
      throw new Error(`Không tìm thấy nhóm: ${groupName}`);
    }
    await screenshot(page, '04-group-selected');

    await sendMessage(page, message, imagePaths);
    await screenshot(page, '07-sent');

    logger.info(`[salework] Đã đăng lên "${groupName}" qua "${zaloAccountName}"`);
    return { success: true };
  } catch (e) {
    logger.error(`[salework] Lỗi: ${e.message}`);
    try { await screenshot(page, '99-error'); } catch {}
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { postToZaloGroup, getSaleworkProfile };
