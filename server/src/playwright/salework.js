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

async function selectZaloAccount(page, accountName) {
  logger.info(`[salework] Chọn tài khoản: ${accountName}`);

  // Mở dropdown bằng nhiều cách
  const openSelectors = [
    '.el-select',
    '.el-select .el-input__inner',
    '.el-select__caret',
    'div.ant-select',
    '[class*="ant-select-selector"]',
    'span.ant-select-selection-item',
  ];

  let opened = false;
  for (const sel of openSelectors) {
    try {
      await page.click(sel, { force: true, timeout: 3000 });
      opened = true;
      logger.info(`[salework] Mở dropdown bằng: ${sel}`);
      break;
    } catch {}
  }

  if (!opened) {
    try {
      await page.click('text=Tất cả tài khoản', { force: true, timeout: 3000 });
      opened = true;
      logger.info('[salework] Mở dropdown bằng text "Tất cả tài khoản"');
    } catch {}
  }

  await page.waitForTimeout(1500);
  await screenshot(page, '02b-dropdown-opened');

  // Dùng evaluate để scan DOM tìm element có đúng text rồi click
  const selected = await page.evaluate((name) => {
    const els = document.querySelectorAll('div, span, li, a, [class*="option"], [class*="item"], [class*="dropdown"]');
    for (const el of els) {
      const text = el.textContent?.trim();
      if (text === name) {
        el.click();
        return true;
      }
    }
    return false;
  }, accountName);

  if (selected) {
    logger.info(`[salework] Đã chọn tài khoản: ${accountName}`);
    await page.waitForTimeout(1000);
    await page.click('body', { position: { x: 700, y: 400 }, force: true });
    await page.waitForTimeout(1000);
    return true;
  }

  // Fallback: playwright text click
  try {
    await page.click(`text="${accountName}"`, { timeout: 3000 });
    logger.info(`[salework] Đã chọn tài khoản (fallback text): ${accountName}`);
    await page.waitForTimeout(1000);
    return true;
  } catch {}

  logger.warn(`[salework] Không tìm thấy tài khoản "${accountName}" trong dropdown`);
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
    viewport: { width: 1400, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    logger.info(`[salework] === Đăng bài: account=${zaloAccountName}, group=${groupName} ===`);

    await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '01-loaded');

    // Chọn đúng tài khoản Zalo trong dropdown
    await selectZaloAccount(page, zaloAccountName);
    await screenshot(page, '02-account-selected');

    // --- Tìm kiếm nhóm ---
    const groupSearchInput = await page.waitForSelector(
      [
        'input[placeholder*="nhóm"]',
        'input[placeholder*="hội thoại"]',
        'input[placeholder*="Tìm kiếm"]',
        'input[placeholder*="tìm kiếm"]',
        'input[placeholder*="Search"]',
      ].join(', '),
      { timeout: 10000 }
    );
    await groupSearchInput.click();
    await groupSearchInput.fill('');
    await groupSearchInput.fill(groupName);
    await page.waitForTimeout(2000);
    await screenshot(page, '03-search-filled');

    // Click nhóm — dùng page.$$() + ElementHandle.click() như code cũ
    let groupClicked = false;
    const allEls = await page.$$('div, span, li, a');
    for (const el of allEls) {
      const text = await el.textContent().catch(() => '');
      if (text && text.includes(groupName) && text.trim().length < groupName.length + 50) {
        await el.click();
        groupClicked = true;
        logger.info(`[salework] Click group: "${text.trim().substring(0, 40)}"`);
        break;
      }
    }

    if (!groupClicked) {
      await screenshot(page, '04-group-not-found');
      throw new Error(`Không tìm thấy nhóm "${groupName}"`);
    }
    await page.waitForTimeout(1500);
    await screenshot(page, '04-group-selected');

    // --- Upload ảnh TRƯỚC khi nhập nội dung ---
    if (imagePaths && imagePaths.length > 0) {
      await screenshot(page, '05a-before-upload');
      let uploaded = false;

      // Debug: log tất cả element có thể là nút upload
      const uploadEls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, span, i, label, div[role="button"]'))
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            tag: el.tagName,
            cls: el.className?.toString()?.substring(0, 60),
            title: el.title || el.getAttribute('aria-label') || '',
            text: el.textContent?.trim()?.substring(0, 20),
          }))
          .filter(el => el.title || /icon|upload|image|photo|picture|gallery|file|attach/i.test(el.cls));
      });
      logger.info(`[salework] Upload elements: ${JSON.stringify(uploadEls)}`);

      // Thử 1: setInputFiles trực tiếp lên tất cả input[type="file"]
      const fileInputs = await page.$$('input[type="file"]');
      logger.info(`[salework] File inputs: ${fileInputs.length}`);
      for (const input of fileInputs) {
        try {
          await input.setInputFiles(imagePaths);
          uploaded = true;
          logger.info(`[salework] Upload ${imagePaths.length} ảnh qua file input trực tiếp`);
          break;
        } catch (e) {
          logger.warn(`[salework] setInputFiles thất bại: ${e.message}`);
        }
      }

      // Thử 2: Promise.all(filechooser + click button) — như code cũ
      if (!uploaded) {
        try {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10000 }),
            (async () => {
              // Tìm toolbar button có title liên quan đến ảnh
              const toolbarBtns = await page.$$('[class*="toolbar"] button, [class*="toolbar"] div[role="button"], [class*="action"] svg');
              for (const btn of toolbarBtns) {
                const title = await btn.getAttribute('title').catch(() => '');
                if (title && (title.includes('nh') || title.includes('image') || title.includes('hoto'))) {
                  await btn.click();
                  return;
                }
              }
              // Tìm svg/icon và check title của element cha
              const icons = await page.$$('svg, [class*="icon"]');
              for (const icon of icons) {
                const parent = await icon.$('xpath=..');
                const title = await parent?.getAttribute('title').catch(() => '');
                if (title && (title.includes('Hình') || title.includes('ảnh') || title.includes('image'))) {
                  await icon.click();
                  return;
                }
              }
            })(),
          ]);
          await fileChooser.setFiles(imagePaths);
          uploaded = true;
          logger.info(`[salework] Upload ${imagePaths.length} ảnh qua filechooser`);
        } catch (e) {
          logger.warn(`[salework] filechooser thất bại: ${e.message}`);
        }
      }

      if (uploaded) await page.waitForTimeout(2000);
      await screenshot(page, '05b-after-upload');
    }

    // --- Nhập nội dung ---
    const msgInput = await page.waitForSelector(
      [
        '[placeholder*="Nhập tin nhắn"]',
        '[placeholder*="nhập tin nhắn"]',
        '[placeholder*="Nhập nội dung"]',
        '[contenteditable="true"]',
        '.el-textarea__inner',
        'textarea',
      ].join(', '),
      { timeout: 8000 }
    );
    await msgInput.click();
    await page.waitForTimeout(300);

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
    const sendSelectors = [
      'button:has-text("Gửi")',
      'button:has-text("Send")',
      '.el-button--primary:has-text("Gửi")',
      '.el-button--primary',
      '[class*="send"] button',
      'button[type="submit"]',
    ];
    let sent = false;
    for (const sel of sendSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        sent = true;
        break;
      } catch {}
    }
    if (!sent) {
      await msgInput.press('Enter');
    }
    await page.waitForTimeout(2000);
    await screenshot(page, '07-sent');

    logger.info(`[salework] Đã đăng lên Zalo group "${groupName}" qua tài khoản "${zaloAccountName}"`);
    return { success: true };
  } catch (e) {
    logger.error(`[salework] Lỗi đăng Zalo: ${e.message}`);
    try { await screenshot(page, '99-error'); } catch {}
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { postToZaloGroup, getSaleworkProfile };
