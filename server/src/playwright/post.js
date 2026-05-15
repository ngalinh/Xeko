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

// Đệ quy tìm permalink trong payload GraphQL.
// FB shape thay đổi nhiều version → duyệt key bất kỳ thay vì hardcode path.
function extractPostUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return null;

  const direct = obj.url || obj.permalink_url || obj.wwwURL || obj.share_url;
  if (typeof direct === 'string' && /facebook\.com\/[^"\s]*\/(posts|permalink|groups|story\.php|photo)/.test(direct)) {
    return direct;
  }

  // Một số mutation trả story + actor + legacy id → ghép URL
  const story = obj.story;
  if (story && typeof story === 'object') {
    const actor = story.actor || (Array.isArray(story.actors) ? story.actors[0] : null);
    const actorId = actor && actor.id;
    const legacy = story.legacy_story_api_id || story.post_id;
    if (actorId && legacy) {
      return `https://www.facebook.com/${actorId}/posts/${legacy}`;
    }
  }

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') {
      const r = extractPostUrl(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// story_create chỉ trả post_id + story_id (numeric/base64) — không có URL.
// Dùng làm fallback nếu listener timeout mà chưa bắt được URL.
function extractPostId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (obj.story_create && typeof obj.story_create === 'object') {
    return obj.story_create.post_id || obj.story_create.story_id || null;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') {
      const r = extractPostId(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// Parse body GraphQL: thử whole-JSON trước (response minified 1 line),
// fallback NDJSON (response @stream/@defer nhiều chunk).
function parseGraphQLBody(text) {
  const results = [];
  try {
    results.push(JSON.parse(text));
    return results;
  } catch {}
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { results.push(JSON.parse(t)); } catch { continue; }
  }
  return results;
}

// Lắng nghe response GraphQL để bắt permalink bài vừa đăng.
// FB trả NDJSON (nhiều JSON cách nhau bằng \n), parse từng dòng.
function listenForPostUrl(page, { timeoutMs = 20000, debug = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let fallbackPostId = null; // backup: post_id từ story_create nếu không bắt được URL full
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      page.off('response', handler);
      resolve(val);
    };
    const timer = setTimeout(() => {
      // Hết timeout: nếu có post_id từ story_create → ghép URL fallback
      if (fallbackPostId) {
        const fb = `https://www.facebook.com/${fallbackPostId}`;
        logger.info(`postUrl fallback từ post_id: ${fb}`);
        finish(fb);
      } else {
        finish(null);
      }
    }, timeoutMs);

    async function handler(res) {
      const url = res.url();
      try {
        if (!/graphql|composer|story_create|ajax\/.*post|api\/post/i.test(url)) return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text')) return;

        let text;
        try {
          text = await res.text();
        } catch (e) {
          if (debug) logger.warn(`[BODY-FAIL] ${url.slice(0, 120)}: ${e.message}`);
          return;
        }

        const jsons = parseGraphQLBody(text);
        if (debug && jsons.length === 0 && text.length > 100) {
          logger.warn(`[PARSE-FAIL] ${url.slice(0, 120)} len=${text.length} preview=${text.slice(0, 300)}`);
        }

        for (const json of jsons) {
          const found = extractPostUrl(json);
          if (found) {
            logger.info(`Bắt được postUrl từ GraphQL: ${found}`);
            finish(found);
            return;
          }
          if (!fallbackPostId) {
            const pid = extractPostId(json);
            if (pid) {
              fallbackPostId = pid;
              logger.info(`Bắt được post_id (fallback): ${pid}`);
            }
          }
        }
      } catch (e) {
        if (debug) logger.warn(`[HANDLER-ERR] ${url.slice(0, 120)}: ${e.message}`);
      }
    }
    page.on('response', handler);
  });
}

// Click row "Chia sẻ lên nhóm" trong dialog "Cài đặt bài viết".
// :has-text() khớp cả parent → click có thể trượt → walk DOM từ text node lên row
// clickable thật ([role="button"]/[role="listitem"]).
async function clickShareToGroupsRow(page) {
  const okJs = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return { ok: false, reason: 'no-dialog' };

    const TARGETS = ['Chia sẻ lên nhóm', 'Share to groups', 'Share to Groups'];
    const candidates = dialog.querySelectorAll('span, h2, h3, h4, div');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!TARGETS.includes(text)) continue;

      let row = el;
      for (let i = 0; i < 10 && row.parentElement; i++) {
        row = row.parentElement;
        const role = row.getAttribute('role');
        if (role === 'button' || role === 'listitem' || row.tagName === 'BUTTON') {
          row.click();
          return { ok: true, via: role || row.tagName };
        }
      }
      // Fallback: click chính text element
      el.click();
      return { ok: true, via: 'text-direct' };
    }
    return { ok: false, reason: 'text-not-found' };
  });

  if (okJs.ok) {
    logger.info(`shareToGroups: click "Chia sẻ lên nhóm" OK (${okJs.via})`);
    return true;
  }
  logger.warn(`shareToGroups: click "Chia sẻ lên nhóm" FAIL (${okJs.reason})`);
  return false;
}

// Đợi dialog thứ cấp "Chia sẻ lên nhóm" (list checkbox) xuất hiện
async function waitForShareDialog(page, timeoutMs = 10000) {
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const last = dialogs[dialogs.length - 1];
      if (!last) return false;
      const text = last.textContent || '';
      return (text.includes('Chọn nhóm') || text.includes('Choose groups') || text.includes('Choose group')) &&
             last.querySelectorAll('[role="checkbox"]').length > 0;
    }, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// Click "Xong" trong dialog chia sẻ nhóm
async function clickXongInShareDialog(page) {
  const ok = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;
    const candidates = dialog.querySelectorAll('div[role="button"], button, [aria-label]');
    for (const btn of candidates) {
      const text = (btn.textContent || '').trim();
      const label = btn.getAttribute('aria-label') || '';
      if (text === 'Xong' || text === 'Done' || label === 'Xong' || label === 'Done') {
        btn.click();
        return true;
      }
    }
    return false;
  });
  return ok;
}

// Trong dialog "Cài đặt bài viết": click "Chia sẻ lên nhóm" → tick checkbox theo
// keyword (substring, case-insensitive) → "Xong". FB không có ô search → scroll
// lazy-load. Giới hạn 9 nhóm/lần.
async function shareToGroupsInSettings(page, keywords) {
  const list = (keywords || []).map(k => String(k).trim()).filter(Boolean);
  if (list.length === 0) return { selected: 0, missed: [] };
  if (list.length > 9) {
    logger.warn(`shareToGroups: yêu cầu ${list.length} nhóm > giới hạn 9 → chỉ lấy 9 đầu`);
  }
  const targets = list.slice(0, 9);
  logger.info(`shareToGroups: chia sẻ lên ${targets.length} nhóm — ${targets.join(', ')}`);

  // Đợi dialog "Cài đặt bài viết" render đủ row trước khi tìm "Chia sẻ lên nhóm"
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const last = dialogs[dialogs.length - 1];
      if (!last) return false;
      const text = last.textContent || '';
      return text.includes('Chia sẻ lên nhóm') || text.includes('Share to groups');
    }, { timeout: 15000 });
  } catch {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-no-share-row-${Date.now()}.png`) }).catch(() => {});
    logger.warn('shareToGroups: không thấy row "Chia sẻ lên nhóm" trong "Cài đặt bài viết"');
    return { selected: 0, missed: targets };
  }
  await randomDelay(800, 1500);

  if (!(await clickShareToGroupsRow(page))) {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-share-click-${Date.now()}.png`) }).catch(() => {});
    return { selected: 0, missed: targets };
  }

  if (!(await waitForShareDialog(page))) {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-share-dialog-${Date.now()}.png`) }).catch(() => {});
    logger.warn('shareToGroups: dialog "Chọn nhóm" không mở sau khi click — bỏ qua');
    return { selected: 0, missed: targets };
  }
  await randomDelay(500, 1000);

  const selected = [];
  const missed = [];
  for (const kw of targets) {
    const ok = await selectGroupCheckbox(page, kw);
    if (ok) selected.push(kw); else missed.push(kw);
  }

  await randomDelay(500, 1000);
  if (!(await clickXongInShareDialog(page))) {
    logger.warn('shareToGroups: không click được "Xong" — fallback Enter');
    await page.keyboard.press('Enter');
  } else {
    logger.info('shareToGroups: click "Xong" OK');
  }
  await randomDelay(1500, 2500);

  return { selected: selected.length, missed };
}

// Submit flow RIÊNG cho path share-to-group — tách hẳn submitPost của postToPersonal
// để không ảnh hưởng đăng riêng lẻ. Click Tiếp → Cài đặt bài viết → Chia sẻ lên nhóm
// → tick group → Xong → Đăng.
async function submitPostAndShareGroups(page, keywords) {
  const urlPromise = listenForPostUrl(page, { timeoutMs: 25000, debug: false });

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  // Bước 1: click "Tiếp" để vào "Cài đặt bài viết". KHÔNG fallback "Đăng" — sẽ skip
  // mất bước chọn nhóm.
  const step1 = await tryClick(page, [
    'div[aria-label="Tiếp"]',
    'div[aria-label="Next"]',
  ], 'Bước 1 - Tiếp');

  if (!step1) {
    logger.warn('submitPostAndShareGroups: không click được "Tiếp" — fallback Tab+Enter');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await randomDelay(200, 400);
    }
    await page.keyboard.press('Enter');
  }
  await randomDelay(2000, 4000);

  // Bước 2: trong "Cài đặt bài viết", click "Chia sẻ lên nhóm" → tick group → Xong
  const shareResult = await shareToGroupsInSettings(page, keywords);
  logger.info(`submitPostAndShareGroups: shared ${shareResult.selected}/${keywords.length}${shareResult.missed.length ? ` (miss: ${shareResult.missed.join(', ')})` : ''}`);

  // Bước 3: click "Đăng" để post
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  const step3 = await tryClick(page, [
    'div[aria-label="Đăng"]',
    'div[aria-label="Post"]',
  ], 'Bước 3 - Đăng');

  if (!step3) {
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('div[role="button"]');
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label');
        if (label === 'Đăng' || label === 'Post') {
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

  const stillOpen = await page.$('div[role="dialog"] span:has-text("Tạo bài viết"), div[role="dialog"] span:has-text("Cài đặt bài viết")');
  if (stillOpen) {
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-share-submit-failed.png') }).catch(() => {});
    return { success: false, sharedGroups: shareResult.selected };
  }

  const postUrl = await urlPromise;
  if (!postUrl) logger.warn('submitPostAndShareGroups: không bắt được postUrl từ GraphQL (timeout)');
  return { success: true, postUrl, sharedGroups: shareResult.selected, missedGroups: shareResult.missed };
}

// Scroll dialog cuối cùng cho đến khi tìm thấy checkbox của nhóm chứa keyword.
async function selectGroupCheckbox(page, keyword) {
  const kwLower = keyword.toLowerCase();
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await page.evaluate((kw) => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return { status: 'no-dialog' };

      const checkboxes = dialog.querySelectorAll('[role="checkbox"]');
      for (const cb of checkboxes) {
        let row = cb;
        for (let i = 0; i < 6 && row.parentElement; i++) {
          row = row.parentElement;
          const text = (row.textContent || '').toLowerCase();
          if (text.includes(kw)) {
            const rect = cb.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return { status: 'hidden' };
            const already = cb.getAttribute('aria-checked') === 'true';
            if (!already) cb.click();
            return { status: 'ok', alreadyChecked: already };
          }
        }
      }

      const scrollers = dialog.querySelectorAll('*');
      let scroller = dialog;
      for (const el of scrollers) {
        if (el.scrollHeight > el.clientHeight + 20) { scroller = el; break; }
      }
      scroller.scrollBy(0, 400);
      return { status: 'scrolled' };
    }, kwLower);

    if (result.status === 'ok') {
      logger.info(`shareToGroups: nhóm "${keyword}" ${result.alreadyChecked ? '(đã chọn trước)' : 'check OK'}`);
      return true;
    }
    if (result.status === 'no-dialog') {
      logger.warn(`shareToGroups: nhóm "${keyword}" — không thấy dialog`);
      return false;
    }
    await randomDelay(300, 500);
  }
  logger.warn(`shareToGroups: nhóm "${keyword}" — không tìm thấy sau ${30} lần scroll`);
  return false;
}

async function submitPost(page) {
  // Phải attach listener TRƯỚC khi click — response GraphQL về sau vài trăm ms
  const urlPromise = listenForPostUrl(page, { timeoutMs: 25000, debug: false });

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

  const postUrl = await urlPromise;
  if (!postUrl) logger.warn('Không bắt được postUrl từ GraphQL (timeout)');
  return { success: true, postUrl };
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
    logger.info(`${tag} submit xong (${Date.now() - tSubmit}ms) — total ${Date.now() - t0}ms ✅${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal', postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

// Đăng bài cá nhân + đồng thời chia sẻ lên nhiều nhóm trong cùng 1 lần đăng,
// dùng tính năng "Chia sẻ lên nhóm" trong dialog "Cài đặt bài viết" của FB.
// groupKeywords: mảng tên nhóm (substring, case-insensitive). FB giới hạn 9.
async function postPersonalAndShareToGroups(message, imagePaths = [], groupKeywords = []) {
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[postPersonalAndShareToGroups ${profileSnap.name}]`;
  const kwList = (groupKeywords || []).filter(Boolean);
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length}, nhóm=${kwList.length})`);

  if (kwList.length === 0) {
    return await postToPersonal(message, imagePaths);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, false))) {
      const debugPath = path.resolve(__dirname, `../../logs/debug-open-${profileSnap.name}-${Date.now()}.png`);
      await page.screenshot({ path: debugPath }).catch(() => {});
      throw new Error(`${funMsg.errPopupPersonal()} [screenshot=${path.basename(debugPath)}]`);
    }
    await randomDelay(2000, 3000);

    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (!imgOk) throw new Error(funMsg.errUpload() + ' (xem logs/debug-upload.png)');
    }
    await randomDelay(1500, 2500);

    if (message) {
      if (!(await typeMessage(page, message))) throw new Error(funMsg.errTypeContent());
    }
    await randomDelay(1000, 2000);

    const result = await submitPostAndShareGroups(page, kwList);
    if (!result.success) {
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/debug-share-submit-failed.png)`);
    }
    logger.info(`${tag} xong (${Date.now() - t0}ms) ✅ shared=${result.sharedGroups}/${kwList.length}${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal+groups', postUrl: result.postUrl || null, groups: kwList, sharedGroups: result.sharedGroups, missedGroups: result.missedGroups };
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

    logger.info(`Đã đăng bài group ${groupId} thành công!${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: `group:${groupId}`, postUrl: result.postUrl || null };
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

// =============================================================================
// QUICK POST v2 — flow đăng nhanh build lại từ đầu theo UI FB mới (2026)
// Flow: Tạo bài viết → nhập text + ảnh → Tiếp → Cài đặt bài viết →
//       Chia sẻ lên nhóm → tick groups → Xong → Đăng
// Mỗi step có log + screenshot debug khi fail. KHÔNG dùng chung helper với flow cũ.
// =============================================================================

async function _qpLog(steps, line) {
  logger.info(`[quickPost] ${line}`);
  steps.push(line);
}

async function _qpScreenshot(page, name) {
  try {
    const p = path.resolve(__dirname, `../../logs/qp-${name}-${Date.now()}.png`);
    await page.screenshot({ path: p });
    return path.basename(p);
  } catch { return null; }
}

// --- Step 1: mở popup "Tạo bài viết" — DELEGATE sang openCreatePost cũ (proven) ---
// Wrap openCreatePost để giữ logging step + verify dialog mở.
async function qpStep1OpenComposer(page, steps) {
  const ok = await openCreatePost(page, false);
  if (!ok) {
    const shot = await _qpScreenshot(page, 'step1-fail');
    await _qpLog(steps, `Step 1: openCreatePost (cũ) fail (screenshot=${shot})`);
    return false;
  }

  // Verify: dialog "Tạo bài viết" xuất hiện (delay + check)
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        const t = d.textContent || '';
        if (t.includes('Tạo bài viết') || t.includes('Create post') || t.includes('Create Post')) return true;
      }
      return false;
    }, { timeout: 10000 });
    await _qpLog(steps, 'Step 1: openCreatePost (cũ) OK — dialog "Tạo bài viết" mở');
    return true;
  } catch {
    await _qpLog(steps, 'Step 1: openCreatePost (cũ) clicked nhưng dialog "Tạo bài viết" không mở sau 10s');
    return false;
  }
}

// --- Step 2: upload ảnh + nhập text — DELEGATE sang attachImages + typeMessage cũ ---
// Thứ tự + timing y hệt postToPersonal flow cũ (đã proven):
//   randomDelay(2000-3000) → attachImages → randomDelay(1500-2500) → typeMessage → randomDelay(1000-2000)
async function qpStep2FillContent(page, steps, message, imagePaths) {
  await randomDelay(2000, 3000);

  // 2a. Upload ảnh (TRƯỚC như flow cũ)
  if (imagePaths && imagePaths.length > 0) {
    const ok = await attachImages(page, imagePaths);
    if (!ok) {
      const shot = await _qpScreenshot(page, 'step2a-fail');
      await _qpLog(steps, `Step 2a: attachImages (cũ) fail (screenshot=${shot})`);
      return false;
    }
    await _qpLog(steps, `Step 2a: attachImages (cũ) OK, ${imagePaths.length} ảnh`);
  } else {
    await _qpLog(steps, 'Step 2a: skip — không có ảnh');
  }

  await randomDelay(1500, 2500);

  // 2b. Nhập text (SAU như flow cũ)
  if (message && message.length > 0) {
    const ok = await typeMessage(page, message);
    if (!ok) {
      const shot = await _qpScreenshot(page, 'step2b-fail');
      await _qpLog(steps, `Step 2b: typeMessage (cũ) fail (screenshot=${shot})`);
      return false;
    }
    await _qpLog(steps, `Step 2b: typeMessage (cũ) OK, ${message.length} ký tự`);
  } else {
    await _qpLog(steps, 'Step 2b: skip — không có message');
  }

  await randomDelay(1000, 2000);
  return true;
}

// --- Step 3: click "Tiếp" để sang dialog "Cài đặt bài viết" ---
// Pattern broad scope (toàn document, không lock dialog vì FB có thể render portal):
// scroll dialog BOTTOM (theo flow cũ submitPost) → phase 1 aria-label, phase 2 text exact.
// Có Tab+Enter fallback (theo flow cũ) khi click thường fail.
async function qpStep3ClickNext(page, steps) {
  // Scroll tất cả dialog xuống BOTTOM trước khi tìm button submit (theo flow cũ submitPost)
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(800, 1500);

  // Chờ button "Tiếp" xuất hiện visible (toàn document, không scope dialog)
  try {
    await page.waitForFunction(() => {
      const buttons = document.querySelectorAll('div[role="button"], button[role="button"], button');
      for (const btn of buttons) {
        const aria = btn.getAttribute('aria-label') || '';
        const text = (btn.textContent || '').trim();
        if (aria === 'Tiếp' || aria === 'Next' || text === 'Tiếp' || text === 'Next') {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    }, { timeout: 10000 });
  } catch {
    // Không có "Tiếp" visible — có thể FB variant không có Tiếp step.
    // Theo flow cũ: thử Tab+Enter trước khi declare fail
    await _qpLog(steps, 'Step 3: không thấy nút "Tiếp" sau 10s — thử Tab+Enter fallback');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await randomDelay(200, 400);
    }
    await page.keyboard.press('Enter');
    await randomDelay(2000, 3000);

    // Verify: dialog chuyển sang "Cài đặt bài viết"
    try {
      await page.waitForFunction(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        for (const d of dialogs) {
          const t = d.textContent || '';
          if (t.includes('Cài đặt bài viết') || t.includes('Post settings') || t.includes('Post Settings')) return true;
        }
        return false;
      }, { timeout: 5000 });
      await _qpLog(steps, 'Step 3: Tab+Enter fallback OK — dialog "Cài đặt bài viết" mở');
      return true;
    } catch {
      const debug = await page.evaluate(() => {
        const buttons = document.querySelectorAll('div[role="button"], button');
        const sample = [];
        for (const btn of buttons) {
          const aria = btn.getAttribute('aria-label') || '';
          const text = (btn.textContent || '').trim();
          if (text.length === 0 && !aria) continue;
          if (text.length > 40) continue;
          sample.push({ aria: aria.slice(0, 30), text: text.slice(0, 30) });
          if (sample.length >= 20) break;
        }
        return { numButtons: buttons.length, sample };
      });
      const shot = await _qpScreenshot(page, 'step3-no-button');
      await _qpLog(steps, `Step 3: cả waitFor + Tab+Enter fallback fail — debug=${JSON.stringify(debug)} (screenshot=${shot})`);
      return false;
    }
  }

  // Tìm + click — broad scope, aria-label trước, text exact sau
  const clickResult = await page.evaluate(() => {
    const buttons = document.querySelectorAll('div[role="button"], button[role="button"], button');
    // Phase 1: aria-label exact
    for (const btn of buttons) {
      const aria = btn.getAttribute('aria-label') || '';
      if (aria !== 'Tiếp' && aria !== 'Next') continue;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { ok: true, via: `aria-label="${aria}"` };
    }
    // Phase 2: text content exact (sau khi normalize whitespace)
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text !== 'Tiếp' && text !== 'Next') continue;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { ok: true, via: 'text-exact' };
    }
    return { ok: false };
  });

  if (!clickResult.ok) {
    // Click thường fail → Tab+Enter fallback (theo flow cũ submitPost)
    await _qpLog(steps, 'Step 3: button visible nhưng JS click fail — thử Tab+Enter');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await randomDelay(200, 400);
    }
    await page.keyboard.press('Enter');
  } else {
    await _qpLog(steps, `Step 3: click "Tiếp" OK (${clickResult.via})`);
  }

  // Verify: dialog chuyển sang "Cài đặt bài viết"
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        const t = d.textContent || '';
        if (t.includes('Cài đặt bài viết') || t.includes('Post settings') || t.includes('Post Settings')) return true;
      }
      return false;
    }, { timeout: 10000 });
    await _qpLog(steps, 'Step 3: verify OK — dialog "Cài đặt bài viết" mở');
    return true;
  } catch {
    await _qpLog(steps, `Step 3: clicked nhưng dialog "Cài đặt bài viết" không xuất hiện sau 10s`);
    return false;
  }
}

// --- Step 4: trong "Cài đặt bài viết" click row "Chia sẻ lên nhóm" ---
// Row title là <span> exact text "Chia sẻ lên nhóm". Element clickable ở 1-10 cấp
// parent, chấp nhận role=button | role=listitem | <button> | tabindex="0".
// Fallback: click span trực tiếp (đôi khi FB bubble handler).
async function qpStep4OpenShareToGroups(page, steps) {
  // Wait cho row "Chia sẻ lên nhóm" render (race: dialog vừa mở, các row chưa append)
  // Quét TOÀN DOCUMENT (không scope dialog) — FB có thể render rows qua portal
  try {
    await page.waitForFunction(() => {
      const TARGETS = ['Chia sẻ lên nhóm', 'Share to groups', 'Share to Groups'];
      const candidates = document.querySelectorAll('span, h2, h3, h4');
      for (const el of candidates) {
        const text = (el.textContent || '').trim();
        if (TARGETS.includes(text)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    }, { timeout: 10000 });
  } catch {
    // Diagnostic: dump 30 text samples từ last dialog để xem text thực tế là gì
    const debug = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const last = dialogs[dialogs.length - 1];
      if (!last) return { reason: 'no-dialog' };
      const samples = [];
      const spans = last.querySelectorAll('span, h2, h3, h4');
      for (const el of spans) {
        const t = (el.textContent || '').trim();
        if (t.length === 0 || t.length > 60) continue;
        samples.push(t);
        if (samples.length >= 30) break;
      }
      // Cũng check xem text "Chia sẻ" có xuất hiện trong toàn document không
      const allTexts = document.body.textContent || '';
      const hasShareText = /Chia sẻ|Share to/.test(allTexts);
      return {
        numDialogs: dialogs.length,
        lastDialogTextStart: (last.textContent || '').slice(0, 200),
        samples,
        hasShareTextInBody: hasShareText,
      };
    });
    const shot = await _qpScreenshot(page, 'step4-no-row');
    await _qpLog(steps, `Step 4: KHÔNG tìm thấy row "Chia sẻ lên nhóm" sau 10s — debug=${JSON.stringify(debug)} (screenshot=${shot})`);
    return false;
  }

  // Tìm + click — broad scope, exact match trước, walk-up clickable ancestor
  const result = await page.evaluate(() => {
    const TARGETS = ['Chia sẻ lên nhóm', 'Share to groups', 'Share to Groups'];
    // Broad scope: toàn document (last dialog có thể không chứa row do FB portal)
    const candidates = document.querySelectorAll('span, h2, h3, h4');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!TARGETS.includes(text)) continue;

      // Walk-up tìm element clickable
      let row = el;
      for (let i = 0; i < 10 && row.parentElement; i++) {
        row = row.parentElement;
        const role = row.getAttribute('role');
        const tabindex = row.getAttribute('tabindex');
        if (role === 'button' || role === 'listitem' || row.tagName === 'BUTTON' || tabindex === '0') {
          const r = row.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          row.scrollIntoView({ block: 'center' });
          row.click();
          return { ok: true, via: `walk-up (${role || row.tagName.toLowerCase() || `tabindex=${tabindex}`})` };
        }
      }
      // Fallback: click span trực tiếp
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, via: 'text-direct' };
    }
    return { ok: false, reason: 'text-not-found' };
  });

  if (!result.ok) {
    await _qpLog(steps, `Step 4: KHÔNG tìm thấy row "Chia sẻ lên nhóm" (${result.reason})`);
    return false;
  }

  // Verify: dialog thứ cấp "Chọn nhóm" mở với [role="checkbox"]
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const last = dialogs[dialogs.length - 1];
      if (!last) return false;
      const text = last.textContent || '';
      const hasTitle = text.includes('Chọn nhóm') || text.includes('Choose groups') || text.includes('Choose group');
      // Checkbox: support cả native input + role=checkbox
      const hasCheckbox = last.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
      return hasTitle && hasCheckbox;
    }, { timeout: 10000 });
    await _qpLog(steps, `Step 4: OK — click row (${result.via}), dialog "Chọn nhóm" mở với checkboxes`);
    return true;
  } catch {
    await _qpLog(steps, `Step 4: clicked (${result.via}) nhưng dialog "Chọn nhóm" không xuất hiện sau 10s`);
    return false;
  }
}

// --- Step 5: tick group theo keyword + click "Xong" ---
// Checkbox: native input[type="checkbox"] (FB UI mới) HOẶC [role="checkbox"] (UI cũ).
// Match keyword: exact text priority → substring fallback.
// Lazy-load: scroll dialog 400px/lần, max 30 attempts.
// Xong: aria-label="Xong" primary, walk-up text fallback (pattern step 3).
async function qpStep5PickGroups(page, steps, keywords) {
  const selected = [];
  const missed = [];

  for (const kw of keywords) {
    const result = await _qpPickOneGroup(page, kw);
    if (result.ok) {
      selected.push(kw);
      await _qpLog(steps, `Step 5: "${kw}" — ${result.alreadyChecked ? 'đã tick trước' : 'tick OK'} (match ${result.matchType})`);
    } else {
      missed.push(kw);
      await _qpLog(steps, `Step 5: "${kw}" FAIL — ${result.reason}`);
    }
    await randomDelay(300, 600);
  }

  if (selected.length === 0) {
    await _qpLog(steps, 'Step 5: không tick được group nào → skip "Xong"');
    return { selected: 0, missed };
  }

  // Click "Xong"
  await randomDelay(500, 1000);
  let xongVia = null;
  for (const lbl of ['Xong', 'Done']) {
    try {
      await page.locator('div[role="dialog"]').last().locator(`[aria-label="${lbl}"]`).first().click({ timeout: 3000 });
      xongVia = `aria-label="${lbl}"`;
      break;
    } catch (_) {}
  }
  if (!xongVia) {
    // Fallback: walk-up exact text
    const ok = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      for (const s of dialog.querySelectorAll('span')) {
        const t = (s.textContent || '').trim();
        if (t !== 'Xong' && t !== 'Done') continue;
        let el = s;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement;
          if (el.getAttribute('role') === 'button') { el.click(); return true; }
        }
      }
      return false;
    });
    if (ok) xongVia = 'walk-up text→role=button';
  }

  if (!xongVia) {
    await _qpLog(steps, 'Step 5: KHÔNG click được "Xong" — cả 2 strategy fail');
    return { selected: selected.length, missed };
  }
  await _qpLog(steps, `Step 5: click "Xong" OK (${xongVia})`);

  // Verify: dialog "Chọn nhóm" đóng, quay lại "Cài đặt bài viết"
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const last = dialogs[dialogs.length - 1];
      if (!last) return false;
      const t = last.textContent || '';
      return (t.includes('Cài đặt bài viết') || t.includes('Post settings')) &&
             !t.includes('Chọn nhóm') && !t.includes('Choose groups');
    }, { timeout: 8000 });
    await _qpLog(steps, 'Step 5: verify OK — quay về "Cài đặt bài viết"');
  } catch {
    await _qpLog(steps, 'Step 5: clicked "Xong" nhưng verify "Cài đặt bài viết" timeout — tiếp tục thử step 6');
  }

  return { selected: selected.length, missed };
}

// Tick 1 group theo keyword với exact-match priority + substring fallback + scroll lazy-load.
// FB UI mới: <input type=checkbox> bị ẩn (opacity:0 / pointer-events:none) — click input
// trực tiếp KHÔNG trigger React state. Phải click row/label wrapper (chỗ user thật click).
// Multi-strategy click + verify aria-checked thực sự đổi state.
// Có thêm: nếu dialog có search box → gõ keyword filter trước khi scroll list.
async function _qpPickOneGroup(page, keyword) {
  const kwLower = keyword.toLowerCase();
  const kwExact = keyword.trim();

  // Step 1: nếu có search box trong dialog → gõ keyword để filter list (skip scroll)
  const usedSearch = await (async () => {
    try {
      const searchInfo = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return null;
        // Tìm search input: input[type=search/text] hoặc contenteditable với aria-label "Tìm/Search"
        const inputs = dialog.querySelectorAll('input[type="search"], input[type="text"], [contenteditable="true"]');
        for (const el of inputs) {
          const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('aria-label') || '';
          if (/tìm|search/i.test(ph)) {
            const r = el.getBoundingClientRect();
            if (r.width > 50 && r.height > 10) {
              el.setAttribute('data-qpick-search', '1');
              return { found: true, placeholder: ph.slice(0, 40) };
            }
          }
        }
        return null;
      });

      if (searchInfo && searchInfo.found) {
        const searchEl = await page.$('[data-qpick-search]');
        if (searchEl) {
          await searchEl.click({ force: true });
          await randomDelay(200, 400);
          // Clear existing (Ctrl+A + Delete)
          await page.keyboard.press('Control+a');
          await page.keyboard.press('Delete');
          await randomDelay(100, 200);
          await page.keyboard.type(keyword, { delay: 30 });
          await randomDelay(800, 1200);  // chờ FB filter list
          await page.evaluate(() => {
            document.querySelectorAll('[data-qpick-search]').forEach(el => el.removeAttribute('data-qpick-search'));
          });
          return true;
        }
      }
    } catch (_) {}
    return false;
  })();

  // Step 2: vòng tìm + click. Nếu đã search → list ngắn, ít cần scroll.
  const maxAttempts = usedSearch ? 5 : 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Phase A: tìm checkbox match + đánh dấu element bằng data-attr để click sau
    const findResult = await page.evaluate(({ kwLower, kwExact }) => {
      // Cleanup marker cũ
      document.querySelectorAll('[data-qpick-cb]').forEach(el => el.removeAttribute('data-qpick-cb'));
      document.querySelectorAll('[data-qpick-row]').forEach(el => el.removeAttribute('data-qpick-row'));

      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return { status: 'no-dialog' };

      const checkboxes = dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      if (checkboxes.length === 0) return { status: 'no-checkbox' };

      function findRow(cb) {
        // Ưu tiên: tìm ancestor [role="button"] (FB's clickable row container — đúng nhất)
        const btn = cb.closest('[role="button"], [role="listitem"]');
        if (btn) return btn;
        // Fallback: walk up theo checkbox count
        let row = cb;
        for (let i = 0; i < 8; i++) {
          const next = row.parentElement;
          if (!next) break;
          const cbCount = next.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
          if (cbCount > 1) break;
          row = next;
        }
        return row;
      }

      function isChecked(cb) {
        if (cb.getAttribute('aria-checked') === 'true') return true;
        if (cb.tagName === 'INPUT' && cb.checked === true) return true;
        return false;
      }

      let matched = null;
      let matchType = null;

      // Phase 1: exact
      for (const cb of checkboxes) {
        const row = findRow(cb);
        for (const t of row.querySelectorAll('span, h2, h3, h4')) {
          if ((t.textContent || '').trim() === kwExact) {
            matched = { cb, row };
            matchType = 'exact';
            break;
          }
        }
        if (matched) break;
      }

      // Phase 2: substring fallback
      if (!matched) {
        for (const cb of checkboxes) {
          const row = findRow(cb);
          const text = (row.textContent || '').toLowerCase();
          if (text.includes(kwLower)) {
            matched = { cb, row };
            matchType = 'substring';
            break;
          }
        }
      }

      if (!matched) {
        // Scroll lazy-load
        let scroller = dialog;
        for (const el of dialog.querySelectorAll('*')) {
          if (el.scrollHeight > el.clientHeight + 20) { scroller = el; break; }
        }
        scroller.scrollBy(0, 400);
        return { status: 'scrolled' };
      }

      matched.cb.setAttribute('data-qpick-cb', '1');
      matched.row.setAttribute('data-qpick-row', '1');
      matched.cb.scrollIntoView({ block: 'center' });

      return {
        status: 'matched',
        matchType,
        alreadyChecked: isChecked(matched.cb),
      };
    }, { kwLower, kwExact });

    if (findResult.status === 'scrolled') {
      await randomDelay(300, 500);
      continue;
    }
    if (findResult.status === 'no-dialog' || findResult.status === 'no-checkbox') {
      return { ok: false, reason: findResult.status };
    }

    // status === 'matched'
    if (findResult.alreadyChecked) {
      await page.evaluate(() => {
        document.querySelectorAll('[data-qpick-cb], [data-qpick-row]').forEach(el => {
          el.removeAttribute('data-qpick-cb');
          el.removeAttribute('data-qpick-row');
        });
      });
      return { ok: true, alreadyChecked: true, matchType: findResult.matchType };
    }

    // Wait sau scrollIntoView để dialog ổn định
    await randomDelay(300, 500);

    // Helper: verify aria-checked
    const verifyChecked = async () => {
      return await page.evaluate(() => {
        const cb = document.querySelector('[data-qpick-cb]');
        if (!cb) return null;
        if (cb.getAttribute('aria-checked') === 'true') return true;
        if (cb.tagName === 'INPUT' && cb.checked === true) return true;
        return false;
      });
    };

    // Multi-strategy click — row là role="button" tabindex="0" nên focus+Enter/Space
    // sẽ activate button qua a11y standard, bypass overlay div che click.
    const strategies = [
      { name: 'row-focus-enter', fn: async () => {
        // role="button" tabindex="0" → focus + Enter = activate (a11y standard)
        const el = await page.$('[data-qpick-row]');
        if (el) {
          await el.focus();
          await randomDelay(100, 200);
          await page.keyboard.press('Enter');
        }
      }},
      { name: 'row-focus-space', fn: async () => {
        // role="button" tabindex="0" → focus + Space = activate (a11y standard)
        const el = await page.$('[data-qpick-row]');
        if (el) {
          await el.focus();
          await randomDelay(100, 200);
          await page.keyboard.press('Space');
        }
      }},
      { name: 'row-pw-click-disable-overlay', fn: async () => {
        // Tạm disable pointer-events của overlay [data-visualcompletion="ignore"]
        // trong row để click pass through đến role="button"
        await page.evaluate(() => {
          const row = document.querySelector('[data-qpick-row]');
          if (!row) return;
          row.querySelectorAll('[data-visualcompletion="ignore"]').forEach(el => {
            el.dataset.qpickOriginalPe = el.style.pointerEvents || '';
            el.style.pointerEvents = 'none';
          });
        });
        const el = await page.$('[data-qpick-row]');
        if (el) await el.click({ force: true });
        await page.evaluate(() => {
          document.querySelectorAll('[data-qpick-original-pe]').forEach(el => {
            el.style.pointerEvents = el.dataset.qpickOriginalPe;
            delete el.dataset.qpickOriginalPe;
          });
        });
      }},
      { name: 'row-pw-click', fn: async () => {
        const el = await page.$('[data-qpick-row]');
        if (el) await el.click({ force: true });
      }},
      { name: 'cb-focus-space', fn: async () => {
        // Native checkbox: focus + Space = toggle native input behavior
        const el = await page.$('[data-qpick-cb]');
        if (el) {
          await el.focus();
          await randomDelay(100, 200);
          await page.keyboard.press('Space');
        }
      }},
      { name: 'row-pw-click-offset', fn: async () => {
        const el = await page.$('[data-qpick-row]');
        if (el) await el.click({ force: true, position: { x: 10, y: 10 } });
      }},
      { name: 'row-dispatch-pointer', fn: async () => {
        // Dispatch chuỗi pointer + mouse events thủ công
        await page.evaluate(() => {
          const el = document.querySelector('[data-qpick-row]');
          if (!el) return;
          const r = el.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + 20, clientY: r.top + 20, button: 0 };
          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        });
      }},
      { name: 'row-react-onclick', fn: async () => {
        // Last resort: gọi React onClick handler trực tiếp qua __reactProps fiber
        await page.evaluate(() => {
          const el = document.querySelector('[data-qpick-row]');
          if (!el) return;
          const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
          if (!propsKey) return;
          const props = el[propsKey];
          if (props && typeof props.onClick === 'function') {
            const fakeEvent = {
              bubbles: true, cancelable: true, defaultPrevented: false,
              preventDefault: () => {}, stopPropagation: () => {},
              currentTarget: el, target: el, type: 'click',
            };
            props.onClick(fakeEvent);
          }
        });
      }},
      { name: 'cb-pw-click', fn: async () => {
        const el = await page.$('[data-qpick-cb]');
        if (el) await el.click({ force: true });
      }},
      { name: 'row-js-click', fn: async () => {
        await page.evaluate(() => {
          const el = document.querySelector('[data-qpick-row]');
          if (el) el.click();
        });
      }},
      { name: 'cb-js-click', fn: async () => {
        await page.evaluate(() => {
          const el = document.querySelector('[data-qpick-cb]');
          if (el) el.click();
        });
      }},
    ];

    let toggled = false;
    let usedStrategy = null;
    for (const s of strategies) {
      try {
        await s.fn();
      } catch (_) {
        continue;
      }
      await page.waitForTimeout(400);
      const nowChecked = await verifyChecked();
      if (nowChecked === true) {
        toggled = true;
        usedStrategy = s.name;
        break;
      }
    }

    // Cleanup markers
    await page.evaluate(() => {
      document.querySelectorAll('[data-qpick-cb], [data-qpick-row]').forEach(el => {
        el.removeAttribute('data-qpick-cb');
        el.removeAttribute('data-qpick-row');
      });
    });

    if (toggled) {
      const searchTag = usedSearch ? ' [searched]' : '';
      return { ok: true, alreadyChecked: false, matchType: `${findResult.matchType}${searchTag} via ${usedStrategy}` };
    }
    return { ok: false, reason: `Match ${findResult.matchType} nhưng tất cả ${strategies.length} click strategy không toggle state` };
  }
  return { ok: false, reason: `không thấy sau ${maxAttempts} lần scroll${usedSearch ? ' (đã search)' : ''}` };
}

// --- Step 6: click "Đăng" và chờ dialog đóng ---
// Pattern y hệt "Xong" step 5c: aria-label="Đăng" primary, walk-up text fallback.
// Cần phân biệt với "Đăng ngay" (text trong row "Lịch đăng") → dùng exact match.
// Cũng phân biệt "Lưu" (button bên cạnh) — aria-label đã tách rõ.
// Verify: chờ dialog "Cài đặt bài viết" và "Tạo bài viết" đều biến mất (post xong).
// Bắt postUrl từ GraphQL listener (reuse listenForPostUrl, đã proven).
async function qpStep6Submit(page, steps) {
  // Listener phải attach TRƯỚC khi click — response GraphQL về sau vài trăm ms
  const urlPromise = listenForPostUrl(page, { timeoutMs: 25000, debug: false });

  // Scroll tất cả dialog xuống BOTTOM (theo flow cũ submitPost) — submit button ở cuối
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(800, 1500);

  let clickedVia = null;

  // A. aria-label exact
  for (const lbl of ['Đăng', 'Post']) {
    try {
      await page.locator('div[role="dialog"]').last().locator(`[aria-label="${lbl}"]`).first().click({ timeout: 3000 });
      clickedVia = `aria-label="${lbl}"`;
      break;
    } catch (_) {}
  }

  // B. Walk-up exact text "Đăng"/"Post" → role=button
  if (!clickedVia) {
    const ok = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      for (const s of dialog.querySelectorAll('span')) {
        const t = (s.textContent || '').trim();
        if (t !== 'Đăng' && t !== 'Post') continue;
        let el = s;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement;
          if (el.getAttribute('role') === 'button') {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (ok) clickedVia = 'walk-up text→role=button';
  }

  if (!clickedVia) {
    await _qpLog(steps, 'Step 6: KHÔNG tìm thấy nút "Đăng"');
    return { success: false, error: 'no Đăng button' };
  }
  await _qpLog(steps, `Step 6: click "Đăng" OK (${clickedVia})`);

  // Verify: cả dialog "Cài đặt bài viết" và "Tạo bài viết" phải đóng
  let dialogClosed = false;
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        const t = d.textContent || '';
        if (t.includes('Cài đặt bài viết') || t.includes('Post settings')) return false;
        if (t.includes('Tạo bài viết') || t.includes('Create post') || t.includes('Create Post')) return false;
      }
      return true;
    }, { timeout: 30000 });
    dialogClosed = true;
  } catch {}

  if (!dialogClosed) {
    const shot = await _qpScreenshot(page, 'step6-still-open');
    await _qpLog(steps, `Step 6: dialog không đóng sau 30s (screenshot=${shot}) — có thể FB hiển thị lỗi/captcha`);
    return { success: false, error: `dialog không đóng (screenshot=${shot})` };
  }

  await _qpLog(steps, 'Step 6: dialog đã đóng — post submitted');
  const postUrl = await urlPromise;
  if (postUrl) {
    await _qpLog(steps, `Step 6: postUrl = ${postUrl}`);
  } else {
    await _qpLog(steps, 'Step 6: không bắt được postUrl (GraphQL timeout) — vẫn coi là thành công vì dialog đóng');
  }

  return { success: true, postUrl };
}

/**
 * Đăng nhanh: đăng bài cá nhân + share lên nhóm theo keyword.
 * Tất cả selector sẽ điền dần qua từng step.
 *
 * @param {string} message
 * @param {string[]} imagePaths
 * @param {string[]} groupKeywords  Để rỗng = không share group (sẽ click "Đăng" luôn).
 * @returns {Promise<{success: boolean, postUrl?: string, sharedGroups?: number, missedGroups?: string[], steps: string[], error?: string}>}
 */
async function quickPostToPersonalAndGroups(message, imagePaths = [], groupKeywords = []) {
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[quickPost ${profileSnap.name}]`;
  const steps = [];
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length}, groups=${groupKeywords.length})`);

  const keywords = (groupKeywords || []).map(k => String(k).trim()).filter(Boolean).slice(0, 9);
  const wantShare = keywords.length > 0;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await qpStep1OpenComposer(page, steps))) {
      const shot = await _qpScreenshot(page, 'step1-fail');
      return { success: false, error: `Step 1 fail (screenshot=${shot})`, steps };
    }
    await randomDelay(1500, 2500);

    if (!(await qpStep2FillContent(page, steps, message, imagePaths))) {
      const shot = await _qpScreenshot(page, 'step2-fail');
      return { success: false, error: `Step 2 fail (screenshot=${shot})`, steps };
    }
    await randomDelay(1500, 2500);

    // Nhánh có share group: Tiếp → Chia sẻ lên nhóm → tick → Xong → Đăng
    if (wantShare) {
      if (!(await qpStep3ClickNext(page, steps))) {
        const shot = await _qpScreenshot(page, 'step3-fail');
        return { success: false, error: `Step 3 fail (screenshot=${shot})`, steps };
      }
      await randomDelay(2000, 3500);

      if (!(await qpStep4OpenShareToGroups(page, steps))) {
        const shot = await _qpScreenshot(page, 'step4-fail');
        return { success: false, error: `Step 4 fail (screenshot=${shot})`, steps };
      }
      await randomDelay(1000, 2000);

      const pick = await qpStep5PickGroups(page, steps, keywords);
      if (pick.selected === 0 && keywords.length > 0) {
        const shot = await _qpScreenshot(page, 'step5-fail');
        return { success: false, error: `Step 5 fail — không tick được group nào (screenshot=${shot})`, steps, missedGroups: pick.missed };
      }
      await randomDelay(1500, 2500);

      const submit = await qpStep6Submit(page, steps);
      logger.info(`${tag} done (+${Date.now() - t0}ms)`);
      return {
        success: submit.success,
        postUrl: submit.postUrl,
        sharedGroups: pick.selected,
        missedGroups: pick.missed,
        steps,
        error: submit.success ? undefined : (submit.error || 'Step 6 fail'),
      };
    }

    // Nhánh chỉ đăng cá nhân: vẫn phải qua "Tiếp" → "Cài đặt bài viết" → "Đăng"
    // (FB UI mới không còn nút "Đăng" thẳng ở modal "Tạo bài viết", chỉ có "Tiếp")
    if (!(await qpStep3ClickNext(page, steps))) {
      const shot = await _qpScreenshot(page, 'step3-personal-fail');
      return { success: false, error: `Step 3 (personal) fail (screenshot=${shot})`, steps };
    }
    await randomDelay(2000, 3500);

    const submit = await qpStep6Submit(page, steps);
    logger.info(`${tag} done personal-only (+${Date.now() - t0}ms)`);
    return {
      success: submit.success,
      postUrl: submit.postUrl,
      steps,
      error: submit.success ? undefined : (submit.error || 'Step 6 fail'),
    };
  } catch (e) {
    logger.error(`${tag} exception: ${e.message}`);
    const shot = await _qpScreenshot(page, 'exception');
    return { success: false, error: `${e.message} (screenshot=${shot})`, steps };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { setProfile, profileExists, getActiveProfile, postToPersonal, postToGroup, postPersonalAndShareToGroups, quickPostToPersonalAndGroups, closeBrowser };
