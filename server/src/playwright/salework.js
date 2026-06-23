const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getZaloProxyForAccount } = require('../utils/proxy');
const { randomDelay, humanType, sleep } = require('../utils/delay');
const { getProfileDeviceFingerprint } = require('../utils/device-fingerprint');
const { checkProxy } = require('../utils/proxy-health');

const DEBUG_SCREENSHOT_DIR = '/tmp/salework-debug';

// URL trang quản lý Zalo. Trước đây dùng Salework (zalo.salework.net), nay
// chuyển sang Zalo Basso (self-hosted, giao diện tương tự Salework). Vì giao
// diện tương tự nên GIỮ NGUYÊN toàn bộ logic chọn account / tìm nhóm / gửi tin,
// chỉ đổi domain. Gom URL ở một chỗ để sau này đổi domain chỉ sửa tại đây.
//   - ZALO_LOGIN_URL: trang đăng nhập (mở khi setup tài khoản mới)
//   - ZALO_CHAT_URL : trang chat (mở mỗi lần đăng bài)
const ZALO_LOGIN_URL = 'https://zalo.basso.vn/';
const ZALO_CHAT_URL = 'https://zalo.basso.vn/chat';

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
    await Promise.race([
      page.screenshot({ path: filePath, fullPage: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 5000)),
    ]);
    logger.info(`[salework] screenshot: ${filePath}`);
  } catch {}
}

// ============================================================================
// CHỌN TÀI KHOẢN ZALO trên zalo.basso.vn (giao diện Vuetify)
// ----------------------------------------------------------------------------
// KHÁC HẲN Salework (vốn dùng Element UI tag-select). Ở basso, nút "Tất cả Zalo"
// (span.acc-btn-text) mở ra một dropdown .v-list; mỗi tài khoản là 1 .v-list-item:
//     .v-list-item
//        .v-list-item-title                     → tên tài khoản
//        .v-list-item__append > span.acc-tick   → ô tick; THÊM class "on" khi ĐANG chọn
// Dòng đầu "Tất cả Zalo" KHÔNG có .acc-tick (chọn = hiện hội thoại của mọi tài khoản).
//
// Đây là multi-select (lọc hội thoại theo tài khoản). Để đăng đúng 1 tài khoản:
//   1. Mở dropdown.
//   2. Bỏ tick mọi tài khoản đang "on" KHÁC tài khoản cần đăng (profile nhớ lần trước).
//   3. Tick đúng tài khoản cần đăng.
//   4. READ-BACK: CHỈ tài khoản đó "on", không dòng nào khác → sai thì HUỶ (return
//      false) để KHÔNG đăng nhầm tài khoản.
// ============================================================================

// Chuẩn hoá tên để so khớp: NFC, gộp khoảng trắng (tên "Basso  Order Hàng Mỹ" có
// 2 dấu cách trong DOM), bỏ đầu/cuối, lowercase.
const ACC_NORM = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// Dropdown danh sách tài khoản đang hiển thị chưa? (chỉ v-list của dropdown này
// mới có .acc-tick — danh sách hội thoại không có → không bị nhầm).
async function accountListVisible(page) {
  return page.locator('.v-list:has(.acc-tick)').first().isVisible().catch(() => false);
}

// Mở dropdown chọn tài khoản. Nút mở hiển thị nhãn span.acc-btn-text ("Tất cả
// Zalo" hoặc tên tài khoản đã chọn lần trước). Click chính nó / ancestor; tự kiểm
// tra list đã hiện chưa, thử vài selector phòng khi DOM đổi. False nếu không mở được.
async function openAccountDropdown(page) {
  if (await accountListVisible(page)) return true;
  const tries = ['.acc-btn-text', '.acc-btn', '[class*="acc-btn"]', '[aria-haspopup="menu"]', '[aria-haspopup]'];
  for (const sel of tries) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    try { await loc.click({ timeout: 3000, force: true }); } catch { continue; }
    await sleep(800);
    if (await accountListVisible(page)) {
      logger.info(`[basso] Mở dropdown tài khoản bằng: ${sel}`);
      return true;
    }
  }
  return accountListVisible(page);
}

// Đọc trạng thái các dòng tài khoản trong dropdown, đồng thời ĐÁNH SỐ mỗi dòng
// (data-xeko-idx) để click lại bằng locator. Bỏ qua dòng "Tất cả Zalo" (không có
// .acc-tick). PHẢI đọc lại trước mỗi lần click vì Vue re-render xoá data-xeko-idx.
async function readAccountRows(page) {
  return page.evaluate(() => {
    const norm = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const rows = [];
    Array.from(document.querySelectorAll('.v-list .v-list-item')).forEach((el, i) => {
      el.setAttribute('data-xeko-idx', String(i));
      const tick = el.querySelector('.acc-tick');
      if (!tick) return;                       // dòng "Tất cả Zalo" — bỏ qua
      const titleEl = el.querySelector('.v-list-item-title');
      rows.push({
        idx: i,
        title: titleEl ? norm(titleEl.textContent) : '',
        on: tick.classList.contains('on'),
      });
    });
    return rows;
  });
}

async function clickAccountRowByIdx(page, idx) {
  const loc = page.locator(`.v-list-item[data-xeko-idx="${idx}"]`).first();
  try { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
  await loc.click({ timeout: 4000 });
  await sleep(500);
}

async function selectZaloAccount(page, accountName) {
  logger.info(`[basso] Chọn tài khoản: ${accountName}`);
  const want = ACC_NORM(accountName);

  if (!(await openAccountDropdown(page))) {
    logger.error('[basso] Không mở được dropdown chọn tài khoản');
    return false;
  }
  await sleep(500);

  // Hội tụ về trạng thái mong muốn: mỗi vòng sửa ĐÚNG 1 việc rồi đọc lại (vì click
  // làm Vue re-render → phải re-mark data-xeko-idx). Tối đa 8 vòng cho an toàn.
  for (let pass = 0; pass < 8; pass++) {
    const rows = await readAccountRows(page);
    const target = rows.find(r => ACC_NORM(r.title) === want);
    if (!target) {
      // Có thể list chưa render xong ở vòng đầu — chờ rồi thử lại vài lần.
      if (pass < 2) { await sleep(700); continue; }
      logger.error(`[basso] Không thấy tài khoản "${accountName}" trong danh sách. Có: ${JSON.stringify(rows.map(r => r.title))}`);
      return false;
    }
    const wrongOn = rows.find(r => r.on && r.idx !== target.idx);
    if (wrongOn) {                               // còn tài khoản KHÁC đang chọn → bỏ tick
      logger.info(`[basso] Bỏ tick tài khoản thừa: "${wrongOn.title}"`);
      await clickAccountRowByIdx(page, wrongOn.idx);
      continue;
    }
    if (!target.on) {                            // tài khoản cần đăng chưa tick → tick
      logger.info(`[basso] Tick tài khoản: "${target.title}"`);
      await clickAccountRowByIdx(page, target.idx);
      continue;
    }
    break;                                       // target "on" + không thừa → xong
  }

  // READ-BACK xác minh: CHỈ đúng 1 tài khoản "on" và đó là tài khoản cần đăng.
  const onRows = (await readAccountRows(page)).filter(r => r.on).map(r => r.title);
  const ok = onRows.length === 1 && ACC_NORM(onRows[0]) === want;

  // Đóng dropdown để bước tìm nhóm đọc đúng danh sách hội thoại đã lọc.
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('body', { position: { x: 700, y: 400 }, force: true }).catch(() => {});
  await sleep(800);

  if (ok) {
    logger.info(`[basso] ✓ Xác minh đã chọn đúng tài khoản: ${accountName}`);
    return true;
  }
  logger.error(`[basso] ✗ Không chọn đúng tài khoản "${accountName}" — đang "on": ${JSON.stringify(onRows)}`);
  return false;
}

async function searchAndClickGroup(page, groupName) {
  logger.info(`[salework] Tìm nhóm: ${groupName}`);

  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    await sleep(2500);
  }

  await screenshot(page, '03-search-filled');

  // Dùng page.evaluate để lấy tọa độ (1 round-trip), rồi page.mouse.click()
  // để fire đầy đủ pointer events mà Vue.js yêu cầu.
  const rect = await page.evaluate((name) => {
    const norm = s => s.normalize('NFC').trim();
    const normName = norm(name);

    // Contact row trong Salework luôn có kích thước hợp lý: rộng >150px, cao 30-200px
    const isRow = (r) => r.width > 150 && r.height > 30 && r.height < 200
                      && r.top >= 0 && r.top < window.innerHeight;

    // Pass 1: selector có class liên quan đến conversation/contact/item
    const pass1 = document.querySelectorAll(
      '[class*="conversation"], [class*="contact"], [class*="chat"], ' +
      '[class*="list-item"], [class*="message-item"], li, a[href]'
    );
    for (const el of pass1) {
      if (!norm(el.textContent || '').includes(normName)) continue;
      const r = el.getBoundingClientRect();
      if (isRow(r)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: 'pass1' };
    }

    // Pass 2: bất kỳ div/li nào có kích thước trông như một hàng danh sách
    const pass2 = document.querySelectorAll('div, li');
    for (const el of pass2) {
      if (!norm(el.textContent || '').includes(normName)) continue;
      const r = el.getBoundingClientRect();
      if (isRow(r)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: 'pass2' };
    }
    return null;
  }, groupName);

  await screenshot(page, '03b-before-click');

  if (rect) {
    logger.info(`[salework] [${rect.src}] Click (${Math.round(rect.x)}, ${Math.round(rect.y)}) cho: ${groupName}`);
    await page.mouse.click(rect.x, rect.y);
    await sleep(1000);
    await screenshot(page, '03c-after-click');
    await sleep(1500);
    return true;
  }

  logger.error(`[salework] Không tìm thấy element cho: ${groupName}`);
  return false;
}

async function sendMessage(page, message, imagePaths = []) {
  logger.info(`[basso] Gửi: "${message?.substring(0, 30)}" + ${imagePaths.length} ảnh`);

  // ----- 1. NHẬP NỘI DUNG vào textarea.msg-textarea -----
  // basso dùng <textarea class="msg-textarea"> bind Vue v-model. Dùng fill() để
  // set value + tự bắn event 'input' (Vue mới cập nhật model & BẬT nút Gửi vốn
  // disabled khi rỗng). KHÔNG gõ Enter — Enter trong ô này có thể chỉ xuống dòng,
  // không gửi; gửi là do nút .send-btn. Dispatch thêm input/change cho chắc.
  if (message) {
    const ta = page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"], textarea:visible').first();
    try {
      await ta.click({ timeout: 5000 });
      await ta.fill(message);
      await ta.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, message);
      logger.info('[basso] Đã nhập nội dung tin nhắn');
    } catch (e) {
      logger.error(`[basso] Không nhập được nội dung: ${e.message}`);
    }
    await randomDelay(300, 700);
  }

  // ----- 2. ĐÍNH ẢNH -----
  // CÁCH CHÍNH: DÁN ảnh thẳng vào ô soạn tin (basso hỗ trợ paste ảnh từ clipboard).
  // Dựng File từ dữ liệu ảnh rồi dispatch sự kiện 'paste' kèm DataTransfer (phải
  // gán clipboardData qua defineProperty vì constructor ClipboardEvent bỏ qua nó).
  // DỰ PHÒNG: bấm nút .ic-violet → menu → mục "Hình ảnh" → hộp chọn file.
  if (imagePaths.length > 0) {
    let uploaded = false;

    // 2a. DÁN ảnh vào textarea.
    try {
      const files = imagePaths.map(p => {
        const ext = path.extname(p).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
                   : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return { name: path.basename(p), type, b64: fs.readFileSync(p).toString('base64') };
      });
      await page.locator('textarea.msg-textarea, textarea:visible').first().click({ timeout: 5000 }).catch(() => {});
      uploaded = await page.evaluate((files) => {
        const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea') || document.activeElement;
        if (!ta) return false;
        const dt = new DataTransfer();
        for (const f of files) {
          const bin = atob(f.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          dt.items.add(new File([arr], f.name, { type: f.type }));
        }
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(evt, 'clipboardData', { value: dt });
        ta.focus();
        ta.dispatchEvent(evt);
        return true;
      }, files);
      if (uploaded) logger.info(`[basso] Đã dán ${imagePaths.length} ảnh vào ô soạn tin`);
      await sleep(2000);
    } catch (e) {
      logger.warn(`[basso] Dán ảnh lỗi: ${e.message} — thử qua menu nút .ic-violet`);
      uploaded = false;
    }

    // 2b (dự phòng). Có sẵn input[type=file] → set; rồi bấm .ic-violet → menu "Hình ảnh" → filechooser.
    if (!uploaded) {
      const setOnAnyInput = async () => {
        for (const input of await page.$$('input[type="file"]')) {
          try { await input.setInputFiles(imagePaths); return true; } catch {}
        }
        return false;
      };
      uploaded = await setOnAnyInput();
      if (!uploaded) {
        try {
          const attach = page.locator('button.ic-violet').first();
          const menuId = await attach.getAttribute('aria-controls').catch(() => null);
          let [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
            attach.click({ timeout: 5000 }).catch(() => {}),
          ]);
          if (!chooser) {
            await sleep(600);
            const scope = menuId ? page.locator(`#${menuId}`) : page.locator('.v-overlay__content').last();
            const imgItem = scope.locator('.v-list-item, [role="menuitem"]')
              .filter({ hasText: /hình ảnh|ảnh|hình|image|photo/i }).first();
            if (await imgItem.count().catch(() => 0)) {
              [chooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null),
                imgItem.click({ timeout: 4000 }).catch(() => {}),
              ]);
            }
          }
          if (chooser) { await chooser.setFiles(imagePaths); uploaded = true; }
          else { await sleep(800); uploaded = await setOnAnyInput(); }
        } catch (e) {
          logger.error(`[basso] Đính ảnh (menu) lỗi: ${e.message}`);
        }
      }
    }

    if (uploaded) logger.info(`[basso] Đã đính ${imagePaths.length} ảnh`);
    else logger.warn('[basso] CHƯA đính được ảnh — kiểm tra lại cách dán / menu nút .ic-violet');
    await sleep(2000);
    await screenshot(page, '05-after-upload');
  }

  // ----- 3. BẤM NÚT GỬI (.send-btn) — Playwright tự chờ tới khi hết disabled -----
  await randomDelay(500, 1000);
  try {
    const send = page.locator('button.send-btn').first();
    await send.click({ timeout: 8000 });
    logger.info('[basso] Click nút Gửi (.send-btn)');
    await randomDelay(1800, 2600);
    return true;
  } catch (e) {
    logger.warn(`[basso] Click .send-btn lỗi/vẫn disabled: ${e.message}`);
  }

  // Fallback: nút Gửi theo text (chỉ bấm khi đã enabled).
  for (const sel of ['button:has-text("Gửi")', 'button:has-text("Send")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        logger.info(`[basso] Click nút Gửi (${sel})`);
        await randomDelay(1800, 2600);
        return true;
      }
    } catch {}
  }

  logger.error('[basso] Không bấm được nút Gửi (nội dung trống → nút vẫn disabled?)');
  return false;
}

const _accountLocks = new Map();

async function _withAccountLock(key, fn) {
  const prev = _accountLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _accountLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    _accountLocks.delete(key);
    release();
  }
}

async function postToZaloGroup({ zaloAccountName, accountKey, groupName, message, imagePaths }) {
  return _withAccountLock(accountKey || zaloAccountName, () =>
    _postToZaloGroupImpl({ zaloAccountName, accountKey, groupName, message, imagePaths })
  );
}

async function _postToZaloGroupImpl({ zaloAccountName, accountKey, groupName, message, imagePaths }) {
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

  // Dọn dẹp browser CHẠY NỀN (fire-and-forget) — không bao giờ chặn việc trả
  // kết quả. Trước đây finally await page.close()/browser.close() có thể treo
  // (dù có Promise.race) → promise postToZaloGroup không resolve → local-server
  // không set job 'done' → cloud poll mãi 'processing' → frontend kẹt "Đang đăng".
  // Tách cleanup ra để lỗi đóng browser không ảnh hưởng tới việc báo kết quả.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    Promise.race([page.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {})
      .then(() => Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {}))
      .then(() => logger.info('[salework] Đã đóng browser'))
      .catch(() => {});
  };

  try {
    logger.info(`[salework] === account=${zaloAccountName}, group=${groupName} ===`);

    await page.goto(ZALO_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    await screenshot(page, '01-loaded');

    const accountOk = await selectZaloAccount(page, zaloAccountName);
    await screenshot(page, '02-account-selected');

    // HUỶ đăng nếu không chọn được đúng tài khoản — thà báo lỗi rõ ràng còn hơn
    // âm thầm đăng nhầm bằng tài khoản mặc định ("Tất cả tài khoản" → Basso…).
    if (!accountOk) {
      throw new Error(`Không chọn được tài khoản "${zaloAccountName}" trên Salework (ô vẫn ở "Tất cả tài khoản" hoặc chọn nhầm). Đã huỷ đăng để tránh đăng nhầm tài khoản — mở lại Salework kiểm tra danh sách tài khoản đã kết nối.`);
    }

    if (!(await searchAndClickGroup(page, groupName))) {
      throw new Error(`Không tìm thấy nhóm: ${groupName}`);
    }
    await screenshot(page, '04-group-selected');

    await sendMessage(page, message, imagePaths);

    logger.info(`[salework] Đã đăng lên "${groupName}" qua "${zaloAccountName}"`);
    cleanup(); // chạy nền, không await — trả kết quả ngay
    return { success: true };
  } catch (e) {
    logger.error(`[salework] Lỗi: ${e.message}`);
    try { await screenshot(page, '99-error'); } catch {}
    cleanup(); // chạy nền, không await
    return { success: false, error: e.message };
  }
}

module.exports = { postToZaloGroup, getSaleworkProfile, ZALO_LOGIN_URL, ZALO_CHAT_URL };
