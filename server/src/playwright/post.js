const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');
const funMsg = require('../utils/fun-messages');
const { getFbProxyForProfile } = require('../utils/proxy');

// Browser context theo profile key
const browsers = {};

// Mutex per profile: prevents concurrent launchPersistentContext on same userDataDir
const launching = {};

let activeProfile = null;
let activeProfileData = null;

function setProfile(profileName) {
  const profileDir = path.resolve(__dirname, `../../playwright-data/${profileName}`);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile "${profileName}" không tồn tại — thêm tài khoản trong UI Web trước.`);
  }
  activeProfile = profileName;
  activeProfileData = { name: profileName, userDataDir: profileDir };
  logger.info(`Đã chọn profile: ${profileName}`);
  return activeProfileData;
}

// Kiểm tra profile có tồn tại không, KHÔNG mutate activeProfile global
// (để fail-fast validate trong request handler mà không gây race với job đang chạy)
function profileExists(profileName) {
  if (!profileName) return false;
  const profileDir = path.resolve(__dirname, `../../playwright-data/${profileName}`);
  return fs.existsSync(profileDir);
}

function getActiveProfile() {
  if (!activeProfile) {
    throw new Error('Chưa chọn profile!');
  }
  return activeProfileData;
}

async function getBrowser() {
  const profile = getActiveProfile();
  const key = activeProfile;

  // If a launch is already in progress for this profile, wait for it instead of launching a second instance
  if (launching[key]) {
    return await launching[key];
  }

  // .pages() không throw khi context đã đóng → thử newPage để kiểm tra thật,
  // nếu fail thì invalidate cache và tạo lại.
  if (browsers[key]) {
    try {
      const probe = await browsers[key].newPage();
      await probe.close();
      return browsers[key];
    } catch {
      try { await browsers[key].close(); } catch {}
      browsers[key] = null;
    }
  }

  const userDataDir = path.resolve(__dirname, '../../', profile.userDataDir);

  // Launch with retry — Chrome may still hold a lock on userDataDir for a few seconds after closing
  launching[key] = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        logger.info(`Retry launch browser (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
      try {
        const proxy = getFbProxyForProfile(key, profile);
        if (proxy && attempt === 0) logger.info(`Profile "${key}" dùng proxy: ${proxy.server}`);
        const ctx = await safeLaunchPersistentContext(userDataDir, {
          headless: false,
          slowMo: config.playwright.slowMo,
          viewport: { width: 1280, height: 720 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
          permissions: ['clipboard-read', 'clipboard-write'],
          ...(proxy ? { proxy } : {}),
        });

        // Khi user đóng tay cửa sổ Chromium, clear cache để lần sau tạo mới.
        ctx.once('close', () => {
          if (browsers[key] === ctx) browsers[key] = null;
        });

        browsers[key] = ctx;
        return ctx;
      } catch (e) {
        lastErr = e;
        logger.error(`Launch browser attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
    throw lastErr;
  })();

  try {
    return await launching[key];
  } finally {
    launching[key] = null;
  }
}

async function ensureLoggedIn(page) {
  const profile = getActiveProfile();
  const url = page.url();
  if (url.includes('login') || url.includes('checkpoint')) {
    throw new Error(`Session profile "${profile.name}" đã hết hạn (URL: ${url}). Mở lại profile từ tab "Quản lý tài khoản" để đăng nhập thủ công.`);
  }
}

async function tryClick(page, selectors, description, timeout = 5000) {
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.scrollIntoViewIfNeeded();
        await randomDelay(300, 800);
        await el.click({ force: true, timeout });
        logger.info(`${description}: ${selector}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  for (const selector of selectors) {
    try {
      const clicked = await page.evaluate((sel) => {
        const elements = document.querySelectorAll('div[role="button"], span, div[aria-label]');
        for (const el of elements) {
          const text = el.textContent?.trim();
          const label = el.getAttribute('aria-label');
          if (text === sel || label === sel) {
            el.click();
            return true;
          }
        }
        return false;
      }, selector.replace(/.*"(.+)".*/, '$1'));
      if (clicked) {
        logger.info(`${description} (JS click): ${selector}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function openCreatePost(page, isGroup = false) {
  // Đợi feed render xong trước khi tìm nút tạo bài
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const selectors = isGroup
    ? [
        '[aria-label*="Tạo bài viết"]',
        '[aria-label*="Create post"]',
        '[aria-label*="Create a post"]',
        'div[role="button"]:has-text("Bạn viết gì đi")',
        'div[role="button"]:has-text("viết gì đi")',
        'div[role="button"]:has-text("Viết gì đó")',
        'div[role="button"]:has-text("Bạn đang nghĩ gì")',
        'div[role="button"]:has-text("Write something")',
        'span:has-text("Bạn viết gì đi")',
        'span:has-text("viết gì đi")',
      ]
    : [
        '[aria-label*="Tạo bài viết"]',
        '[aria-label*="Create post"]',
        '[aria-label*="Create a post"]',
        'div[role="button"]:has-text("đang nghĩ gì")',
        'div[role="button"]:has-text("on your mind")',
        'div[role="button"]:has-text("Bạn viết gì đi")',
        'div[role="button"]:has-text("viết gì đi")',
        'div[role="button"]:has-text("Viết gì đó")',
        'div[role="button"]:has-text("Bạn đang nghĩ gì")',
        'div[role="button"]:has-text("Write something")',
        'span:has-text("bạn đang nghĩ gì")',
        'span:has-text("đang nghĩ gì thế")',
        'span:has-text("đang nghĩ gì")',
        'span:has-text("Bạn viết gì đi")',
        'span:has-text("viết gì đi")',
        '[aria-label*="nghĩ gì"]',
        '[aria-label*="on your mind"]',
        '[aria-label*="viết gì"]',
      ];

  return await tryClick(page, selectors, 'Mở popup tạo bài');
}

// Nhập text vào contenteditable: clipboard paste → execCommand → keyboard.type
async function pasteText(page, message) {
  // 1. Clipboard paste (instant, hoạt động tốt với React)
  try {
    await page.evaluate(async (txt) => navigator.clipboard.writeText(txt), message);
    await page.keyboard.press('Control+v');
    return;
  } catch {}

  // 2. execCommand insertText
  const ok = await page.evaluate((txt) => document.execCommand('insertText', false, txt), message);
  if (ok) return;

  // 3. keyboard.type toàn bộ một lần (không delay từng ký tự)
  await page.keyboard.type(message);
}

async function typeMessage(page, message) {
  if (!message) return true;

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = 0);
  });
  await randomDelay(500, 1000);

  const selectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="mind"]',
    'div[contenteditable="true"][aria-label*="nghĩ"]',
  ];

  for (const selector of selectors) {
    try {
      const editors = await page.$$(selector);
      for (const editor of editors) {
        const isVisible = await editor.isVisible();
        if (!isVisible) continue;
        await editor.scrollIntoViewIfNeeded();
        await randomDelay(300, 600);
        await editor.click({ force: true });
        await randomDelay(300, 500);
        await pasteText(page, message);
        logger.info('Đã nhập nội dung bài viết');
        return true;
      }
    } catch {
      continue;
    }
  }

  try {
    const placeholder = await page.$('div[role="dialog"] span:has-text("nghĩ gì")');
    if (placeholder) {
      await placeholder.click({ force: true });
      await randomDelay(300, 500);
      await pasteText(page, message);
      return true;
    }
  } catch {}

  return false;
}

async function attachImages(page, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return true;

  logger.info(`Đính kèm ${imagePaths.length} ảnh...`);
  let uploaded = false;
  let uploadMethod = '';

  // Tìm nút Ảnh/Video trong popup
  const photoSelectors = [
    'div[aria-label="Ảnh/video"]',
    'div[aria-label="Photo/video"]',
    'div[aria-label="Ảnh/Video"]',
  ];

  // Cách 1: Click nút Ảnh/Video + bắt filechooser (không mở dialog)
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20000 }),
      (async () => {
        await randomDelay(500, 1000);
        for (const sel of photoSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.click({ force: true });
              logger.info(`Click nút ảnh: ${sel}`);
              return;
            }
          } catch { continue; }
        }
        // Fallback: tìm trong thanh icon
        const icons = await page.$$('div[role="dialog"] div[role="button"]');
        for (const icon of icons) {
          const label = await icon.getAttribute('aria-label');
          if (label && (label.includes('nh') || label.includes('hoto') || label.includes('ideo'))) {
            await icon.click({ force: true });
            logger.info(`Click icon ảnh: ${label}`);
            return;
          }
        }
      })(),
    ]);

    await fileChooser.setFiles(imagePaths);
    uploaded = true;
    uploadMethod = 'filechooser';
    logger.info(`Upload ${imagePaths.length} ảnh thành công (filechooser)`);
  } catch (e) {
    logger.error(`Filechooser failed: ${e.message}`);
  }

  // Cách 2: Fallback - tìm input[type=file] trực tiếp.
  // FB render nhiều input file ẩn (ảnh, video, profile pic) — input đầu tiên
  // có thể chỉ accept 1 file hoặc không phải input ảnh post → upload thiếu.
  // Ưu tiên input có accept="image/*" + multiple để khớp post photo input.
  if (!uploaded) {
    const candidates = await page.$$('input[type="file"]');
    const scored = [];
    for (const input of candidates) {
      const accept = (await input.getAttribute('accept')) || '';
      const multiple = (await input.getAttribute('multiple')) !== null;
      let score = 0;
      if (accept.includes('image')) score += 2;
      if (multiple || imagePaths.length === 1) score += 1;
      scored.push({ input, score, accept, multiple });
    }
    scored.sort((a, b) => b.score - a.score);

    for (const { input, score, accept, multiple } of scored) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        uploadMethod = `direct input score=${score} accept="${accept}" multiple=${multiple}`;
        logger.info(`Upload ${imagePaths.length} ảnh thành công (${uploadMethod})`);
        break;
      } catch (e) {
        logger.warn(`Direct input score=${score} fail: ${e.message}`);
        continue;
      }
    }
  }

  if (!uploaded) {
    logger.error('KHÔNG UPLOAD ĐƯỢC ẢNH!');
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-upload.png') });
    return false;
  }

  // Verify: chờ FB render preview rồi đếm thumbnail trong dialog. Nếu thiếu
  // (vd FB nuốt mất ảnh do input không support multiple), log warning + chụp
  // ảnh debug — không throw, vì có thể vẫn đăng được phần ảnh đã nhận.
  await randomDelay(3000, 6000);
  if (imagePaths.length > 1) {
    try {
      const thumbCount = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return -1;
        const imgs = dialog.querySelectorAll('img');
        let count = 0;
        for (const img of imgs) {
          const src = img.getAttribute('src') || '';
          // FB preview ảnh dạng blob: hoặc data: URL trước khi upload xong.
          if (src.startsWith('blob:') || src.startsWith('data:')) count++;
        }
        return count;
      });
      if (thumbCount >= 0 && thumbCount < imagePaths.length) {
        logger.warn(`Chỉ thấy ${thumbCount}/${imagePaths.length} thumbnail (method=${uploadMethod}) — FB có thể đã nuốt mất ảnh`);
        await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-upload-mismatch-${Date.now()}.png`) }).catch(() => {});
      } else if (thumbCount >= imagePaths.length) {
        logger.info(`Verify OK: ${thumbCount} thumbnail trong dialog`);
      }
    } catch (e) {
      logger.warn(`Không count được thumbnail: ${e.message}`);
    }
  }

  return uploaded;
}

async function submitPost(page) {
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  const step1 = await tryClick(page, [
    'div[aria-label="Tiếp"]',
    'div[aria-label="Next"]',
    'div[aria-label="Đăng"]',
    'div[aria-label="Post"]',
  ], 'Bước 1');

  if (!step1) {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await randomDelay(200, 400);
    }
    await page.keyboard.press('Enter');
  }

  await randomDelay(2000, 4000);

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  const step2 = await tryClick(page, [
    'div[aria-label="Đăng"]',
    'div[aria-label="Post"]',
  ], 'Bước 2 - Đăng');

  if (!step2) {
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('div[role="button"]');
      for (const btn of buttons) {
        if (btn.getAttribute('aria-label') === 'Đăng' || btn.getAttribute('aria-label') === 'Post') {
          btn.click();
          return;
        }
      }
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.trim() === 'Đăng' || span.textContent.trim() === 'Post') {
          span.closest('div[role="button"]')?.click();
          return;
        }
      }
    });
  }

  await randomDelay(5000, 8000);

  const stillOpen = await page.$('div[role="dialog"] span:has-text("Tạo bài viết")');
  if (stillOpen) {
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-failed.png') });
    return { success: false };
  }

  return { success: true };
}

/**
 * Chụp screenshot bài viết của profile đang active
 */

async function postToPersonal(message, imagePaths = []) {
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[postToPersonal ${profileSnap.name}]`;
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length})`);

  const browser = await getBrowser();
  logger.info(`${tag} got browser (+${Date.now() - t0}ms)`);
  const page = await browser.newPage();

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    logger.info(`${tag} loaded fb home (+${Date.now() - t0}ms, url=${page.url()})`);
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    const tOpen = Date.now();
    if (!(await openCreatePost(page, false))) {
      const debugPath = path.resolve(__dirname, `../../logs/debug-open-${profileSnap.name}-${Date.now()}.png`);
      await page.screenshot({ path: debugPath }).catch(() => {});
      const pageUrl = page.url();
      const visibleHint = await page.evaluate(() => {
        const candidates = document.querySelectorAll('[aria-label], div[role="button"]');
        for (const el of candidates) {
          const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
          if (/nghĩ|viết|mind|post|write/i.test(text) && text.length < 80) return text;
        }
        return '';
      }).catch(() => '');
      logger.error(`${tag} openCreatePost FAIL (sau ${Date.now() - tOpen}ms) — url=${pageUrl}, hint="${visibleHint}", screenshot=${path.basename(debugPath)}`);
      throw new Error(`${funMsg.errPopupPersonal()} [url=${pageUrl}${visibleHint ? `, hint="${visibleHint}"` : ''}, screenshot=${path.basename(debugPath)}]`);
    }
    logger.info(`${tag} mở popup OK (+${Date.now() - t0}ms)`);
    await randomDelay(2000, 3000);

    if (imagePaths.length > 0) {
      const tImg = Date.now();
      const imgOk = await attachImages(page, imagePaths);
      if (!imgOk) throw new Error(funMsg.errUpload() + ' (xem logs/debug-upload.png)');
      logger.info(`${tag} attach ${imagePaths.length} ảnh xong (${Date.now() - tImg}ms)`);
    }
    await randomDelay(1500, 2500);

    if (message) {
      const tType = Date.now();
      if (!(await typeMessage(page, message))) throw new Error(funMsg.errTypeContent());
      logger.info(`${tag} nhập text xong (${Date.now() - tType}ms)`);
    }
    await randomDelay(1000, 2000);

    const tSubmit = Date.now();
    const result = await submitPost(page);
    if (!result.success) {
      // FB reject phổ biến nhất với clone account: đăng ảnh không kèm caption.
      // Đổi error chung "Thôi xong!" thành hướng dẫn cụ thể để user biết phải làm gì.
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption (vài dòng nội dung) rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/debug-failed.png)`);
    }
    logger.info(`${tag} submit xong (${Date.now() - tSubmit}ms) — total ${Date.now() - t0}ms ✅`);
    return { success: true, target: 'personal' };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function postToGroup(groupId, message, imagePaths = []) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const profile = getActiveProfile();
    logger.info(`Đăng bài lên group ${groupId} (${profile.name})...`);
    await page.goto(`https://www.facebook.com/groups/${groupId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, true))) {
      await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-group-open.png') });
      throw new Error(funMsg.errPopupGroup());
    }
    await randomDelay(2000, 3000);

    // Đính kèm ảnh TRƯỚC
    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (!imgOk) throw new Error(funMsg.errUpload() + ' (xem logs/debug-upload.png)');
    }
    await randomDelay(1500, 2500);

    // Nhập text SAU - group có 2 ô: "Thêm tiêu đề" và "Tạo bài viết..."
    // Cần click vào ô thứ 2
    if (message) {
      await page.evaluate(() => {
        document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = 0);
      });
      await randomDelay(500, 1000);

      let typed = false;
      try {
        // Tìm tất cả textbox trong dialog, lấy ô thứ 2 (ô "Tạo bài viết...")
        const editors = await page.$$('div[role="dialog"] div[contenteditable="true"][role="textbox"]');
        const targetEditor = editors.length >= 2 ? editors[1] : editors[0];
        if (targetEditor) {
          await targetEditor.scrollIntoViewIfNeeded();
          await targetEditor.click({ force: true });
          await randomDelay(300, 500);
          await pasteText(page, message);
          typed = true;
          logger.info('Đã nhập nội dung group (ô thứ 2)');
        }
      } catch (e) {
        logger.error(`Lỗi nhập text group: ${e.message}`);
      }

      if (!typed) {
        // Fallback: dùng typeMessage bình thường
        await typeMessage(page, message);
      }
    }
    await randomDelay(1000, 2000);

    // Nhấn Đăng
    const result = await submitPost(page);
    if (!result.success) {
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption (vài dòng nội dung) rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/debug-failed.png)`);
    }

    logger.info(`Đã đăng bài group ${groupId} thành công!`);
    return { success: true, target: `group:${groupId}` };
  } catch (error) {
    logger.error(`Lỗi: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  for (const key of Object.keys(browsers)) {
    if (browsers[key]) {
      await browsers[key].close();
      browsers[key] = null;
    }
  }
}

module.exports = { setProfile, profileExists, getActiveProfile, postToPersonal, postToGroup, closeBrowser };
