'use strict';
const { resolveNewPostEntry, resolveDialogButton, resolveFileInput, resolveCaptionStep } = require('./ig-composer');
const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const { withClipboard } = require('../utils/clipboard-queue');
const path = require('path');
const fs = require('fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay, humanType } = require('../utils/delay');
const { parseProxy } = require('../utils/proxy');

// GIAI ĐOẠN 1 (script thủ công, chưa gắn UI/route): module độc lập với
// src/playwright/post.js (Facebook) — profile Instagram lưu riêng ở
// playwright-data/ig-<key> để không lẫn session với tài khoản Facebook cùng tên.
// Chuẩn hoá ảnh hay hàng đợi nhiều tài khoản song song: những phần đó chỉ thêm
// khi xác nhận Instagram thực sự cần, tránh đoán trước cho vấn đề chưa gặp.

const browsers = {};
const METAFILE = path.resolve(__dirname, '../../config/profiles-meta.json');

function profileDirFor(profileKey) {
  return path.resolve(__dirname, `../../playwright-data/ig-${profileKey}`);
}

function profileExists(profileKey) {
  return fs.existsSync(profileDirFor(profileKey));
}

// Đăng nhập thủ công (xem local-server.js) mở Google Chrome qua proxy của account nếu
// có cấu hình — session instagram.com bị gắn với IP đó. Nếu lúc đăng bài mở lại
// cùng profile bằng IP khác (không proxy), Instagram coi là thiết bị lạ và bắt
// đăng nhập lại, dù vừa đăng nhập đúng tài khoản. Phải dùng cùng proxy ở cả hai nơi.
function proxyForProfile(profileKey) {
  try {
    const meta = JSON.parse(fs.readFileSync(METAFILE, 'utf8'));
    return parseProxy(meta[profileKey]?.proxy);
  } catch {
    return null;
  }
}

async function getBrowser(profileKey) {
  if (!profileKey) throw new Error('Thiếu tài khoản Instagram');
  if (browsers[profileKey]) {
    try {
      const probe = await Promise.race([
        browsers[profileKey].newPage(),
        new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 8000)),
      ]);
      await Promise.race([probe.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
      return browsers[profileKey];
    } catch {
      await Promise.race([
        browsers[profileKey].close(),
        new Promise(r => setTimeout(r, 10000)),
      ]).catch(() => {});
      browsers[profileKey] = null;
    }
  }

  const userDataDir = profileDirFor(profileKey);
  if (!fs.existsSync(userDataDir)) {
    throw new Error(`Profile Instagram "${profileKey}" không tồn tại — mở Google Chrome đăng nhập thủ công trước (xem server/test-ig-composer.js).`);
  }

  const proxyOpt = proxyForProfile(profileKey);
  const ctx = await safeLaunchPersistentContext(userDataDir, {
    stealth: false,
    channel: 'chrome',
    headless: false,
    slowMo: config.playwright.slowMo,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(proxyOpt ? { proxy: proxyOpt } : {}),
  });
  ctx.once('close', () => { if (browsers[profileKey] === ctx) browsers[profileKey] = null; });
  browsers[profileKey] = ctx;
  return ctx;
}

async function closeBrowser(profileKey) {
  const ctx = browsers[profileKey];
  if (!ctx) return;
  browsers[profileKey] = null;
  await Promise.race([ctx.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
}

function ensureLoggedIn(page, profileKey) {
  const url = page.url();
  if (/\/accounts\/login/.test(url)) {
    throw new Error(`Profile Instagram "${profileKey}" chưa đăng nhập hoặc session hết hạn (URL: ${url}). Mở lại profile để đăng nhập thủ công.`);
  }
}

async function saveDebugShot(page, prefix) {
  const name = `${prefix}-${Date.now()}.png`;
  try {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/${name}`) });
  } catch (e) {
    logger.warn(`saveDebugShot(${prefix}) lỗi: ${e.message}`);
  }
  return name;
}

async function pasteCaption(page, editor, message) {
  await editor.click();
  try {
    await withClipboard(async () => {
      await page.evaluate(async (txt) => navigator.clipboard.writeText(txt), message);
      await page.keyboard.press('Control+v');
    });
  } catch {
    const ok = await page.evaluate((txt) => document.execCommand('insertText', false, txt), message);
    if (!ok) await humanType(page.keyboard, message);
  }
  await randomDelay(400, 800);
  const typed = (await editor.textContent() || '').trim();
  if (typed !== message.trim()) {
    throw new Error('Caption trong ô soạn không khớp nội dung cần đăng.');
  }
}

// Sau "Tiếp" của bước cắt ảnh, Instagram có thể hiện thêm bước chỉnh sửa/bộ lọc
// trước khi tới bước caption, hoặc bỏ qua thẳng — thử tối đa 3 lần bấm "Tiếp",
// dừng ngay khi tới được bước caption.
async function advanceToCaptionStep(page) {
  for (let i = 0; i < 3; i++) {
    try {
      return await resolveCaptionStep(page, { timeout: 4000 });
    } catch {
      const next = await resolveDialogButton(page, '^(Tiếp|Next)$', { timeout: 6000 });
      await next.click();
      await randomDelay(800, 1500);
    }
  }
  return await resolveCaptionStep(page, { timeout: 8000 });
}

async function postToFeed(profileKey, message, imagePaths = [], shouldCancel = null) {
  for (const file of imagePaths) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Ảnh không tồn tại hoặc rỗng: ${path.basename(file)}; đã dừng đăng bài.`);
    }
  }

  const t0 = Date.now();
  const tag = `[ig:postToFeed ${profileKey}]`;
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length})`);

  const browser = await getBrowser(profileKey);
  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s')), 30000)),
    ]);
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(1500, 2500);
    ensureLoggedIn(page, profileKey);

    const entry = await resolveNewPostEntry(page);
    await entry.click();
    await randomDelay(800, 1500);

    const fileInput = await resolveFileInput(page);
    await fileInput.setInputFiles(imagePaths);
    logger.info(`${tag} đã chọn ${imagePaths.length} ảnh`);
    await randomDelay(1000, 2000);

    // Chọn tỷ lệ "Original" để giữ đúng kích thước ảnh, tránh Instagram tự cắt
    // vuông. 5 lần thử trước (dò DOM scope dialog/toàn trang, loại bản
    // aria-hidden, phím Enter) đều không bấm trúng — đổi hẳn cách tiếp cận:
    // dùng locator text gốc của Playwright (đã xử lý sẵn các trường hợp DOM
    // phức tạp) + force:true để bắn thẳng click, bỏ qua việc tự dò phần tử.
    // Không chặn đăng bài nếu bước này vẫn lỗi — dùng tỷ lệ mặc định.
    try {
      const ratioBtn = await resolveDialogButton(page, '^(Chọn kích thước cắt|Select crop)$', { timeout: 6000 });
      await ratioBtn.click();
      await randomDelay(500, 900);
      await page.getByText(/^(Original|Gốc)$/i, { exact: true }).last().click({ force: true, timeout: 4000 });
      await randomDelay(400, 800);
      logger.info(`${tag} đã chọn tỷ lệ Original (không cắt ảnh)`);
    } catch (e) {
      logger.warn(`${tag} không chọn được tỷ lệ Original, dùng mặc định: ${e.message}`);
    }

    const cropNext = await resolveDialogButton(page, '^(Tiếp|Next)$');
    await cropNext.click();
    await randomDelay(800, 1500);

    const { editor, shareButton } = await advanceToCaptionStep(page);

    if (message) {
      await pasteCaption(page, editor, message);
      logger.info(`${tag} đã nhập caption`);
    }

    if (shouldCancel && shouldCancel()) {
      logger.info(`${tag} đã bị dừng theo yêu cầu người dùng — không bấm Chia sẻ`);
      return { success: false, error: 'Đã dừng theo yêu cầu người dùng', cancelled: true };
    }

    await shareButton.click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 30000 }).catch(() => {});
    logger.info(`${tag} đăng xong (+${Date.now() - t0}ms)`);
    await randomDelay(2000, 3000);
    return { success: true };
  } catch (error) {
    const shot = page ? await saveDebugShot(page, `debug-ig-${profileKey}`) : null;
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: `${error.message}${shot ? ` (xem logs/${shot})` : ''}` };
  } finally {
    await closeBrowser(profileKey);
  }
}

module.exports = { getBrowser, closeBrowser, profileExists, postToFeed };
