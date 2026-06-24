const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay, humanType } = require('../utils/delay');
const funMsg = require('../utils/fun-messages');
const { getFbProxyForProfile } = require('../utils/proxy');
const { getProfileDeviceFingerprint } = require('../utils/device-fingerprint');
const { checkProxy } = require('../utils/proxy-health');

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
      const probe = await Promise.race([
        browsers[key].newPage(),
        new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 8000)),
      ]);
      await Promise.race([probe.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
      return browsers[key];
    } catch {
      await Promise.race([
        browsers[key].close(),
        new Promise(r => setTimeout(r, 10000)),
      ]).catch(() => {});
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

        // Pre-flight proxy health check (TCP probe, ~3s, cached 5 phút).
        // Fail-fast trước khi launch browser tốn 20+s rồi crash với "ERR_PROXY_CONNECTION_FAILED".
        if (proxy) {
          const health = await checkProxy(proxy);
          if (!health.ok) {
            throw new Error(`Proxy "${proxy.server}" không kết nối được: ${health.error}. Kiểm tra proxy còn sống không / IP whitelist / credentials.`);
          }
        }

        const { userAgent, viewport } = getProfileDeviceFingerprint(key);
        const ctx = await safeLaunchPersistentContext(userDataDir, {
          headless: false,
          slowMo: config.playwright.slowMo,
          viewport,
          userAgent,
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

// Lưu screenshot debug với tên DUY NHẤT (kèm timestamp) để KHÔNG ghi đè ảnh
// của lần lỗi trước — giữ bằng chứng cho từng lần fail. Trả về basename để nhúng
// vào thông báo lỗi (dashboard có nút "Xem ảnh lỗi" đọc tên này từ error).
async function saveDebugShot(page, prefix) {
  const name = `${prefix}-${Date.now()}.png`;
  try {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/${name}`) });
  } catch (e) {
    logger.warn(`saveDebugShot(${prefix}) lỗi: ${e.message}`);
  }
  return name;
}

async function openCreatePost(page, isGroup = false) {
  // Đợi feed render xong: domcontentloaded đã done ở page.goto, chờ thêm 1s để
  // React render nút tạo bài. networkidle không dùng — FB liên tục có background
  // requests nên thường block đến hết 30s timeout.
  await randomDelay(800, 1200);

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

  // 3. Gõ phím với delay random per-char (giống người, tránh signal bot)
  await humanType(page.keyboard, message);
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

  // Cách 1: Click nút Ảnh/Video để FB render input[type=file], sau đó dùng setInputFiles.
  // Filechooser event không đáng tin (timeout 20s) — click để mở UI ảnh rồi tìm input trực tiếp.
  await (async () => {
    await randomDelay(300, 700);
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
    const icons = await page.$$('div[role="dialog"] div[role="button"]');
    for (const icon of icons) {
      const label = await icon.getAttribute('aria-label');
      if (label && (label.includes('nh') || label.includes('hoto') || label.includes('ideo'))) {
        await icon.click({ force: true });
        logger.info(`Click icon ảnh: ${label}`);
        return;
      }
    }
  })();
  await randomDelay(800, 1500); // chờ FB render input sau khi click

  // Cách 2: Tìm input[type=file] trực tiếp.
  // FB render nhiều input file ẩn với accept khác nhau (input ảnh, input video, input combo).
  // Phải phân biệt rõ: nếu nhét ảnh vào input "video đứng đầu" → FB coi file là video/tài liệu,
  // ảnh KHÔNG hiện trong bài (render thành icon tài liệu). Vì thế chấm điểm phải ưu tiên
  // input nhận ảnh + cho chọn nhiều ảnh + có "image" đứng đầu accept; phạt input video-first.
  const candidates = await page.$$('input[type="file"]');
  const scored = [];
  for (const input of candidates) {
    const accept = ((await input.getAttribute('accept')) || '').toLowerCase();
    const multiple = (await input.getAttribute('multiple')) !== null;
    const acceptList = accept.trim();
    let score = 0;
    if (accept.includes('image')) score += 3;        // bắt buộc: input phải nhận ảnh
    if (multiple) score += 2;                         // input soạn ảnh thật của FB cho chọn nhiều ảnh
    if (acceptList.startsWith('image')) score += 2;   // ưu tiên input "ảnh đứng đầu"
    if (acceptList.startsWith('video')) score -= 3;   // input "video đứng đầu" → FB hay coi file là video/tài liệu
    if (!acceptList) score -= 1;                      // input không khai báo accept → chung chung, tránh
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

  // Cách 3: Fallback filechooser (nếu direct input thất bại)
  if (!uploaded) {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        (async () => {
          for (const sel of photoSelectors) {
            try {
              const el = await page.$(sel);
              if (el) { await el.click({ force: true }); return; }
            } catch { continue; }
          }
        })(),
      ]);
      await fileChooser.setFiles(imagePaths);
      uploaded = true;
      uploadMethod = 'filechooser-fallback';
      logger.info(`Upload ${imagePaths.length} ảnh thành công (filechooser-fallback)`);
    } catch (e) {
      logger.error(`Filechooser fallback failed: ${e.message}`);
    }
  }

  if (!uploaded) {
    logger.error('KHÔNG UPLOAD ĐƯỢC ẢNH!');
    // Trả tên ảnh (string truthy) thay vì false → caller phân biệt fail bằng
    // `!== true` và nhúng tên ảnh duy nhất vào thông báo lỗi.
    return await saveDebugShot(page, 'debug-upload');
  }

  // Verify: chờ FB render preview. Smart wait: resolve ngay khi thumbnail xuất hiện,
  // tối đa 4s — nhanh hơn flat delay 3-6s khi FB render sớm.
  await page.waitForFunction((n) => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return true; // dialog đóng rồi thì khỏi chờ
    let count = 0;
    for (const img of dialog.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('blob:') || src.startsWith('data:')) count++;
    }
    return count >= n;
  }, Math.max(1, imagePaths.length), { timeout: 4000 }).catch(() => {});
  // Verify cho MỌI trường hợp (kể cả 1 ảnh): nếu không thấy thumbnail ảnh nào nghĩa là
  // FB có thể đã coi file là video/tài liệu (chọn nhầm input) → ảnh sẽ không hiện trong bài.
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
    if (thumbCount === 0) {
      logger.warn(`Không thấy thumbnail ảnh nào sau upload (method=${uploadMethod}) — FB có thể đã coi file là video/tài liệu, ảnh sẽ KHÔNG hiện. Kiểm tra input đã chọn.`);
      await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-upload-noimg-${Date.now()}.png`) }).catch(() => {});
    } else if (thumbCount > 0 && thumbCount < imagePaths.length) {
      logger.warn(`Chỉ thấy ${thumbCount}/${imagePaths.length} thumbnail (method=${uploadMethod}) — FB có thể đã nuốt mất ảnh`);
      await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-upload-mismatch-${Date.now()}.png`) }).catch(() => {});
    } else if (thumbCount >= imagePaths.length) {
      logger.info(`Verify OK: ${thumbCount} thumbnail trong dialog`);
    }
  } catch (e) {
    logger.warn(`Không count được thumbnail: ${e.message}`);
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
    return { selected: [], missed: targets };
  }
  await randomDelay(800, 1500);

  if (!(await clickShareToGroupsRow(page))) {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-share-click-${Date.now()}.png`) }).catch(() => {});
    return { selected: [], missed: targets };
  }

  if (!(await waitForShareDialog(page))) {
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/debug-share-dialog-${Date.now()}.png`) }).catch(() => {});
    logger.warn('shareToGroups: dialog "Chọn nhóm" không mở sau khi click — bỏ qua');
    return { selected: [], missed: targets };
  }
  await randomDelay(500, 1000);

  const selected = [];
  const missed = [];
  for (const kw of targets) {
    const groupName = await selectGroupCheckbox(page, kw);
    if (groupName !== null) selected.push(groupName); else missed.push(kw);
  }

  await randomDelay(500, 1000);
  if (!(await clickXongInShareDialog(page))) {
    logger.warn('shareToGroups: không click được "Xong" — fallback Enter');
    await page.keyboard.press('Enter');
  } else {
    logger.info('shareToGroups: click "Xong" OK');
  }
  await randomDelay(1500, 2500);

  return { selected, missed };
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
  await randomDelay(1000, 2000);

  // Bước 2: trong "Cài đặt bài viết", click "Chia sẻ lên nhóm" → tick group → Xong
  const shareResult = await shareToGroupsInSettings(page, keywords);
  logger.info(`submitPostAndShareGroups: shared ${shareResult.selected.length}/${keywords.length}${shareResult.missed.length ? ` (miss: ${shareResult.missed.join(', ')})` : ''}`);

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

  // Smart wait: resolve ngay khi dialog đóng, tối đa 8s
  await page.waitForFunction(() => {
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    for (const d of dialogs) {
      const t = d.textContent || '';
      if (t.includes('Tạo bài viết') || t.includes('Create post') ||
          t.includes('Cài đặt bài viết') || t.includes('Post settings')) return false;
    }
    return true;
  }, { timeout: 8000 }).catch(() => {});

  const stillOpen = await page.$('div[role="dialog"] span:has-text("Tạo bài viết"), div[role="dialog"] span:has-text("Cài đặt bài viết")');
  if (stillOpen) {
    const shot = await saveDebugShot(page, 'debug-share-submit-failed');
    return { success: false, screenshot: shot, sharedGroups: shareResult.selected, missedGroups: shareResult.missed };
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
            const groupName = row.textContent.trim().replace(/\s+/g, ' ').substring(0, 80);
            return { status: 'ok', alreadyChecked: already, groupName };
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
      logger.info(`shareToGroups: nhóm "${keyword}" (${result.groupName}) ${result.alreadyChecked ? '(đã chọn trước)' : 'check OK'}`);
      return result.groupName || keyword;
    }
    if (result.status === 'no-dialog') {
      logger.warn(`shareToGroups: nhóm "${keyword}" — không thấy dialog`);
      return null;
    }
    await randomDelay(300, 500);
  }
  logger.warn(`shareToGroups: nhóm "${keyword}" — không tìm thấy sau ${30} lần scroll`);
  return null;
}

async function submitPost(page) {
  // Phải attach listener TRƯỚC khi click — response GraphQL về sau vài trăm ms
  const urlPromise = listenForPostUrl(page, { timeoutMs: 25000, debug: false });

  // Bấm nút "Đăng"/"Tiếp" CHẮC TAY bằng nhiều chiến lược (giống qpStep6Submit).
  // Nút "Đăng" của FB lúc là div[aria-label="Đăng"], lúc chỉ là <span>Đăng</span>
  // bọc trong role=button KHÔNG kèm aria-label — nên chỉ dò aria-label sẽ trượt
  // (đúng lỗi đã thấy: hộp thoại còn mở, nút Đăng sẵn sàng mà bot không bấm được).
  // Ưu tiên "Đăng" (submit cuối) trước "Tiếp" (chuyển màn của bài cá nhân).
  const clickPostButton = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
    });
    const dialog = page.locator('div[role="dialog"]').last();
    // A. aria-label exact, bỏ qua nút disabled (Playwright click → event đáng tin)
    for (const lbl of ['Đăng', 'Post', 'Tiếp', 'Next']) {
      try {
        const el = dialog.locator(`[aria-label="${lbl}"]:not([aria-disabled="true"])`).first();
        if (await el.count()) { await el.click({ force: true, timeout: 2500 }); return `aria=${lbl}`; }
      } catch {}
    }
    // B. getByRole(button, name exact) — bắt được nút accessible-name không có aria-label
    for (const lbl of ['Đăng', 'Post', 'Tiếp', 'Next']) {
      try {
        const el = dialog.getByRole('button', { name: lbl, exact: true }).first();
        if (await el.count()) { await el.click({ force: true, timeout: 2500 }); return `role=${lbl}`; }
      } catch {}
    }
    // C. span/div text → leo lên role=button (DOM click), bỏ nút disabled/ẩn
    const viaDom = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      const dlg = dialogs[dialogs.length - 1];
      if (!dlg) return null;
      for (const want of ['Đăng', 'Post', 'Tiếp', 'Next']) {
        for (const s of dlg.querySelectorAll('span, div')) {
          if ((s.textContent || '').trim() !== want) continue;
          let el = s;
          for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
            if (el.getAttribute && el.getAttribute('role') === 'button' && el.getAttribute('aria-disabled') !== 'true') {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { el.scrollIntoView({ block: 'center' }); el.click(); return want; }
            }
          }
        }
      }
      return null;
    });
    return viaDom ? `dom=${viaDom}` : null;
  };

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(800, 1200);

  // Vòng lặp: bấm "Đăng" rồi chờ MỘT trong hai dấu hiệu thành công —
  //  (1) hộp thoại tạo bài đóng, HOẶC (2) bắt được postUrl từ GraphQL.
  // Bài cá nhân có thể qua 2 màn (Tạo bài viết → Cài đặt bài viết) nên cần bấm
  // vài lần; nút "Đăng" cuối có thể render trễ.
  let success = false;
  let lastClick = null;
  for (let i = 0; i < 6; i++) {
    const clicked = await clickPostButton();
    if (clicked) lastClick = clicked;
    logger.info(`submitPost: lần ${i + 1} bấm "Đăng"${clicked ? ` (${clicked})` : ' — KHÔNG thấy nút'}`);

    // Chờ tới khi hộp thoại tạo bài / cài đặt bài viết ĐÓNG hẳn (predicate chạy
    // trong browser, trả true khi không còn dialog nào mang tiêu đề composer).
    const closed = await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        const t = d.textContent || '';
        if (t.includes('Tạo bài viết') || t.includes('Create post') || t.includes('Create Post') ||
            t.includes('Cài đặt bài viết') || t.includes('Post settings') || t.includes('Post Settings')) return false;
      }
      return true;
    }, { timeout: 6000 }).then(() => true).catch(() => false);
    if (closed) { success = true; break; }
    await randomDelay(600, 1000);
  }

  // postUrl bắt được = bài ĐÃ được tạo, kể cả khi phát hiện đóng hộp thoại chập chờn.
  const postUrl = await urlPromise;
  if (postUrl) success = true;

  if (!success) {
    const shot = `debug-failed-${Date.now()}.png`;
    await page.screenshot({ path: path.resolve(__dirname, `../../logs/${shot}`) }).catch(() => {});
    logger.warn(`submitPost: thất bại — hộp thoại không đóng & không bắt được postUrl (lastClick=${lastClick || 'none'}, screenshot=${shot})`);
    return { success: false, screenshot: shot };
  }

  if (!postUrl) logger.warn('submitPost: thành công (hộp thoại đóng) nhưng không bắt được postUrl từ GraphQL');
  return { success: true, postUrl };
}

/**
 * Chụp screenshot bài viết của profile đang active
 */

async function postToPersonal(message, imagePaths = []) {
  const _profileKey = activeProfile;
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[postToPersonal ${profileSnap.name}]`;
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length})`);

  const browser = await getBrowser();
  logger.info(`${tag} got browser (+${Date.now() - t0}ms)`);

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    logger.info(`${tag} loaded fb home (+${Date.now() - t0}ms, url=${page.url()})`);
    await randomDelay(1500, 2500);
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
    await randomDelay(800, 1500);

    if (imagePaths.length > 0) {
      const tImg = Date.now();
      const imgOk = await attachImages(page, imagePaths);
      if (imgOk !== true) throw new Error(funMsg.errUpload() + ` (xem logs/${imgOk || 'debug-upload.png'})`);
      logger.info(`${tag} attach ${imagePaths.length} ảnh xong (${Date.now() - tImg}ms)`);
    }
    await randomDelay(800, 1200);

    if (message) {
      const tType = Date.now();
      if (!(await typeMessage(page, message))) throw new Error(funMsg.errTypeContent());
      logger.info(`${tag} nhập text xong (${Date.now() - tType}ms)`);
    }
    await randomDelay(600, 1200);

    const tSubmit = Date.now();
    const result = await submitPost(page);
    if (!result.success) {
      // FB reject phổ biến nhất với clone account: đăng ảnh không kèm caption.
      // Đổi error chung "Thôi xong!" thành hướng dẫn cụ thể để user biết phải làm gì.
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption (vài dòng nội dung) rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/${result.screenshot || 'debug-failed.png'})`);
    }
    logger.info(`${tag} submit xong (${Date.now() - tSubmit}ms) — total ${Date.now() - t0}ms ✅${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal', postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await randomDelay(2000, 3000); // stay-alive: đợi FB xử lý xong trước khi đóng tab
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null; // xóa cache ngay để lần sau launch browser mới
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

// Đăng bài cá nhân + đồng thời chia sẻ lên nhiều nhóm trong cùng 1 lần đăng,
// dùng tính năng "Chia sẻ lên nhóm" trong dialog "Cài đặt bài viết" của FB.
// groupKeywords: mảng tên nhóm (substring, case-insensitive). FB giới hạn 9.
async function postPersonalAndShareToGroups(message, imagePaths = [], groupKeywords = []) {
  const _profileKey = activeProfile;
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[postPersonalAndShareToGroups ${profileSnap.name}]`;
  const kwList = (groupKeywords || []).filter(Boolean);
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length}, nhóm=${kwList.length})`);

  if (kwList.length === 0) {
    return await postToPersonal(message, imagePaths);
  }

  const browser = await getBrowser();

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(1500, 2500);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, false))) {
      const debugPath = path.resolve(__dirname, `../../logs/debug-open-${profileSnap.name}-${Date.now()}.png`);
      await page.screenshot({ path: debugPath }).catch(() => {});
      throw new Error(`${funMsg.errPopupPersonal()} [screenshot=${path.basename(debugPath)}]`);
    }
    await randomDelay(800, 1500);

    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (imgOk !== true) throw new Error(funMsg.errUpload() + ` (xem logs/${imgOk || 'debug-upload.png'})`);
    }
    await randomDelay(800, 1200);

    if (message) {
      if (!(await typeMessage(page, message))) throw new Error(funMsg.errTypeContent());
    }
    await randomDelay(600, 1200);

    const result = await submitPostAndShareGroups(page, kwList);
    if (!result.success) {
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/${result.screenshot || 'debug-share-submit-failed.png'})`);
    }
    logger.info(`${tag} xong (${Date.now() - t0}ms) ✅ shared=${Array.isArray(result.sharedGroups) ? result.sharedGroups.length : 0}/${kwList.length}${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal+groups', postUrl: result.postUrl || null, groups: kwList, sharedGroups: result.sharedGroups, missedGroups: result.missedGroups };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await randomDelay(2000, 3000); // stay-alive: đợi FB xử lý xong trước khi đóng tab
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

async function postToGroup(groupId, message, imagePaths = []) {
  const _profileKey = activeProfile;
  const browser = await getBrowser();

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    const profile = getActiveProfile();
    logger.info(`Đăng bài lên group ${groupId} (${profile.name})...`);
    await page.goto(`https://www.facebook.com/groups/${groupId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, true))) {
      const shot = await saveDebugShot(page, 'debug-group-open');
      throw new Error(`${funMsg.errPopupGroup()} (xem logs/${shot})`);
    }
    await randomDelay(2000, 3000);

    // Đính kèm ảnh TRƯỚC
    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (imgOk !== true) throw new Error(funMsg.errUpload() + ` (xem logs/${imgOk || 'debug-upload.png'})`);
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
      throw new Error(`${hint} (xem logs/${result.screenshot || 'debug-failed.png'})`);
    }

    logger.info(`Đã đăng bài group ${groupId} thành công!${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: `group:${groupId}`, postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`Lỗi: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

async function postToPage(pageId, message, imagePaths = []) {
  const _profileKey = activeProfile;
  const browser = await getBrowser();

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    const profile = getActiveProfile();
    logger.info(`Đăng bài lên page ${pageId} (${profile.name})...`);
    await page.goto(`https://www.facebook.com/${pageId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, false))) {
      const shot = await saveDebugShot(page, 'debug-page-open');
      throw new Error(`Không mở được popup tạo bài cho page ${pageId}. Chắc chắn đã switch sang page trong session chưa? (xem logs/${shot})`);
    }
    await randomDelay(2000, 3000);

    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (imgOk !== true) throw new Error(funMsg.errUpload() + ` (xem logs/${imgOk || 'debug-upload.png'})`);
    }
    await randomDelay(1500, 2500);

    if (message) {
      if (!(await typeMessage(page, message))) throw new Error(funMsg.errTypeContent());
    }
    await randomDelay(1000, 2000);

    const result = await submitPost(page);
    if (!result.success) {
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption (vài dòng nội dung) rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/${result.screenshot || 'debug-failed.png'})`);
    }

    logger.info(`Đã đăng bài page ${pageId} thành công!${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: `page:${pageId}`, postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`Lỗi postToPage(${pageId}): ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
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
// Thứ tự y hệt postToPersonal flow cũ (đã proven), nhưng timing rút gọn để tăng tốc.
async function qpStep2FillContent(page, steps, message, imagePaths) {
  await randomDelay(800, 1500);

  // 2a. Upload ảnh (TRƯỚC như flow cũ)
  if (imagePaths && imagePaths.length > 0) {
    const ok = await attachImages(page, imagePaths);
    if (ok !== true) {
      const shot = await _qpScreenshot(page, 'step2a-fail');
      await _qpLog(steps, `Step 2a: attachImages (cũ) fail (screenshot=${shot})`);
      return false;
    }
    await _qpLog(steps, `Step 2a: attachImages (cũ) OK, ${imagePaths.length} ảnh`);
  } else {
    await _qpLog(steps, 'Step 2a: skip — không có ảnh');
  }

  await randomDelay(600, 1200);

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

  await randomDelay(400, 800);
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
  await randomDelay(300, 600);

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

  // Verify: dialog thứ cấp "Chọn nhóm" mở với checkbox.
  // Lỏng scope — quét MỌI dialog (không chỉ last), HOẶC fallback check toàn body.
  // FB modal portal có thể stack DOM theo thứ tự khác → dialog mới chưa chắc là last.
  try {
    await page.waitForFunction(() => {
      // Check 1: bất kỳ dialog nào chứa "Chọn nhóm" + có checkbox
      const dialogs = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      for (const d of dialogs) {
        const text = d.textContent || '';
        if (text.includes('Chọn nhóm') || text.includes('Choose groups') || text.includes('Choose group')) {
          const hasCb = d.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
          if (hasCb) return true;
        }
      }
      // Check 2: fallback toàn body — "Chọn nhóm" chỉ xuất hiện ở dialog mới
      // (dialog "Cài đặt bài viết" chứa "Chia sẻ lên nhóm" — KHÔNG chứa "Chọn nhóm")
      const bodyText = document.body.textContent || '';
      const hasChoose = bodyText.includes('Chọn nhóm') || bodyText.includes('Choose groups') || bodyText.includes('Choose group');
      const hasAnyCb = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
      return hasChoose && hasAnyCb;
    }, { timeout: 15000 });
    await _qpLog(steps, `Step 4: OK — click row (${result.via}), dialog "Chọn nhóm" mở với checkboxes`);
    return true;
  } catch {
    // Diagnostic dump để debug
    const debug = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      const bodyText = document.body.textContent || '';
      return {
        numDialogs: dialogs.length,
        dialogTexts: Array.from(dialogs).map(d => (d.textContent || '').slice(0, 120)),
        bodyHasChonNhom: bodyText.includes('Chọn nhóm'),
        bodyHasChiaSe: bodyText.includes('Chia sẻ lên nhóm'),
        numCheckboxes: document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length,
      };
    });
    const shot = await _qpScreenshot(page, 'step4-verify-fail');
    await _qpLog(steps, `Step 4: clicked (${result.via}) nhưng verify fail sau 15s — debug=${JSON.stringify(debug)} (screenshot=${shot})`);
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
    await randomDelay(150, 300);
  }

  if (selected.length === 0) {
    await _qpLog(steps, 'Step 5: không tick được group nào → skip "Xong"');
    return { selected: [], missed };
  }

  // Click "Xong" — scope vào dialog chứa "Chọn nhóm" (không phải last dialog)
  await randomDelay(300, 600);
  let xongVia = null;
  const shareDialog = page.locator('div[role="dialog"]').filter({ hasText: 'Chọn nhóm' }).first();

  // A. aria-label exact trong share dialog
  for (const lbl of ['Xong', 'Done']) {
    try {
      await shareDialog.locator(`[aria-label="${lbl}"]`).first().click({ force: true, timeout: 3000 });
      xongVia = `aria-label="${lbl}"`;
      break;
    } catch (_) {}
  }

  // B. getByRole(button, name=Xong) trong share dialog
  if (!xongVia) {
    for (const lbl of ['Xong', 'Done']) {
      try {
        await shareDialog.getByRole('button', { name: lbl, exact: true }).first().click({ force: true, timeout: 3000 });
        xongVia = `getByRole(button,${lbl})`;
        break;
      } catch (_) {}
    }
  }

  // C. Fallback: walk-up exact text trong share dialog
  if (!xongVia) {
    const ok = await page.evaluate(() => {
      const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      let dialog = null;
      for (const cand of ds) {
        const t = cand.textContent || '';
        if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) {
          dialog = cand; break;
        }
      }
      if (!dialog) return false;
      for (const s of dialog.querySelectorAll('span')) {
        const t = (s.textContent || '').trim();
        if (t !== 'Xong' && t !== 'Done') continue;
        let el = s;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement;
          if (el.getAttribute('role') === 'button') {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (ok) xongVia = 'walk-up text→role=button';
  }

  if (!xongVia) {
    const shot = await _qpScreenshot(page, 'step5-xong-fail');
    await _qpLog(steps, `Step 5: KHÔNG click được "Xong" (screenshot=${shot})`);
    return { selected, missed };
  }
  await _qpLog(steps, `Step 5: click "Xong" OK (${xongVia})`);

  // Verify: dialog "Chọn nhóm" đóng (không còn dialog nào chứa "Chọn nhóm")
  try {
    await page.waitForFunction(() => {
      const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      for (const d of ds) {
        const t = d.textContent || '';
        if (t.includes('Chọn nhóm') || t.includes('Choose groups')) return false;  // vẫn còn dialog "Chọn nhóm"
      }
      return true;  // dialog "Chọn nhóm" đã đóng
    }, { timeout: 8000 });
    await _qpLog(steps, 'Step 5: verify OK — dialog "Chọn nhóm" đã đóng');
  } catch {
    await _qpLog(steps, 'Step 5: clicked "Xong" nhưng dialog "Chọn nhóm" vẫn mở — tiếp tục thử step 6');
  }

  return { selected, missed };
}

// Tick 1 group theo keyword với exact-match priority + substring fallback + scroll lazy-load.
// FB UI mới: <input type=checkbox> bị ẩn (opacity:0 / pointer-events:none) — click input

// Tick 1 group bằng Playwright accessibility locator (B3 approach).
// Dùng getByRole + .check() / .click() built-in — Playwright tự handle scroll into view,
// actionability check, retries. Fall back qua nhiều variant của getByRole.
// QUAN TRỌNG: scope vào dialog "Chọn nhóm" (chứa text này) thay vì last dialog —
// FB modal portal có thể stack DOM khác thứ tự visual.
async function _qpPickOneGroup(page, keyword) {
  const kw = keyword.trim();
  const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Helper JS in browser: tìm dialog "Chọn nhóm" trong tất cả role=dialog
  const FIND_SHARE_DIALOG = `(function(){
    const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    for (const d of ds) {
      const t = d.textContent || '';
      if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) return d;
    }
    return null;
  })()`;

  // Scroll lazy-load: đảm bảo group nằm trong DOM trước khi dùng locator
  let foundInDom = false;
  for (let i = 0; i < 20; i++) {
    const result = await page.evaluate((k) => {
      // Inline tìm share dialog (chứa "Chọn nhóm")
      const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      let d = null;
      for (const cand of ds) {
        const t = cand.textContent || '';
        if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) {
          d = cand; break;
        }
      }
      if (!d) return 'no-share-dialog';

      for (const s of d.querySelectorAll('span, h2, h3, h4')) {
        if ((s.textContent || '').trim() === k) {
          s.scrollIntoView({ block: 'center' });
          return 'found';
        }
      }
      // Scroll scrollable descendant trong share dialog
      let scroller = d;
      for (const el of d.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 20) { scroller = el; break; }
      }
      scroller.scrollBy(0, 400);
      return 'scrolled';
    }, kw);

    if (result === 'no-share-dialog') return { ok: false, reason: 'no-share-dialog' };
    if (result === 'found') { foundInDom = true; break; }
    await randomDelay(150, 300);
  }

  if (!foundInDom) return { ok: false, reason: `Không thấy group "${kw}" sau 20 scrolls` };
  await randomDelay(200, 400);  // settle sau scrollIntoView

  // Check alreadyChecked trước khi thử click — scope share dialog
  const isAlreadyChecked = await page.evaluate((k) => {
    const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    let d = null;
    for (const cand of ds) {
      const t = cand.textContent || '';
      if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) {
        d = cand; break;
      }
    }
    if (!d) return false;
    for (const cb of d.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      const row = cb.closest('[role="button"], [role="listitem"]') || cb.parentElement;
      if (!row) continue;
      let titleMatch = false;
      for (const t of row.querySelectorAll('span, h2, h3, h4')) {
        if ((t.textContent || '').trim() === k) { titleMatch = true; break; }
      }
      if (!titleMatch) continue;
      if (cb.getAttribute('aria-checked') === 'true') return true;
      if (cb.tagName === 'INPUT' && cb.checked === true) return true;
    }
    return false;
  }, kw);

  if (isAlreadyChecked) {
    return { ok: true, alreadyChecked: true, matchType: 'exact (đã tick trước)' };
  }

  // B3: Playwright accessibility locator strategies — scope vào dialog chứa "Chọn nhóm"
  const dialog = page.locator('div[role="dialog"]').filter({ hasText: 'Chọn nhóm' }).first();
  const startRe = new RegExp('^' + escapedKw + '(\\s|$|,)', 'i');
  const exactRe = new RegExp('^' + escapedKw + '$', 'i');

  const tries = [
    { name: 'getByRole(checkbox,exactRe).check', fn: () =>
      dialog.getByRole('checkbox', { name: exactRe }).first().check({ force: true, timeout: 3000 }) },
    { name: 'getByRole(checkbox,name,exact).check', fn: () =>
      dialog.getByRole('checkbox', { name: kw, exact: true }).first().check({ force: true, timeout: 3000 }) },
    { name: 'getByRole(checkbox,substring).check', fn: () =>
      dialog.getByRole('checkbox', { name: kw }).first().check({ force: true, timeout: 3000 }) },
    { name: 'getByRole(button,startRe).click', fn: () =>
      dialog.getByRole('button', { name: startRe }).first().click({ force: true, timeout: 3000 }) },
    { name: 'getByRole(button,name).click', fn: () =>
      dialog.getByRole('button', { name: kw }).first().click({ force: true, timeout: 3000 }) },
    { name: 'getByText(exact).click', fn: () =>
      dialog.getByText(kw, { exact: true }).first().click({ force: true, timeout: 3000 }) },
    { name: 'mouse.click on checkbox icon', fn: async () => {
      // Click thẳng tọa độ pixel của visible icon (<i data-visualcompletion="css-img">)
      // Bypass overlay + accessibility — đây là chỗ user thật sự click khi tick group
      const coords = await page.evaluate((k) => {
        const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        let d = null;
        for (const cand of ds) {
          const t = cand.textContent || '';
          if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) {
            d = cand; break;
          }
        }
        if (!d) return null;
        for (const cb of d.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
          const row = cb.closest('[role="button"], [role="listitem"]') || cb.parentElement;
          if (!row) continue;
          let titleMatch = false;
          for (const t of row.querySelectorAll('span, h2, h3, h4')) {
            if ((t.textContent || '').trim() === k) { titleMatch = true; break; }
          }
          if (!titleMatch) continue;
          // Ưu tiên: visible icon <i> (background-image CSS sprite); fallback: input rect
          const icon = row.querySelector('i[data-visualcompletion="css-img"]')
                    || row.querySelector('i[style*="background-image"]')
                    || cb;
          const r = icon.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      }, kw);
      if (!coords) throw new Error('không tìm được tọa độ icon');
      // Hover trước, rồi mousedown + mouseup riêng (giống user thật click)
      await page.mouse.move(coords.x, coords.y);
      await randomDelay(100, 200);
      await page.mouse.down();
      await randomDelay(50, 100);
      await page.mouse.up();
    }},
    { name: 'mouse.click on row center', fn: async () => {
      // Hover + click coordinates ở center của row (full chain mouse events)
      const coords = await page.evaluate((k) => {
        const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        let d = null;
        for (const cand of ds) {
          const t = cand.textContent || '';
          if (t.includes('Chọn nhóm') || t.includes('Choose groups') || t.includes('Choose group')) {
            d = cand; break;
          }
        }
        if (!d) return null;
        for (const cb of d.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
          const row = cb.closest('[role="button"], [role="listitem"]') || cb.parentElement;
          if (!row) continue;
          let titleMatch = false;
          for (const t of row.querySelectorAll('span, h2, h3, h4')) {
            if ((t.textContent || '').trim() === k) { titleMatch = true; break; }
          }
          if (!titleMatch) continue;
          const r = row.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      }, kw);
      if (!coords) throw new Error('không tìm được tọa độ row');
      await page.mouse.move(coords.x, coords.y);
      await randomDelay(150, 300);
      await page.mouse.down();
      await randomDelay(50, 100);
      await page.mouse.up();
    }},
  ];

  // Verify: chờ aria-checked đổi (re-find theo keyword, không phụ thuộc marker)
  // Timeout ngắn (1500ms) — FB thường update state trong < 500ms sau click.
  // Nếu sau 1.5s chưa toggle → coi là strategy fail, thử cái tiếp theo.
  const waitForToggle = async () => {
    try {
      await page.waitForFunction((k) => {
        for (const cb of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
          const row = cb.closest('[role="button"], [role="listitem"]') || cb.parentElement;
          if (!row) continue;
          let match = false;
          for (const t of row.querySelectorAll('span, h2, h3, h4')) {
            if ((t.textContent || '').trim() === k) { match = true; break; }
          }
          if (!match) continue;
          if (cb.getAttribute('aria-checked') === 'true') return true;
          if (cb.tagName === 'INPUT' && cb.checked === true) return true;
        }
        return false;
      }, kw, { timeout: 1500 });
      return true;
    } catch { return false; }
  };

  const triedLog = [];
  for (const t of tries) {
    try {
      await t.fn();
    } catch (e) {
      triedLog.push(`${t.name}=err`);
      continue;
    }
    const ok = await waitForToggle();
    triedLog.push(`${t.name}=${ok ? 'OK' : 'no-toggle'}`);
    if (ok) {
      return { ok: true, alreadyChecked: false, matchType: `pw-a11y via ${t.name}` };
    }
  }

  return { ok: false, reason: `B3 fail: [${triedLog.join(', ')}]` };
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

  // Early-exit: nếu dialog đã đóng hết (FB submit nhanh / Tab+Enter ở step trước đã post)
  // → bài đã đăng thành công, không cần tìm nút "Đăng" nữa.
  const alreadyDone = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    for (const d of dialogs) {
      const t = d.textContent || '';
      if (t.includes('Cài đặt bài viết') || t.includes('Post settings') ||
          t.includes('Tạo bài viết') || t.includes('Create post') || t.includes('Create Post')) return false;
    }
    return true;
  });
  if (alreadyDone) {
    await _qpLog(steps, 'Step 6: dialog đã đóng trước khi click "Đăng" — bài đã được gửi ở bước trước');
    const postUrl = await urlPromise;
    return { success: true, postUrl: postUrl || null };
  }

  // Scroll tất cả dialog xuống BOTTOM (theo flow cũ submitPost) — submit button ở cuối
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(300, 600);

  // Scope vào dialog "Cài đặt bài viết" (chứa "Đăng" button + "Lưu" button)
  // FB modal portal có thể stack DOM khác thứ tự — không dùng last dialog
  const settingsDialog = page.locator('div[role="dialog"]').filter({ hasText: 'Cài đặt bài viết' }).first();

  let clickedVia = null;

  // A. aria-label exact trong settings dialog
  for (const lbl of ['Đăng', 'Post']) {
    try {
      await settingsDialog.locator(`[aria-label="${lbl}"]`).first().click({ force: true, timeout: 3000 });
      clickedVia = `aria-label="${lbl}"`;
      break;
    } catch (_) {}
  }

  // B. getByRole(button, name=Đăng) trong settings dialog
  if (!clickedVia) {
    for (const lbl of ['Đăng', 'Post']) {
      try {
        await settingsDialog.getByRole('button', { name: lbl, exact: true }).first().click({ force: true, timeout: 3000 });
        clickedVia = `getByRole(button,${lbl})`;
        break;
      } catch (_) {}
    }
  }

  // C. Walk-up exact text trong dialog "Cài đặt bài viết" (scoped)
  if (!clickedVia) {
    const ok = await page.evaluate(() => {
      const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      let dialog = null;
      for (const cand of ds) {
        const t = cand.textContent || '';
        if (t.includes('Cài đặt bài viết') || t.includes('Post settings') || t.includes('Post Settings')) {
          dialog = cand; break;
        }
      }
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
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (ok) clickedVia = 'walk-up text→role=button';
  }

  // D. Broad fallback: tìm "Đăng" trong BẤT KỲ dialog nào (không ép scope "Cài đặt bài viết")
  // — dùng khi FB re-render dialog sau step 5 "Xong" làm mất text title tạm thời.
  if (!clickedVia) {
    await randomDelay(800, 1500);
    const ok = await page.evaluate(() => {
      for (const lbl of ['Đăng', 'Post']) {
        // Phase 1: aria-label trong bất kỳ div visible nào
        const byLabel = document.querySelector(`[aria-label="${lbl}"][role="button"], button[aria-label="${lbl}"]`);
        if (byLabel) {
          const r = byLabel.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { byLabel.scrollIntoView({ block: 'center' }); byLabel.click(); return lbl; }
        }
        // Phase 2: span text exact → walk-up role=button trong bất kỳ dialog
        const dialogs = document.querySelectorAll('div[role="dialog"], [aria-modal="true"]');
        for (const d of dialogs) {
          for (const s of d.querySelectorAll('span')) {
            if ((s.textContent || '').trim() !== lbl) continue;
            let el = s;
            for (let i = 0; i < 8 && el.parentElement; i++) {
              el = el.parentElement;
              if (el.getAttribute('role') === 'button') {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                el.scrollIntoView({ block: 'center' });
                el.click();
                return lbl;
              }
            }
          }
        }
      }
      return null;
    });
    if (ok) clickedVia = `broad-fallback(${ok})`;
  }

  if (!clickedVia) {
    const shot = await _qpScreenshot(page, 'step6-no-button');
    await _qpLog(steps, `Step 6: KHÔNG tìm thấy nút "Đăng" (screenshot=${shot})`);
    return { success: false, error: `no Đăng button (screenshot=${shot})` };
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
// Helper: close share-groups dialog ("Chọn nhóm") để quay về "Cài đặt bài viết"
// Dùng khi step 4/5 fail và cần fallback sang đăng cá nhân không share group.
async function _qpCloseShareGroupsDialog(page) {
  const dialog = page.locator('div[role="dialog"]').filter({ hasText: 'Chọn nhóm' }).first();
  // Method 1: click back arrow trong dialog (aria-label Quay lại/Back)
  for (const lbl of ['Quay lại', 'Back']) {
    try {
      await dialog.locator(`[aria-label="${lbl}"]`).first().click({ force: true, timeout: 2000 });
      break;
    } catch (_) {}
  }
  // Verify dialog "Chọn nhóm" đã đóng
  try {
    await page.waitForFunction(() => {
      const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      for (const d of ds) {
        if ((d.textContent || '').includes('Chọn nhóm')) return false;
      }
      return true;
    }, { timeout: 3000 });
    return true;
  } catch {
    // Method 2: Escape key (fallback)
    await page.keyboard.press('Escape');
    try {
      await page.waitForFunction(() => {
        const ds = document.querySelectorAll('div[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        for (const d of ds) {
          if ((d.textContent || '').includes('Chọn nhóm')) return false;
        }
        return true;
      }, { timeout: 2000 });
      return true;
    } catch { return false; }
  }
}

async function quickPostToPersonalAndGroups(message, imagePaths = [], groupKeywords = []) {
  const _profileKey = activeProfile;
  const t0 = Date.now();
  const profileSnap = getActiveProfile();
  const tag = `[quickPost ${profileSnap.name}]`;
  const steps = [];
  logger.info(`${tag} bắt đầu (msg=${message ? `${message.length} ký tự` : '∅'}, ảnh=${imagePaths.length}, groups=${groupKeywords.length})`);

  const keywords = (groupKeywords || []).map(k => String(k).trim()).filter(Boolean).slice(0, 9);
  const wantShare = keywords.length > 0;

  const browser = await getBrowser();

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(1500, 2500);
    await ensureLoggedIn(page);

    if (!(await qpStep1OpenComposer(page, steps))) {
      const shot = await _qpScreenshot(page, 'step1-fail');
      return { success: false, error: `Step 1 fail (screenshot=${shot})`, steps };
    }
    await randomDelay(600, 1000);

    if (!(await qpStep2FillContent(page, steps, message, imagePaths))) {
      const shot = await _qpScreenshot(page, 'step2-fail');
      return { success: false, error: `Step 2 fail (screenshot=${shot})`, steps };
    }
    await randomDelay(600, 1000);

    // Nhánh có share group: Tiếp → Chia sẻ lên nhóm → tick → Xong → Đăng
    // FALLBACK an toàn: nếu step 4/5 fail (chưa post), tự click "Đăng" để post
    // cá nhân thay vì để mất luôn cả bài cá nhân.
    if (wantShare) {
      if (!(await qpStep3ClickNext(page, steps))) {
        const shot = await _qpScreenshot(page, 'step3-fail');
        return { success: false, error: `Step 3 fail (screenshot=${shot})`, steps };
      }
      await randomDelay(800, 1500);

      // Step 4: open share-groups dialog
      const step4ok = await qpStep4OpenShareToGroups(page, steps);

      if (!step4ok) {
        // FALLBACK 1: vẫn ở "Cài đặt bài viết" → click "Đăng" để post personal-only
        await _qpLog(steps, '⚠ Step 4 fail → fallback đăng cá nhân không share group');
        const submit = await qpStep6Submit(page, steps);
        logger.info(`${tag} fallback personal-only (+${Date.now() - t0}ms)`);
        return {
          success: submit.success,
          postUrl: submit.postUrl,
          sharedGroups: [],
          missedGroups: keywords,
          partialSuccess: submit.success,
          steps,
          error: submit.success ? undefined : (submit.error || 'Step 4 fail và fallback Đăng cũng fail'),
        };
      }
      await randomDelay(500, 1000);

      // Step 5: tick groups
      const pick = await qpStep5PickGroups(page, steps, keywords);

      if (pick.selected.length === 0 && keywords.length > 0) {
        // FALLBACK 2: stuck ở "Chọn nhóm" → close dialog → quay về "Cài đặt" → Đăng personal-only
        await _qpLog(steps, '⚠ Step 5 fail (0 groups ticked) → cancel "Chọn nhóm" → fallback đăng cá nhân');
        const closed = await _qpCloseShareGroupsDialog(page);
        if (!closed) {
          const shot = await _qpScreenshot(page, 'step5-cant-cancel');
          return { success: false, error: `Step 5 fail và không close được "Chọn nhóm" để fallback (screenshot=${shot})`, steps, missedGroups: pick.missed };
        }
        await randomDelay(600, 1000);
        const submit = await qpStep6Submit(page, steps);
        logger.info(`${tag} fallback personal-only sau step5 fail (+${Date.now() - t0}ms)`);
        return {
          success: submit.success,
          postUrl: submit.postUrl,
          sharedGroups: [],
          missedGroups: pick.missed,
          partialSuccess: submit.success,
          steps,
          error: submit.success ? undefined : (submit.error || 'Step 5 fail và fallback Đăng cũng fail'),
        };
      }
      await randomDelay(600, 1000);

      // Happy path: ticked some groups → step 6 Đăng (full flow)
      const submit = await qpStep6Submit(page, steps);
      logger.info(`${tag} done (+${Date.now() - t0}ms)`);
      return {
        success: submit.success,
        postUrl: submit.postUrl,
        sharedGroups: pick.selected,
        missedGroups: pick.missed,
        partialSuccess: submit.success && pick.missed.length > 0,  // partial nếu missed some groups
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
    await randomDelay(800, 1500);

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
    await randomDelay(2000, 3000);
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

// =============================================================================
// SCRAPE POST — lấy nội dung text + URL ảnh từ link bài viết FB
// Dùng browser đã login của profile đang active để bypass auth / private group.
// Ảnh lấy URL trực tiếp từ DOM (không download file) → trả imageUrls.
// =============================================================================

// "Vân tay" ảnh FB để gộp trùng. FB phục vụ CÙNG MỘT ảnh ở nhiều URL khác nhau
// (nhiều độ phân giải, khác query token, lấy từ DOM srcset lẫn network response)
// → dedup theo URL nguyên văn sẽ đếm trùng, làm phình số ảnh. Tên file CDN có
// dạng "<photoId>_<ownerId>_..._n.jpg" — 2 số đầu định danh đúng 1 ảnh, dùng làm key.
function fbImageKey(u) {
  try {
    const pathPart = u.split('?')[0];
    const file = pathPart.substring(pathPart.lastIndexOf('/') + 1);
    const m = file.match(/(\d{6,})_(\d{6,})/);
    return m ? `${m[1]}_${m[2]}` : pathPart;
  } catch {
    return u;
  }
}

// Các khoá GraphQL mở đầu nhánh BÌNH LUẬN. Caption của BÀI nằm ở node "message"
// của story (cấp cao), còn text bình luận/trả lời cũng là "message.text" nhưng nằm
// SÂU trong các nhánh này. Trước đây ta gom tất cả message rồi lấy bản DÀI NHẤT →
// bài caption ngắn + comment dài sẽ bị "lấy nhầm comment". Đánh dấu inComments khi
// đi xuống các nhánh này để KHÔNG gom text bình luận làm caption.
const GQL_COMMENT_KEYS = new Set([
  'feedback', 'comments', 'display_comments', 'comment_list_renderer',
  'comment_rendering_instance', 'comment_rendering_instance_for_feed_location',
  'replies', 'reply', 'comment',
]);

// Đệ quy gom caption (message.text) của BÀI trong payload GraphQL của FB. Cách lấy
// này KHÔNG phụ thuộc cấu trúc HTML (vốn đổi liên tục) — text bài luôn nằm trong
// node "message" của story. Bỏ qua nhánh bình luận (xem GQL_COMMENT_KEYS). Trả về
// mảng để bên gọi chọn bản dài nhất (= bài chính).
function collectGraphQLText(node, out, depth = 0, inComments = false) {
  if (!node || typeof node !== 'object' || depth > 30) return;
  if (Array.isArray(node)) {
    for (const v of node) collectGraphQLText(v, out, depth + 1, inComments);
    return;
  }
  if (!inComments) {
    const msg = node.message;
    if (msg && typeof msg === 'object' && typeof msg.text === 'string') {
      const t = msg.text.trim();
      if (t) out.push(t);
    }
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') {
      collectGraphQLText(v, out, depth + 1, inComments || GQL_COMMENT_KEYS.has(k));
    }
  }
}

// Đệ quy gom thời điểm đăng (creation_time, đơn vị giây Unix) của BÀI. Bỏ qua nhánh
// bình luận (comment cũng có creation_time). Bên gọi lấy mốc MUỘN NHẤT trong các
// node không phải comment = thời điểm bài được đăng/chia sẻ.
function collectGraphQLTime(node, out, depth = 0, inComments = false) {
  if (!node || typeof node !== 'object' || depth > 30) return;
  if (Array.isArray(node)) {
    for (const v of node) collectGraphQLTime(v, out, depth + 1, inComments);
    return;
  }
  if (!inComments) {
    const ct = node.creation_time;
    if (typeof ct === 'number' && ct > 1000000000 && ct < 4000000000) out.push(ct);
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') {
      collectGraphQLTime(v, out, depth + 1, inComments || GQL_COMMENT_KEYS.has(k));
    }
  }
}

// Đệ quy gom URL ảnh trong payload GraphQL. Ảnh bài viết nằm ở các node
// image/photo_image/viewer_image kèm width/height — lấy thẳng URL gốc, không cần
// chờ DOM lazy-load, không dính ảnh quảng cáo/gợi ý load lẫn trên trang.
function collectGraphQLImages(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 30) return;
  if (Array.isArray(node)) {
    for (const v of node) collectGraphQLImages(v, out, depth + 1);
    return;
  }
  for (const key of ['image', 'photo_image', 'viewer_image', 'large_share_image']) {
    const im = node[key];
    if (im && typeof im === 'object' && typeof im.uri === 'string') {
      out.push({ uri: im.uri, w: Number(im.width) || 0, h: Number(im.height) || 0 });
    }
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') collectGraphQLImages(v, out, depth + 1);
  }
}

// Đổi link FB sang bản mbasic.facebook.com (HTML thuần, không modal/JS). Bản này
// render bài viết thành trang riêng đơn giản → lấy caption + ảnh ổn định hơn nhiều
// so với bản desktop (vốn hay bung modal đè lên trang nền).
function toMbasicUrl(u) {
  try {
    const url = new URL(u);
    if (!url.hostname.endsWith('facebook.com')) return null;
    url.hostname = 'mbasic.facebook.com';
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

// Lấy text + ảnh từ bản mbasic. Trả {text, images} hoặc null nếu thất bại
// (redirect login / không có nội dung). KHÔNG ném lỗi để bên gọi fallback desktop.
async function fetchMbasic(page, postUrl, tag) {
  const mUrl = toMbasicUrl(postUrl);
  if (!mUrl) return null;
  try {
    await page.goto(mUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(800, 1400);
    const cur = page.url();
    if (/login|checkpoint/i.test(cur)) {
      logger.warn(`${tag} mbasic bị chuyển sang login (${cur}) — bỏ qua mbasic`);
      return null;
    }
    const result = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
      // Vùng bài viết: mbasic gói trong #m_story_permalink_view; fallback body.
      const scope = document.querySelector('#m_story_permalink_view')
        || document.querySelector('[id^="m_story_permalink_view"]')
        || document.body;

      // TEXT: chọn khối nhiều CHỮ nhất nhưng ÍT phần tử con (tức là khối caption,
      // không phải container bao cả bài/bình luận). Bỏ khối chứa form (ô comment).
      let bestText = '', bestScore = -Infinity;
      for (const el of scope.querySelectorAll('p, div, span')) {
        if (el.querySelector('form, input, textarea')) continue;
        const t = norm(el.innerText);
        if (t.length < 12) continue;
        const score = t.length - 40 * el.querySelectorAll('*').length;
        if (score > bestScore) { bestScore = score; bestText = t; }
      }

      // ẢNH: mọi img fbcdn/scontent trong vùng bài, bỏ icon/avatar nhỏ.
      const seen = new Set();
      const images = [];
      for (const img of scope.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if (!/fbcdn\.net|scontent/.test(src)) continue;
        if (src.includes('static.xx.fbcdn.net')) continue;
        if (/\/v\/t1\.\d+-1\//.test(src)) continue; // avatar
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w && h && w <= 80 && h <= 80) continue;
        if (!seen.has(src)) { seen.add(src); images.push(src); }
      }
      return { text: bestText, images };
    }).catch(() => null);

    if (!result) return null;
    logger.info(`${tag} mbasic: text=${result.text.length} ký tự, ảnh=${result.images.length}`);
    return result;
  } catch (e) {
    logger.warn(`${tag} mbasic lỗi: ${e.message} — fallback desktop`);
    return null;
  }
}

// Phân loại URL bài viết từ đường dẫn: group / post / profile_or_page.
function detectPostType(url) {
  try {
    const path = new URL(url).pathname;
    if (path.includes('/groups/')) return 'group';
    if (path.includes('/permalink/') || path.includes('/posts/')
      || url.includes('story_fbid') || /\/p\/[^/]+/.test(path)) return 'post';
    return 'profile_or_page';
  } catch {
    return 'unknown';
  }
}

async function scrapePost(postUrl) {
  const _profileKey = activeProfile;
  const t0 = Date.now();
  const postType = detectPostType(postUrl);
  const profileSnap = getActiveProfile();
  const tag = `[scrapePost ${profileSnap.name}]`;
  logger.info(`${tag} bắt đầu — url=${postUrl}`);

  // Trích post ID từ URL để tìm đúng article sau khi load
  // pfbid... hoặc numeric ID (/posts/123456789)
  const postIdMatch = postUrl.match(/pfbid[\w]+/) || postUrl.match(/\/(\d{10,})(?:[/?#]|$)/);
  const postId = postIdMatch ? postIdMatch[0].replace(/^\//, '') : null;
  logger.info(`${tag} postId=${postId || '(không tìm được)'}`);

  const browser = await getBrowser();

  // Bắt ảnh từ network response ngay khi load (trước goto) để không bỏ sót
  const netImages = new Set();
  // Gom payload GraphQL để lấy text + ảnh từ JSON (đáng tin hơn DOM rất nhiều).
  const graphqlBlobs = [];

  let page;
  try {
    page = await Promise.race([
      browser.newPage(),
      new Promise((_, r) => setTimeout(() => r(new Error('newPage timeout 30s — browser bị kẹt, thử lại lần sau')), 30000)),
    ]);
    page.on('response', (response) => {
      try {
        const url = response.url();
        if (!url.includes('fbcdn.net')) return;
        if (url.includes('static.xx.fbcdn.net')) return;
        if (/_p\d+x\d+_/.test(url)) return;
        if (/\/v\/t1\.\d+-1\//.test(url)) return;
        const urlPath = url.split('?')[0];
        if (!/\.(jpg|jpeg|png|webp)$/i.test(urlPath)) return;
        netImages.add(url);
      } catch {}
    });
    // Bắt body các response GraphQL — chứa caption + URL ảnh dạng JSON có cấu trúc.
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (!/graphql/i.test(url)) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text')) return;
        const body = await response.text();
        if (!body) return;
        for (const json of parseGraphQLBody(body)) graphqlBlobs.push(json);
      } catch {}
    });
    // bringToFront: tab mới tạo bởi newPage() là background tab —
    // Intersection Observer của FB không fire cho background tab
    // → ảnh lazy-load không render vào DOM nếu không bring to front
    await page.bringToFront();

    // === BƯỚC 1: thử mbasic trước (HTML thuần, không modal) — nguồn text ổn nhất ===
    const mbasic = await fetchMbasic(page, postUrl, tag);

    // === BƯỚC 2: load bản desktop để lấy ảnh full-res + dự phòng text ===
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(2000, 3000);
    await ensureLoggedIn(page);

    // Đóng overlay/dialog nếu có (login gate, cookie consent)
    await page.keyboard.press('Escape').catch(() => {});
    await randomDelay(300, 500);

    // Không dùng networkidle — FB liên tục có background requests nên networkidle
    // gần như KHÔNG BAO GIỜ resolve, luôn timeout 20s lãng phí. Thay bằng wait
    // thẳng cho article element xuất hiện (React SPA render xong).
    await page.waitForSelector('div[role="article"]', { timeout: 15000 }).catch(() => {});
    await randomDelay(500, 1000);

    // Sau khi JS routing xong, FB có thể redirect pfbid → numeric ID
    // Đọc lại URL thực tế + trích thêm story_fbid / numeric từ query string
    const resolvedUrl = page.url();
    logger.info(`${tag} resolvedUrl=${resolvedUrl}`);
    const allIds = new Set();
    if (postId) allIds.add(postId);
    for (const m of [
      resolvedUrl.match(/pfbid[\w]+/),
      resolvedUrl.match(/story_fbid=(\d+)/),
      resolvedUrl.match(/\/posts\/(\d{10,})/),
      resolvedUrl.match(/permalink\/(\d{10,})/),
    ]) {
      if (m) allIds.add(m[1] || m[0]);
    }
    logger.info(`${tag} allIds=${[...allIds].join(',')}`);

    // Resolve ĐÚNG article của bài viết MỘT LẦN thành ElementHandle ổn định.
    // FB ảo hoá (virtualize) feed: liên tục thêm/bớt div[role="article"] khỏi
    // DOM khi cuộn → nếu tham chiếu theo INDEX thì index trỏ sang bài KHÁC sau
    // mỗi lần cuộn (đây chính là lý do trước đây "cứ cuộn ngoài feed", lấy nhầm
    // ảnh + không thấy text). Dùng ElementHandle để mọi thao tác bám đúng 1 node
    // bất kể DOM thay đổi.
    const articleHandle = await page.evaluateHandle((ids) => {
      // ƯU TIÊN 0 — MODAL/THEATER: mở link bài trên profile/page thường KHÔNG ra
      // trang riêng mà bung 1 dialog overlay ("... 's Post") đè lên trang nền.
      // Nội dung bài (caption + ảnh) nằm TRONG dialog; còn [role=main] phía sau là
      // trang profile nền (Personal details, Friends, feed riêng) → chính là nguồn
      // lấy NHẦM text/ảnh trước đây. Nếu thấy dialog có nội dung → dùng nó làm scope.
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      let bestDlg = null, bestDlgArea = 0;
      for (const dlg of dialogs) {
        const hasText = !!dlg.querySelector('div[dir="auto"]');
        let maxArea = 0;
        for (const img of dlg.querySelectorAll('img')) {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          maxArea = Math.max(maxArea, w * h);
        }
        // dialog của bài có cả text lẫn ảnh lớn (>200px cạnh) — loại popup menu nhỏ
        if (hasText && maxArea > 200 * 200 && maxArea > bestDlgArea) {
          bestDlgArea = maxArea;
          bestDlg = dlg;
        }
      }
      if (bestDlg) {
        const art = bestDlg.querySelector('div[role="article"]');
        return art || bestDlg;
      }

      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      if (!topLevel.length) return null;

      // Chỉ xét article NẰM TRONG [role=main] (vùng bài chính) nếu có — loại bài
      // gợi ý/feed ở cột bên hoặc cuối trang.
      const main = document.querySelector('[role="main"]');
      const pool = (main && topLevel.some(a => main.contains(a)))
        ? topLevel.filter(a => main.contains(a))
        : topLevel;

      // Chiến lược 1 (đáng tin nhất): article chứa "message preview" của bài chính.
      // FB gắn data-ad-comet-preview="message" cho phần caption của bài → bám đúng
      // bài chính bất kể ID. Quan trọng cho post của Page: link nội bộ dùng numeric
      // id, KHÔNG khớp pfbid trên URL → chiến lược "khớp ID link" bên dưới sẽ trượt,
      // và fallback chấm điểm dễ chọn nhầm bài/ads nhiều ảnh nhưng không có caption.
      const msgRoot = main || document;
      for (const sel of ['[data-ad-comet-preview="message"]', '[data-ad-preview="message"]']) {
        const msg = msgRoot.querySelector(sel);
        if (msg) {
          const art = msg.closest('div[role="article"]');
          if (art && pool.includes(art)) return art;
        }
      }

      // Chiến lược 2: pagelet permalink đặc thù
      const pagelet = document.querySelector(
        '[data-pagelet="PermalinkPost"], [data-pagelet*="permalink"], [data-pagelet="FeedUnit_0"]'
      );
      if (pagelet) {
        const art = pagelet.querySelector('div[role="article"]');
        if (art && pool.includes(art)) return art;
      }

      // Chiến lược 3: article chứa link khớp BẤT KỲ post ID nào
      for (const art of pool) {
        for (const link of art.querySelectorAll('a[href]')) {
          if (!link.href) continue;
          for (const id of ids) {
            if (id && link.href.includes(id)) return art;
          }
        }
      }

      // Chiến lược 4 (fallback): chấm điểm theo NỘI DUNG. Ưu tiên MẠNH article có
      // caption (message preview) — đó gần như chắc chắn là bài chính. Ảnh chỉ là
      // phụ trợ với trọng số NHỎ + có trần, để 1 bài/ads nhiều ảnh nhưng KHÔNG có
      // caption không thể vượt mặt bài thật (lỗi cũ: imgCount*300 lấn át text).
      let best = null, bestScore = -1;
      for (const art of pool) {
        let textLen = 0;
        for (const dir of art.querySelectorAll('div[dir="auto"]')) {
          if (dir.closest('div[role="article"]') !== art) continue;
          textLen = Math.max(textLen, (dir.innerText || '').trim().length);
        }
        let imgCount = 0;
        for (const img of art.querySelectorAll('img')) {
          if (img.closest('div[role="article"]') !== art) continue;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w > 64 && h > 64) imgCount++;
        }
        const hasCaption = !!art.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
        const score = textLen
          + Math.min(imgCount, 3) * 40   // ảnh: trọng số nhỏ + trần, không lấn át text
          + (hasCaption ? 5000 : 0);     // có caption → gần như chắc chắn là bài chính
        if (score > bestScore) { bestScore = score; best = art; }
      }
      return best || pool[0];
    }, [...allIds]).catch(() => null);

    const articleEl = articleHandle && articleHandle.asElement ? articleHandle.asElement() : null;

    const articleCount = await page.evaluate(() =>
      document.querySelectorAll('div[role="article"]').length
    ).catch(() => 0);
    logger.info(`${tag} articleCount=${articleCount}, target=${articleEl ? 'OK' : 'KHÔNG TÌM THẤY'}`);

    if (articleEl) {
      // Cuộn article vào viewport (để Intersection Observer của FB fire)
      await articleEl.scrollIntoViewIfNeeded().catch(() => {});
      await randomDelay(700, 1100);

      // Click "Xem thêm" / "See more" CHỈ trong article mục tiêu
      await articleEl.evaluate((article) => {
        const LABELS = ['Xem thêm', 'See more', 'See More'];
        for (const el of article.querySelectorAll('div[role="button"], span[role="button"]')) {
          if (LABELS.includes((el.textContent || '').trim())) { el.click(); return; }
        }
      }).catch(() => {});
      await randomDelay(1200, 1800);
    }

    // Lấy text từ scope mục tiêu (article HOẶC dialog của modal — handle ổn định).
    const textInArticle = articleEl ? await articleEl.evaluate((scope) => {
      const SEE_MORE = new Set(['Xem thêm', 'See more', 'See More']);
      // "Bài chính" trong scope: nếu scope là article thì chính nó; nếu scope là
      // dialog thì là article đầu tiên trong dialog (nếu có). Dùng để loại nội dung
      // bình luận (nằm trong article KHÁC) mà không loại nhầm nội dung bài.
      const primaryArticle = scope.getAttribute('role') === 'article'
        ? scope
        : scope.querySelector('div[role="article"]');
      const inComment = (el) => {
        const art = el.closest('div[role="article"]');
        return art && scope.contains(art) && primaryArticle && art !== primaryArticle;
      };
      // Thử selector đặc thù của FB trước
      for (const sel of ['[data-ad-preview="message"]', '[data-ad-comet-preview="message"]']) {
        const el = scope.querySelector(sel);
        if (el && !inComment(el)) {
          const t = (el.innerText || '').trim();
          if (t) return t;
        }
      }
      const cleanText = (node) => {
        const clone = node.cloneNode(true);
        for (const btn of clone.querySelectorAll('[role="button"]')) {
          if (SEE_MORE.has((btn.textContent || '').trim())) btn.remove();
        }
        return (clone.innerText || '').trim();
      };

      // Tìm div[dir="auto"] DÀI NHẤT làm "mỏ neo" của nội dung chính.
      let anchor = null, anchorLen = 0;
      for (const dir of scope.querySelectorAll('div[dir="auto"]')) {
        if (inComment(dir)) continue; // bỏ nội dung bình luận
        const len = cleanText(dir).length;
        if (len > anchorLen) { anchorLen = len; anchor = dir; }
      }
      if (!anchor) return '';

      // Bài nhiều đoạn được FB tách thành nhiều div[dir="auto"] ANH EM trong cùng
      // container → chỉ lấy đoạn dài nhất sẽ MẤT các đoạn còn lại. Gom mọi đoạn
      // anh em (cùng parent) lại. Header tác giả / thời gian / reactions nằm ở
      // container khác nên không bị dính vào.
      const container = anchor.parentElement || anchor;
      const blocks = [];
      for (const dir of container.children) {
        if (dir.matches && dir.matches('div[dir="auto"]')) {
          const t = cleanText(dir);
          if (t) blocks.push(t);
        }
      }
      if (blocks.length > 1) return blocks.join('\n');
      return cleanText(anchor);
    }).catch(() => '') : '';

    // Fallback toàn trang: nếu chưa lấy được text trong article (article chọn sai
    // hoặc không tìm thấy), quét "message preview" ở bất kỳ đâu — đây là selector
    // caption đáng tin nhất của FB. Lấy bản dài nhất (bài chính dài hơn ads/gợi ý).
    let text = textInArticle;
    if (!text) {
      text = await page.evaluate(() => {
        const SEE_MORE = new Set(['Xem thêm', 'See more', 'See More']);
        const main = document.querySelector('[role="main"]') || document;
        let best = '';
        for (const sel of ['[data-ad-comet-preview="message"]', '[data-ad-preview="message"]']) {
          for (const el of main.querySelectorAll(sel)) {
            const clone = el.cloneNode(true);
            for (const btn of clone.querySelectorAll('[role="button"]')) {
              if (SEE_MORE.has((btn.textContent || '').trim())) btn.remove();
            }
            const t = (clone.innerText || '').trim();
            if (t.length > best.length) best = t;
          }
        }
        return best;
      }).catch(() => '');
      if (text) logger.info(`${tag} text lấy từ fallback message-preview toàn trang`);
    }

    // === Trích text + ảnh từ GraphQL (nguồn chính, đáng tin hơn DOM) ===
    // Lấy TRƯỚC khi cuộn để tránh dính payload của bài gợi ý/quảng cáo load thêm
    // lúc cuộn. Caption bài chính = message dài nhất; ảnh = các node image trong
    // story (dedup theo photoId, bỏ avatar/icon).
    const gqlTextCandidates = [];
    const gqlImagesRaw = [];
    const gqlTimes = [];
    for (const blob of graphqlBlobs) {
      collectGraphQLText(blob, gqlTextCandidates);
      collectGraphQLImages(blob, gqlImagesRaw);
      collectGraphQLTime(blob, gqlTimes);
    }
    gqlTextCandidates.sort((a, b) => b.length - a.length);
    const gqlText = gqlTextCandidates[0] || '';

    // Thời điểm đăng: mốc MUỘN NHẤT trong các node không phải comment = lúc bài được
    // đăng/chia sẻ. null nếu payload không có creation_time.
    const gqlTimeMax = gqlTimes.length ? Math.max(...gqlTimes) : null;
    const timestamp = gqlTimeMax ? new Date(gqlTimeMax * 1000).toISOString() : null;

    const gqlImgMap = new Map();
    for (const { uri, w, h } of gqlImagesRaw) {
      if (!uri || !uri.includes('fbcdn.net')) continue;
      if (uri.includes('static.xx.fbcdn.net')) continue;
      if (/\/v\/t1\.\d+-1\//.test(uri)) continue;       // ảnh đại diện
      if (w && h && w <= 100 && h <= 100) continue;      // icon/avatar/emoji
      const key = fbImageKey(uri);
      const area = (w || 0) * (h || 0);
      const prev = gqlImgMap.get(key);
      if (!prev || area > prev.area) gqlImgMap.set(key, { uri, area });
    }
    const gqlImages = [...gqlImgMap.values()].map(x => x.uri);
    logger.info(`${tag} GraphQL: text=${gqlText.length} ký tự, ảnh=${gqlImages.length} (blobs=${graphqlBlobs.length})`);

    // QUAN TRỌNG: xoá ảnh network bắt được trong lúc load trang. Lúc load,
    // FB tải hàng loạt ảnh KHÔNG thuộc bài viết: quảng cáo (Shopee/Uniqlo...),
    // bài gợi ý, sidebar, avatar bình luận → đây là nguồn "ảnh lung tung" và
    // khiến số ảnh phình lên cả trăm. Chỉ giữ ảnh tải LAZY trong lúc cuộn qua
    // đúng article mục tiêu bên dưới.
    netImages.clear();

    // Cuộn LẦN LƯỢT tới TỪNG ẢNH BÊN TRONG article mục tiêu để trigger lazy-load
    // — KHÔNG cuộn window xuống feed (đây là lý do trước cứ "cuộn ngoài feed").
    // Lặp vài vòng vì FB có thể render thêm ảnh album sau khi ảnh trước vào view.
    if (articleEl) {
      let lastCount = -1;
      for (let round = 0; round < 6; round++) {
        const count = await articleEl.evaluate((scope) => {
          const primaryArticle = scope.getAttribute('role') === 'article'
            ? scope : scope.querySelector('div[role="article"]');
          const inComment = (el) => {
            const art = el.closest('div[role="article"]');
            return art && scope.contains(art) && primaryArticle && art !== primaryArticle;
          };
          let n = 0;
          for (const img of scope.querySelectorAll('img')) {
            if (inComment(img)) continue;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w <= 64 && h <= 64) continue;
            img.scrollIntoView({ block: 'center', behavior: 'instant' });
            n++;
          }
          return n;
        }).catch(() => 0);
        await randomDelay(450, 700);
        if (count === lastCount) break; // không xuất hiện thêm ảnh mới
        lastCount = count;
      }
      // Đưa scope về đầu viewport cho lần quét DOM cuối ổn định
      await articleEl.scrollIntoViewIfNeeded().catch(() => {});
      await randomDelay(300, 500);
    }

    // Lấy URL ảnh từ scope mục tiêu qua DOM (bao gồm cả picture > source)
    const domImages = articleEl ? await articleEl.evaluate((scope) => {
      const primaryArticle = scope.getAttribute('role') === 'article'
        ? scope : scope.querySelector('div[role="article"]');
      const inComment = (el) => {
        const art = el.closest('div[role="article"]');
        return art && scope.contains(art) && primaryArticle && art !== primaryArticle;
      };
      const seen = new Set();
      const urls = [];

      const add = (src) => {
        if (!src || !src.startsWith('http')) return;
        if (!src.includes('fbcdn.net')) return;
        if (src.includes('static.xx.fbcdn.net')) return;
        if (/_p\d+x\d+_/.test(src)) return;
        if (/\/v\/t1\.\d+-1\//.test(src)) return;
        if (!seen.has(src)) { seen.add(src); urls.push(src); }
      };

      // Kiểm tra picture > source (FB dùng cho responsive images)
      for (const source of scope.querySelectorAll('picture source')) {
        if (inComment(source)) continue;
        if (source.srcset) {
          const candidates = source.srcset.split(',')
            .map(s => s.trim().split(/\s+/))
            .filter(p => p[0] && p[0].startsWith('http'));
          if (candidates.length) add(candidates[candidates.length - 1][0]);
        }
      }

      for (const img of scope.querySelectorAll('img')) {
        // Bỏ qua ảnh nằm trong article lồng (comment)
        if (inComment(img)) continue;

        // Bỏ qua ảnh quá nhỏ (avatar/icon ≤ 64px)
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w > 0 && h > 0 && w <= 64 && h <= 64) continue;

        // Ưu tiên srcset (chọn ảnh resolution cao nhất)
        if (img.srcset) {
          const candidates = img.srcset.split(',')
            .map(s => s.trim().split(/\s+/))
            .filter(p => p[0] && p[0].startsWith('http'));
          if (candidates.length) {
            add(candidates[candidates.length - 1][0]);
            continue;
          }
        }

        // Fallback: currentSrc → src → data-src
        add(img.currentSrc || img.src || img.getAttribute('data-src') || '');
      }
      return urls;
    }).catch(() => []) : [];

    // Gộp ảnh DOM + ảnh bắt từ network, dedup theo "vân tay" ảnh (photoId) thay
    // vì URL nguyên văn — cùng 1 ảnh xuất hiện ở DOM (srcset độ phân giải cao) và
    // network (kích thước khác) sẽ bị đếm trùng nếu so URL. Ưu tiên giữ URL DOM
    // (thường là bản phân giải cao nhất từ srcset).
    const seenKeys = new Set();
    const imageUrls = [];
    const pushUnique = (url) => {
      const key = fbImageKey(url);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      imageUrls.push(url);
    };
    for (const url of domImages) pushUnique(url);
    for (const url of netImages) pushUnique(url);

    // Scope có phải dialog/modal không? Khi mở link bài bung ra modal, DOM trong
    // dialog là CHÍNH XÁC bài đó → ưu tiên DOM. GraphQL lúc này dễ lẫn payload của
    // feed trang profile NỀN (cũng load qua graphql) nên kém tin hơn.
    const isModal = articleEl ? await articleEl.evaluate(
      (el) => el.getAttribute('role') === 'dialog' || !!el.closest('div[role="dialog"]')
    ).catch(() => false) : false;

    const mbasicText = mbasic && mbasic.text ? mbasic.text : '';
    const mbasicImages = mbasic && Array.isArray(mbasic.images) ? mbasic.images : [];

    // Chọn nguồn theo độ tin cậy:
    //  - TEXT: mbasic (HTML thuần, không modal — ổn nhất) → desktop (modal: DOM,
    //    permalink: GraphQL) → rỗng.
    //  - ẢNH: desktop full-res (modal: DOM trong dialog, permalink: GraphQL) →
    //    mbasic (thumbnail) — dùng mbasic chỉ khi desktop không có ảnh.
    const desktopText = isModal ? (text || gqlText) : (gqlText || text);
    const desktopImages = isModal
      ? (imageUrls.length ? imageUrls : gqlImages)
      : (gqlImages.length ? gqlImages : imageUrls);

    const finalText = mbasicText || desktopText;
    const finalImages = desktopImages.length ? desktopImages : mbasicImages;

    const textSrc = mbasicText ? 'mbasic'
      : (desktopText ? (isModal ? 'dom-modal' : (gqlText ? 'graphql' : 'dom')) : 'none');
    const imgSrc = desktopImages.length
      ? (isModal ? 'dom-modal' : (gqlImages.length ? 'graphql' : 'dom'))
      : (mbasicImages.length ? 'mbasic' : 'none');

    // Log chi tiết từng ứng viên text để chẩn đoán "lấy nhầm/sai nội dung": nhìn log
    // là biết mỗi nguồn lấy ra gì, từ đó truy ra vì sao chọn nguồn đó.
    const preview = (s) => (s || '').replace(/\s+/g, ' ').slice(0, 60);
    logger.info(`${tag} nguồn text — mbasic(${mbasicText.length}): "${preview(mbasicText)}" | gql(${gqlText.length}): "${preview(gqlText)}" | dom(${text.length}): "${preview(text)}" → chọn ${textSrc}`);

    logger.info(`${tag} xong (+${Date.now() - t0}ms) — type=${postType}, modal=${isModal}, text=${finalText.length} ký tự (${textSrc}), ảnh=${finalImages.length} (${imgSrc}; mbasic=${mbasicImages.length}, gql=${gqlImages.length}, dom=${domImages.length}, net=${netImages.size}), thời gian=${timestamp || 'N/A'}`);

    // Chụp screenshot để debug khi không lấy được nội dung
    if (!finalText && finalImages.length === 0) {
      const screenshotPath = path.resolve(__dirname, '../../logs', `scrape-empty-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      logger.warn(`${tag} WARN: kết quả rỗng (modal=${isModal}, articleCount=${articleCount}, blobs=${graphqlBlobs.length}) — screenshot: ${screenshotPath}`);
    }

    return { success: true, type: postType, text: finalText, imageUrls: finalImages, timestamp };
  } catch (e) {
    logger.error(`${tag} FAIL: ${e.message}`);
    return { success: false, error: e.message, type: postType, text: '', imageUrls: [], timestamp: null };
  } finally {
    const _ctx = browsers[_profileKey];
    browsers[_profileKey] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

// ===== SEEDING: Đăng bình luận xuống bài đã đăng =====

async function attachCommentImages(page, imagePaths, commentBox) {
  // Khớp aria-label nút "đính kèm ảnh" của khung bình luận — KHÔNG dùng kiểu
  // includes('nh') quá rộng (khớp gần hết chữ tiếng Việt) khiến bấm nhầm nút khác.
  const isPhotoLabel = (label) => {
    const l = (label || '').toLowerCase();
    if (!l) return false;
    if (l.includes('xem') || l.includes('view')) return false; // tránh "Xem ảnh"
    return l.includes('đính kèm') || l.includes('attach') ||
           l.includes('photo') || l.includes('camera') ||
           /(^|[^a-zà-ỹ])ảnh([^a-zà-ỹ]|$)/.test(l);
  };

  // Tìm "gốc" khung soạn bình luận chứa commentBox, để giới hạn mọi thao tác trong đó
  // → tránh bấm nhầm nút Ảnh của khung đăng bài hoặc set ảnh vào input sai.
  let scope = null;
  if (commentBox) {
    try {
      const h = await commentBox.evaluateHandle((box) => {
        let node = box;
        for (let i = 0; i < 12 && node && node.parentElement; i++) {
          node = node.parentElement;
          if (node.tagName === 'FORM') return node;
          if (node.querySelector('input[type="file"]')) return node;
        }
        return box.parentElement || box;
      });
      scope = h.asElement();
    } catch (e) {
      logger.warn(`attachCommentImages: không xác định được khung comment: ${e.message}`);
    }
  }

  // Cách 1 (đáng tin nhất): set thẳng vào input[type=file] BÊN TRONG khung comment, không cần click
  if (scope) {
    try {
      const inputEl = await scope.$('input[type="file"]');
      if (inputEl) {
        await inputEl.setInputFiles(imagePaths);
        logger.info(`attachCommentImages: scoped input OK (${imagePaths.length} ảnh)`);
        return true;
      }
    } catch (e) {
      logger.warn(`attachCommentImages scoped input fail: ${e.message}`);
    }
  }

  // Cách 2: bấm nút camera CHỈ trong khung comment (nếu có scope) rồi mở filechooser
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      (async () => {
        await randomDelay(300, 600);
        const buttons = scope
          ? await scope.$$('[aria-label]')
          : await page.$$('div[role="button"]');
        for (const btn of buttons) {
          const label = await btn.getAttribute('aria-label').catch(() => '');
          if (!isPhotoLabel(label)) continue;
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) { await btn.click({ force: true }); return; }
        }
      })(),
    ]);
    await fileChooser.setFiles(imagePaths);
    logger.info(`attachCommentImages: filechooser ${scope ? '(scoped) ' : ''}OK (${imagePaths.length} ảnh)`);
    return true;
  } catch (e) {
    logger.warn(`attachCommentImages filechooser fail: ${e.message}`);
  }

  // Cách 3 (chót): bất kỳ input file nào trên trang
  const inputs = await page.$$('input[type="file"]');
  for (const input of inputs) {
    try {
      await input.setInputFiles(imagePaths);
      logger.info('attachCommentImages: direct input (fallback) OK');
      return true;
    } catch { continue; }
  }

  return false;
}

// Đếm số ảnh preview (blob:/data:) đang hiển thị — dùng phát hiện ảnh comment mới đính.
async function countPreviewImages(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).filter(im => {
      const s = im.currentSrc || im.src || '';
      return (s.startsWith('blob:') || s.startsWith('data:')) && im.offsetWidth > 10 && im.offsetHeight > 10;
    }).length;
  }).catch(() => 0);
}

// Đợi ảnh comment đính kèm upload XONG mới được gửi:
//  (1) có preview mới so với baseline (ảnh thực sự được đính, không nhầm ảnh sẵn có trên trang),
//  (2) không còn spinner [role="progressbar"] và giữ ổn định ~1.2s.
// Gửi sớm khi ảnh chưa upload xong khiến FB rớt ảnh → chỉ đăng được mỗi text.
async function waitForCommentImageUploaded(page, baselineCount, timeout = 30000) {
  const start = Date.now();
  let previewSeen = false;
  let stableSince = 0;
  while (Date.now() - start < timeout) {
    const state = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const blobs = imgs.filter(im => {
        const s = im.currentSrc || im.src || '';
        return (s.startsWith('blob:') || s.startsWith('data:')) && im.offsetWidth > 10 && im.offsetHeight > 10;
      }).length;
      const spinners = document.querySelectorAll('[role="progressbar"]').length;
      return { blobs, spinners };
    }).catch(() => null);
    if (state) {
      if (state.blobs > baselineCount) previewSeen = true;
      if (previewSeen && state.spinners === 0) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1200) return true;
      } else {
        stableSince = 0;
      }
    }
    await page.waitForTimeout(400);
  }
  return previewSeen;
}

async function postComment({ postUrl, message, imagePaths, profile }) {
  const tag = `[postComment:${profile || activeProfile}]`;
  logger.info(`${tag} Bắt đầu seeding: ${postUrl}`);

  if (profile) setProfile(profile);

  const ctx = await getBrowser();
  const page = await ctx.newPage();

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(2000, 3500);

    // Tìm ô comment (có thể cần click "Bình luận" trước để mở)
    const commentBoxSelectors = [
      'div[contenteditable="true"][aria-label*="bình luận"]',
      'div[contenteditable="true"][aria-label*="Bình luận"]',
      'div[contenteditable="true"][aria-label*="comment"]',
      'div[contenteditable="true"][aria-label*="Comment"]',
      'div[contenteditable="true"][aria-label*="Write a comment"]',
      'div[contenteditable="true"][aria-label*="Viết bình luận"]',
    ];

    let commentBox = null;
    for (const sel of commentBoxSelectors) {
      try {
        const boxes = await page.$$(sel);
        for (const box of boxes) {
          const visible = await box.isVisible().catch(() => false);
          if (visible) { commentBox = box; break; }
        }
        if (commentBox) break;
      } catch { continue; }
    }

    // Nếu chưa thấy ô comment: thử click nút "Bình luận" để expand
    if (!commentBox) {
      const triggerSelectors = [
        'div[aria-label*="Bình luận"]',
        'div[aria-label*="Comment"]',
        'span:has-text("Bình luận")',
        'span:has-text("Comment")',
      ];
      for (const sel of triggerSelectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.click({ force: true }); await randomDelay(1000, 1500); break; }
        } catch { continue; }
      }
      // Thử lại tìm ô comment sau khi click trigger
      for (const sel of commentBoxSelectors) {
        try {
          const boxes = await page.$$(sel);
          for (const box of boxes) {
            const visible = await box.isVisible().catch(() => false);
            if (visible) { commentBox = box; break; }
          }
          if (commentBox) break;
        } catch { continue; }
      }
    }

    if (!commentBox) throw new Error('Không tìm thấy ô bình luận trên trang');

    await commentBox.scrollIntoViewIfNeeded();
    await randomDelay(400, 800);
    await commentBox.click({ force: true });
    await randomDelay(400, 800);

    // Nhập nội dung TRƯỚC (ô đang focus & rỗng → text chắc chắn vào đúng chỗ,
    // tránh việc thao tác upload ảnh cướp focus làm rớt text).
    if (message) {
      await pasteText(page, message);
      await randomDelay(400, 800);
    }

    // Upload ảnh SAU và ĐỢI upload XONG (preview mới + hết spinner) rồi mới gửi.
    // Trước đây chỉ chờ preview xuất hiện (dễ nhầm ảnh sẵn có) rồi gửi ngay → FB rớt ảnh.
    let baselineImgs = 0;
    const hasImages = imagePaths && imagePaths.length > 0;
    if (hasImages) {
      baselineImgs = await countPreviewImages(page);
      const imgOk = await attachCommentImages(page, imagePaths, commentBox);
      if (!imgOk) {
        logger.warn(`${tag} Không upload được ảnh comment`);
      } else {
        const uploaded = await waitForCommentImageUploaded(page, baselineImgs, 30000);
        if (uploaded) logger.info(`${tag} Ảnh đã upload xong, sẵn sàng gửi`);
        else logger.warn(`${tag} Ảnh có thể chưa upload xong sau 30s, vẫn thử gửi`);
        // Đệm thêm theo số ảnh để FB hoàn tất xử lý kể cả khi không bắt được tín hiệu spinner
        await randomDelay(1500, 2500);
        await page.waitForTimeout(1200 * imagePaths.length);
        // Re-focus ô comment (thao tác upload ảnh có thể làm mất focus)
        await commentBox.click({ force: true }).catch(() => {});
        await randomDelay(300, 600);
      }
    }

    // Submit: Ctrl+Enter là an toàn nhất trên FB comment
    await page.keyboard.press('Control+Enter');
    await randomDelay(2000, 3000);

    // Verify: nếu ô comment vẫn còn text HOẶC ảnh vẫn còn trong khung soạn → thử Enter thường
    const remaining = await commentBox.textContent().catch(() => '');
    const stillHasImg = hasImages ? (await countPreviewImages(page)) > baselineImgs : false;
    if ((remaining && remaining.trim()) || stillHasImg) {
      await commentBox.click({ force: true }).catch(() => {});
      await randomDelay(300, 500);
      await page.keyboard.press('Enter');
      await randomDelay(1500, 2500);
    }

    logger.info(`${tag} Seeding thành công`);
    return { success: true };
  } catch (e) {
    logger.error(`${tag} FAIL: ${e.message}`);
    return { success: false, error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { setProfile, profileExists, getActiveProfile, postToPersonal, postToGroup, postToPage, postPersonalAndShareToGroups, quickPostToPersonalAndGroups, scrapePost, closeBrowser, postComment };
