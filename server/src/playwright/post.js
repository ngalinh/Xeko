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

    // Nếu input không hỗ trợ multiple nhưng cần upload nhiều ảnh → bỏ qua,
    // dùng Cách 2 để tìm input[type=file][multiple] phù hợp hơn.
    if (imagePaths.length > 1 && !fileChooser.isMultiple()) {
      logger.warn(`FileChooser không hỗ trợ multiple (${imagePaths.length} ảnh) — chuyển sang Cách 2`);
      await fileChooser.setFiles([]).catch(() => {}); // dismiss chooser
    } else {
      await fileChooser.setFiles(imagePaths);
      uploaded = true;
      uploadMethod = 'filechooser';
      logger.info(`Upload ${imagePaths.length} ảnh thành công (filechooser)`);
    }
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
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-share-submit-failed.png') }).catch(() => {});
    return { success: false, sharedGroups: shareResult.selected, missedGroups: shareResult.missed };
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

  await randomDelay(800, 1500);

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(500, 900);

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

  // Smart wait: resolve ngay khi dialog "Tạo bài viết" đóng, tối đa 8s
  await page.waitForFunction(() => {
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    for (const d of dialogs) {
      for (const s of d.querySelectorAll('span')) {
        if ((s.textContent || '').trim() === 'Tạo bài viết' || (s.textContent || '').trim() === 'Create post') return false;
      }
    }
    return true;
  }, { timeout: 8000 }).catch(() => {});

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
      if (!imgOk) throw new Error(funMsg.errUpload() + ' (xem logs/debug-upload.png)');
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
      throw new Error(`${hint} (xem logs/debug-failed.png)`);
    }
    logger.info(`${tag} submit xong (${Date.now() - tSubmit}ms) — total ${Date.now() - t0}ms ✅${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal', postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await randomDelay(2000, 3000); // stay-alive: đợi FB xử lý xong trước khi đóng tab
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null; // xóa cache ngay để lần sau launch browser mới
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
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
      if (!imgOk) throw new Error(funMsg.errUpload() + ' (xem logs/debug-upload.png)');
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
      throw new Error(`${hint} (xem logs/debug-share-submit-failed.png)`);
    }
    logger.info(`${tag} xong (${Date.now() - t0}ms) ✅ shared=${Array.isArray(result.sharedGroups) ? result.sharedGroups.length : 0}/${kwList.length}${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: 'personal+groups', postUrl: result.postUrl || null, groups: kwList, sharedGroups: result.sharedGroups, missedGroups: result.missedGroups };
  } catch (error) {
    logger.error(`${tag} FAIL sau ${Date.now() - t0}ms: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await randomDelay(2000, 3000); // stay-alive: đợi FB xử lý xong trước khi đóng tab
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

async function postToGroup(groupId, message, imagePaths = []) {
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
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

async function postToPage(pageId, message, imagePaths = []) {
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
      await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-page-open.png') });
      throw new Error(`Không mở được popup tạo bài cho page ${pageId}. Chắc chắn đã switch sang page trong session chưa?`);
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

    const result = await submitPost(page);
    if (!result.success) {
      const hint = (!message && imagePaths.length > 0)
        ? 'FB không cho đăng bài chỉ có ảnh không text. Bạn thêm caption (vài dòng nội dung) rồi đăng lại nha!'
        : funMsg.errPost();
      throw new Error(`${hint} (xem logs/debug-failed.png)`);
    }

    logger.info(`Đã đăng bài page ${pageId} thành công!${result.postUrl ? ` postUrl=${result.postUrl}` : ''}`);
    return { success: true, target: `page:${pageId}`, postUrl: result.postUrl || null };
  } catch (error) {
    logger.error(`Lỗi postToPage(${pageId}): ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null;
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
    if (!ok) {
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

      if (pick.selected === 0 && keywords.length > 0) {
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
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

// =============================================================================
// SCRAPE POST — lấy nội dung text + URL ảnh từ link bài viết FB
// Dùng browser đã login của profile đang active để bypass auth / private group.
// Ảnh lấy URL trực tiếp từ DOM (không download file) → trả imageUrls.
// =============================================================================

async function scrapePost(postUrl) {
  const t0 = Date.now();
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
    // bringToFront: tab mới tạo bởi newPage() là background tab —
    // Intersection Observer của FB không fire cho background tab
    // → ảnh lazy-load không render vào DOM nếu không bring to front
    await page.bringToFront();
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

    // Tìm index của article đúng (top-level, chứa link có post ID)
    const articleIndex = await page.evaluate((ids) => {
      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      if (!topLevel.length) return 0;

      // Chiến lược 1: FB pagelet đặc thù cho permalink post
      const pagelet = document.querySelector(
        '[data-pagelet="PermalinkPost"], [data-pagelet*="permalink"], [data-pagelet="FeedUnit_0"]'
      );
      if (pagelet) {
        const art = pagelet.querySelector('div[role="article"]');
        if (art) {
          const idx = topLevel.indexOf(art);
          if (idx >= 0) return idx;
        }
      }

      // Chiến lược 2: tìm article chứa link khớp BẤT KỲ post ID nào
      for (let i = 0; i < topLevel.length; i++) {
        for (const link of topLevel[i].querySelectorAll('a[href]')) {
          if (!link.href) continue;
          for (const id of ids) {
            if (link.href.includes(id)) return i;
          }
        }
      }

      // Chiến lược 3: article đầu tiên nằm trong [role="main"]
      const main = document.querySelector('[role="main"]');
      if (main) {
        for (let i = 0; i < topLevel.length; i++) {
          if (main.contains(topLevel[i])) return i;
        }
      }

      // Chiến lược 4: article gần đầu trang nhất (nhỏ hơn 1 viewport từ trên)
      let best = { idx: 0, top: Infinity };
      for (let i = 0; i < topLevel.length; i++) {
        const top = topLevel[i].getBoundingClientRect().top;
        if (top >= 0 && top < best.top) best = { idx: i, top };
      }
      return best.idx;
    }, [...allIds]).catch(() => 0);

    // Log số lượng article tìm được để debug khi kết quả rỗng
    const articleCount = await page.evaluate(() =>
      document.querySelectorAll('div[role="article"]').length
    ).catch(() => 0);
    logger.info(`${tag} articleCount=${articleCount}, articleIndex=${articleIndex}`);

    // Cuộn article vào viewport trước (để Intersection Observer của FB fire)
    await page.evaluate((idx) => {
      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      const article = topLevel[idx] || topLevel[0];
      if (article) article.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, articleIndex).catch(() => {});
    await randomDelay(800, 1200);

    // Click "Xem thêm" / "See more" CHỈ trong article mục tiêu
    await page.evaluate((idx) => {
      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      const article = topLevel[idx] || topLevel[0];
      if (!article) return;
      const LABELS = ['Xem thêm', 'See more', 'See More'];
      for (const el of article.querySelectorAll('div[role="button"], span[role="button"]')) {
        if (LABELS.includes((el.textContent || '').trim())) { el.click(); return; }
      }
    }, articleIndex).catch(() => {});
    await randomDelay(1500, 2000);

    // Lấy text từ article mục tiêu
    const text = await page.evaluate((idx) => {
      const SEE_MORE = new Set(['Xem thêm', 'See more', 'See More']);
      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      const article = topLevel[idx] || topLevel[0];
      if (!article) return '';

      // Thử selector đặc thù của FB trước
      for (const sel of ['[data-ad-preview="message"]', '[data-ad-comet-preview="message"]']) {
        const el = article.querySelector(sel);
        if (el) return (el.innerText || '').trim();
      }

      // Lấy div[dir="auto"] DÀI NHẤT (nội dung chính) thay vì lấy đầu tiên
      let bestText = '';
      for (const dir of article.querySelectorAll('div[dir="auto"]')) {
        // Bỏ qua nếu nằm trong article lồng (comment)
        if (dir.closest('div[role="article"]') !== article) continue;
        const clone = dir.cloneNode(true);
        for (const btn of clone.querySelectorAll('[role="button"]')) {
          if (SEE_MORE.has((btn.textContent || '').trim())) btn.remove();
        }
        const t = (clone.innerText || '').trim();
        if (t.length > bestText.length) bestText = t;
      }
      return bestText;
    }, articleIndex).catch(() => '');

    // Scroll qua nội dung article để trigger lazy-load ảnh
    // (article đã ở đầu viewport từ scrollIntoView ở trên)
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await randomDelay(500, 800);
    }
    await randomDelay(500, 800);

    // Lấy URL ảnh từ article mục tiêu qua DOM (bao gồm cả picture > source)
    const domImages = await page.evaluate((idx) => {
      const all = Array.from(document.querySelectorAll('div[role="article"]'));
      const topLevel = all.filter(a => !a.parentElement?.closest('div[role="article"]'));
      const article = topLevel[idx] || topLevel[0];
      if (!article) return [];

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
      for (const source of article.querySelectorAll('picture source')) {
        if (source.closest('div[role="article"]') !== article) continue;
        if (source.srcset) {
          const candidates = source.srcset.split(',')
            .map(s => s.trim().split(/\s+/))
            .filter(p => p[0] && p[0].startsWith('http'));
          if (candidates.length) add(candidates[candidates.length - 1][0]);
        }
      }

      for (const img of article.querySelectorAll('img')) {
        // Bỏ qua ảnh nằm trong article lồng (comment)
        if (img.closest('div[role="article"]') !== article) continue;

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
    }, articleIndex).catch(() => []);

    // Bổ sung ảnh bắt được từ network (các ảnh DOM có thể chưa load kịp)
    const seenUrls = new Set(domImages);
    const imageUrls = [...domImages];
    for (const url of netImages) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        imageUrls.push(url);
      }
    }

    logger.info(`${tag} xong (+${Date.now() - t0}ms) — text=${text.length} ký tự, ảnh=${imageUrls.length} (dom=${domImages.length}, net=${netImages.size})`);

    // Chụp screenshot để debug khi không lấy được nội dung
    if (!text && imageUrls.length === 0) {
      const screenshotPath = path.resolve(__dirname, '../../logs', `scrape-empty-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      logger.warn(`${tag} WARN: kết quả rỗng (articleCount=${articleCount}) — screenshot: ${screenshotPath}`);
    }

    return { success: true, text, imageUrls };
  } catch (e) {
    logger.error(`${tag} FAIL: ${e.message}`);
    return { success: false, error: e.message, text: '', imageUrls: [] };
  } finally {
    const _ctx = browsers[activeProfile];
    browsers[activeProfile] = null;
    await Promise.race([_ctx?.close(), new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  }
}

// ===== SEEDING: Đăng bình luận xuống bài đã đăng =====

async function attachCommentImages(page, imagePaths) {
  let uploaded = false;

  const cameraSelectors = [
    'div[aria-label*="ảnh"]',
    'div[aria-label*="Ảnh"]',
    'div[aria-label*="hoto"]',
    'div[aria-label*="camera"]',
    'div[aria-label*="Camera"]',
    'div[aria-label*="Đính kèm ảnh"]',
    'div[aria-label*="Attach photo"]',
  ];

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      (async () => {
        await randomDelay(300, 600);
        for (const sel of cameraSelectors) {
          const btns = await page.$$(sel);
          for (const btn of btns) {
            const isVisible = await btn.isVisible().catch(() => false);
            if (isVisible) { await btn.click({ force: true }); return; }
          }
        }
        // Fallback: tìm trong vùng comment
        const btns = await page.$$('div[role="button"]');
        for (const btn of btns) {
          const label = (await btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('nh') || label.includes('hoto') || label.includes('camera')) {
            const isVisible = await btn.isVisible().catch(() => false);
            if (isVisible) { await btn.click({ force: true }); return; }
          }
        }
      })(),
    ]);
    await fileChooser.setFiles(imagePaths);
    uploaded = true;
    logger.info(`attachCommentImages: filechooser OK (${imagePaths.length} ảnh)`);
  } catch (e) {
    logger.warn(`attachCommentImages filechooser fail: ${e.message}`);
  }

  if (!uploaded) {
    const inputs = await page.$$('input[type="file"]');
    for (const input of inputs) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        logger.info('attachCommentImages: direct input OK');
        break;
      } catch { continue; }
    }
  }

  return uploaded;
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

    // Upload ảnh nếu có
    if (imagePaths && imagePaths.length > 0) {
      const imgOk = await attachCommentImages(page, imagePaths);
      if (!imgOk) logger.warn(`${tag} Không upload được ảnh comment`);
      else await randomDelay(1000, 2000);
    }

    // Nhập nội dung
    if (message) {
      await pasteText(page, message);
      await randomDelay(400, 800);
    }

    // Submit: Ctrl+Enter là an toàn nhất trên FB comment
    await page.keyboard.press('Control+Enter');
    await randomDelay(2000, 3000);

    // Verify: nếu ô comment vẫn có nội dung → thử Enter thường
    const remaining = await commentBox.textContent().catch(() => '');
    if (remaining && remaining.trim()) {
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
