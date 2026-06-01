const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getZaloProxyForAccount } = require('../utils/proxy');
const { randomDelay, humanType } = require('../utils/delay');
const { getProfileDeviceFingerprint } = require('../utils/device-fingerprint');
const { checkProxy } = require('../utils/proxy-health');

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

  // Bước 1: Clear tất cả selection cũ (dropdown là multi-select)
  let cleared = 0;
  while (cleared < 20) {
    const removed = await page.evaluate(() => {
      const closeIcons = document.querySelectorAll('.el-tag__close, .el-icon-close, [class*="tag"] [class*="close"], [class*="tag"] i');
      for (const icon of closeIcons) {
        if (icon.offsetParent !== null) {
          icon.click();
          return true;
        }
      }
      return false;
    });
    if (!removed) break;
    await delay(200);
    cleared++;
  }
  if (cleared > 0) logger.info(`[salework] Xoá ${cleared} tag cũ`);

  // Bước 2: Mở dropdown
  const openSelectors = [
    '.el-select',
    '.el-select .el-input__inner',
    '.el-select__caret',
  ];
  for (const sel of openSelectors) {
    try {
      await page.click(sel, { force: true, timeout: 3000 });
      logger.info(`[salework] Mở dropdown bằng: ${sel}`);
      break;
    } catch {}
  }
  await delay(1500);

  // Bước 3: Tìm tọa độ option trong dropdown (1 round-trip evaluate),
  // rồi dùng page.mouse.click() để fire đầy đủ pointer events cho Vue.js.
  const accountRect = await page.evaluate((name) => {
    const norm = s => s.normalize('NFC').trim();
    const normName = norm(name);
    const els = document.querySelectorAll('[class*="dropdown"] li, [class*="option"], li, [class*="item"], div, span, a');
    for (const el of els) {
      const text = norm(el.textContent || '');
      // Khớp chính xác / tên kèm SĐT / DOM bị cắt ellipsis
      const domStripped = text.replace(/[\s.…]+$/, '');
      if (
        text === normName ||
        text.startsWith(normName + ' ') || text.startsWith(normName + '\n') ||
        (domStripped.length >= 6 && normName.startsWith(domStripped))
      ) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  }, accountName);

  if (accountRect) {
    logger.info(`[salework] Click tọa độ (${Math.round(accountRect.x)}, ${Math.round(accountRect.y)}) cho tài khoản: ${accountName}`);
    await page.mouse.click(accountRect.x, accountRect.y);
    logger.info(`[salework] Đã chọn tài khoản: ${accountName}`);
    await delay(1000);
    // Click ra ngoài để đóng dropdown
    await page.click('body', { position: { x: 700, y: 400 }, force: true });
    await delay(1000);
    return true;
  }

  logger.warn(`[salework] Không tìm thấy tài khoản "${accountName}"`);
  return false;
}

async function searchAndClickGroup(page, groupName) {
  logger.info(`[salework] Tìm nhóm: ${groupName}`);

  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    await delay(2500);
  }

  await screenshot(page, '03-search-filled');

  // Dùng page.evaluate để tìm vị trí element (1 round-trip), sau đó dùng
  // page.mouse.click() để fire đầy đủ pointer events mà Vue.js yêu cầu.
  // dispatchEvent() từ trong evaluate không kích hoạt được pointerdown/up → Vue không nhận.
  const norm = s => s.normalize('NFC').trim();
  const normName = norm(groupName);

  const rect = await page.evaluate((name) => {
    const norm = s => s.normalize('NFC').trim();
    const normName = norm(name);

    function getRect(el) {
      // Leo lên cha tìm phần tử có cursor pointer hoặc là LI/A
      let target = el;
      for (let i = 0; i < 6; i++) {
        if (!target.parentElement) break;
        const style = window.getComputedStyle(target);
        if (style.cursor === 'pointer' || target.tagName === 'LI' || target.tagName === 'A') break;
        target = target.parentElement;
      }
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // Ưu tiên selector cụ thể của Salework
    const candidates = document.querySelectorAll(
      '[class*="conversation-item"], [class*="contact-item"], [class*="chat-item"], ' +
      '[class*="list-item"], [class*="message-item"], li[class], a[class]'
    );
    for (const el of candidates) {
      const text = norm(el.textContent || '');
      if (text.includes(normName) && text.length < normName.length + 80) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }

    // Fallback: tìm span/div chứa text, lấy tọa độ phần tử cha clickable
    const all = document.querySelectorAll('span, div, li, a');
    for (const el of all) {
      const text = norm(el.textContent || '');
      if (text.includes(normName) && text.length < normName.length + 80) {
        return getRect(el);
      }
    }
    return null;
  }, groupName);

  if (rect) {
    logger.info(`[salework] Click tọa độ (${Math.round(rect.x)}, ${Math.round(rect.y)}) cho: ${groupName}`);
    await page.mouse.click(rect.x, rect.y);
    await delay(2500);
    return true;
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
      await randomDelay(200, 500);
      await msgInput.click();
      await randomDelay(250, 600);
      // Copy-paste để giữ nguyên xuống dòng (paste event không trigger gửi như Enter)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(text => navigator.clipboard.writeText(text), message);
      await page.keyboard.press('Control+v');
      logger.info('[salework] Đã nhập tin nhắn (paste)');
      await randomDelay(400, 900);
    }
  }

  await randomDelay(800, 1600);

  const sendSelectors = [
    'button:has-text("Gửi")',
    'button:has-text("Send")',
    '[class*="send"] button',
  ];
  for (const sel of sendSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await randomDelay(300, 800);
        await btn.click();
        logger.info('[salework] Click nút Gửi');
        await randomDelay(1800, 2600);
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

  const proxy = getZaloProxyForAccount(accountKey);
  if (proxy) logger.info(`[salework] Account "${zaloAccountName}" dùng proxy: ${proxy.server}`);

  if (proxy) {
    const health = await checkProxy(proxy);
    if (!health.ok) {
      return {
        success: false,
        error: `Proxy "${proxy.server}" không kết nối được: ${health.error}. Sửa proxy ở tab Tài khoản Zalo.`,
      };
    }
  }

  // Fingerprint riêng cho mỗi Zalo account (namespace 'zalo:' để tránh va FB)
  const { userAgent, viewport } = getProfileDeviceFingerprint(`zalo:${accountKey || zaloAccountName}`);
  const browser = await safeLaunchPersistentContext(profilePath, {
    headless: false,
    slowMo: 500,
    viewport,
    userAgent,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ...(proxy ? { proxy } : {}),
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
    await Promise.race([page.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
    await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
  }
}

module.exports = { postToZaloGroup, getSaleworkProfile };
