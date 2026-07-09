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

// Phát hiện trang ĐĂNG NHẬP của ZaloCRM (zalo.basso.vn/login). Khi session hết
// hạn, mở /chat sẽ bị đẩy về trang login — có ô nhập Mật khẩu + nút "Đăng nhập".
// Lúc này KHÔNG báo "không chọn được tài khoản" (gây hiểu nhầm) mà báo rõ cần
// admin đăng nhập lại tài khoản.
async function isOnLoginPage(page) {
  try {
    if (/\/login(\b|\/|$)/.test(page.url())) return true;
    return await page.evaluate(() => {
      const hasPassword = !!document.querySelector('input[type="password"]');
      const hasLoginBtn = Array.from(document.querySelectorAll('button'))
        .some(b => /đăng nhập/i.test(b.textContent || ''));
      return hasPassword && hasLoginBtn;
    });
  } catch {
    return false;
  }
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

// Chờ SPA chat dựng xong giao diện sau khi goto: nút chọn tài khoản HOẶC ô tìm
// kiếm hiện ra = trang chat đã render; ô mật khẩu hiện ra = bị đẩy về trang đăng
// nhập (để bước isOnLoginPage phía sau xử lý, không phải chờ vô ích hết timeout).
// Thay cho sleep cố định — proxy chậm thì chờ lâu hơn, nhanh thì đi tiếp ngay.
async function waitForChatReady(page, timeout = 20000) {
  try {
    await page.locator(
      '.acc-btn-text, .acc-btn, [class*="acc-btn"], ' +
      'input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"], ' +
      'input[type="password"]'
    ).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function searchAndClickGroup(page, groupName) {
  logger.info(`[salework] Tìm nhóm: ${groupName}`);

  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    // Chờ danh sách hội thoại lọc theo từ khoá tải xong (network rảnh) thay vì
    // sleep cứng — group tải chậm qua proxy yếu vẫn kịp hiện trước khi tìm hàng.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  await screenshot(page, '03-search-filled');

  // Dùng page.evaluate để lấy tọa độ (1 round-trip), rồi page.mouse.click()
  // để fire đầy đủ pointer events mà Vue.js yêu cầu.
  const findRect = () => page.evaluate((name) => {
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

  // Poll tối đa ~10s cho hàng nhóm xuất hiện: kết quả tìm kiếm có thể render
  // trễ (proxy/mạng chậm) — thay vì đọc DOM đúng 1 lần rồi báo "không tìm thấy"
  // oan, thử lại từng nhịp tới khi hàng hiện rồi mới click.
  let rect = null;
  for (let i = 0; i < 10 && !rect; i++) {
    rect = await findRect();
    if (!rect) await sleep(1000);
  }

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

// Bấm nút Gửi (.send-btn) — Playwright tự chờ tới khi hết disabled (nút bật khi
// ô soạn có nội dung/ảnh). Fallback nút theo chữ "Gửi". Trả false nếu không bấm được.
async function clickSend(page) {
  await randomDelay(500, 1000);
  try {
    await page.locator('button.send-btn').first().click({ timeout: 8000 });
    logger.info('[basso] Click nút Gửi (.send-btn)');
    await randomDelay(1500, 2400);
    return true;
  } catch (e) {
    logger.warn(`[basso] Click .send-btn lỗi/vẫn disabled: ${e.message}`);
  }
  for (const sel of ['button:has-text("Gửi")', 'button:has-text("Send")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        logger.info(`[basso] Click nút Gửi (${sel})`);
        await randomDelay(1500, 2400);
        return true;
      }
    } catch {}
  }
  return false;
}

// Chờ Ô SOẠN TIN (textarea) hiện = hội thoại group đã mở & trang chat đã render.
// Trả false (không throw) để caller tự quyết định reload/retry. Trang basso load
// chậm qua proxy yếu thì textarea chưa kịp render — đây là tín hiệu tin cậy nhất
// (tin cậy hơn nút Gửi vốn hay bật sẵn) để biết có chỗ đính ảnh/nhập text chưa.
async function ensureComposerReady(page, timeout = 15000) {
  try {
    await page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"]')
      .first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

// Đính ảnh vào ô soạn tin. CÁCH CHÍNH (TRUSTED): đặt file thẳng vào input[type=file]
// sẵn có / nút .ic-violet → menu "Hình ảnh" → filechooser — ổn định khi đăng lặp
// nhiều group. DỰ PHÒNG: DÁN (paste) ảnh từ clipboard giả lập (untrusted, Zalo hay
// bỏ qua). Thử tối đa 2 vòng + xác minh ảnh đã vào thật. Trả true nếu đính được.
async function attachImages(page, imagePaths) {
  // XÁC MINH ảnh đã thực sự đính vào Ô SOẠN — KHÔNG đếm ảnh trong lịch sử chat.
  // Cách cũ (nút .send-btn bật HOẶC có 1 ảnh bất kỳ trong document) dễ DƯƠNG TÍNH
  // GIẢ: nút Gửi hay bật sẵn, còn '[class*=thumb] img'/'.v-image__image' khớp luôn
  // ảnh trong khung chat của group → tưởng đã đính nên gửi mỗi text (đúng hiện
  // tượng "rớt hình"). Cách mới: chỉ đếm ảnh BÊN TRONG khu soạn (tổ tiên gần nhất
  // của textarea mà cũng chứa nút Gửi) và đòi SỐ ẢNH TĂNG so với lúc chưa đính.

  // Đo 2 tín hiệu trong page context (KHÔNG dùng eval/new Function — trang có thể
  // chặn bởi CSP — nên inline cùng một thân đếm ở cả baseline lẫn waitForFunction):
  //  - local: số ảnh render bằng blob:/data: URL = file CỤC BỘ vừa đính. Ảnh trong
  //    lịch sử chat luôn là URL http(s) từ CDN → KHÔNG khớp. Độc lập vị trí preview.
  //  - scoped: số ảnh hiển thị TRONG khu soạn (tổ tiên gần nhất của textarea mà
  //    cũng chứa nút Gửi) — phòng khi trang dùng URL http cho preview tại chỗ.
  // Cả 2 đều so với baseline trước khi đính nên miễn nhiễm ảnh lịch sử chat.
  const countImages = () => page.evaluate(() => {
    const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 12 && r.height > 12; };
    let local = 0;
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if ((src.startsWith('blob:') || src.startsWith('data:')) && visible(img)) local++;
    }
    let scoped = 0;
    if (ta) {
      let root = ta;
      for (let i = 0; i < 8 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelector('button.send-btn')) break;
      }
      for (const el of root.querySelectorAll('img, .v-image__image, [class*="preview"], [class*="thumb"]')) {
        if (el !== ta && visible(el)) scoped++;
      }
    }
    return { local, scoped };
  });

  // Baseline (icon/nút & ảnh lịch sử cố định). SỐ ẢNH CẦN đính = imagePaths.length.
  // "Đính đủ" = số ảnh MỚI (local blob/data HOẶC trong khu soạn) TĂNG >= số cần —
  // KHÔNG chỉ ">=1" như trước (đính 2 ảnh mà chỉ 1 vào vẫn tưởng xong → rớt hình).
  // Upload nhiều ảnh chậm hơn → chờ tối đa 20s.
  const expected = imagePaths.length;
  const baseline = await countImages().catch(() => ({ local: 0, scoped: 0 }));
  const imageAttached = async (need, timeout = 20000) => {
    try {
      await page.waitForFunction(({ base, need }) => {
        const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 12 && r.height > 12; };
        let local = 0;
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || '';
          if ((src.startsWith('blob:') || src.startsWith('data:')) && visible(img)) local++;
        }
        let scoped = 0;
        if (ta) {
          let root = ta;
          for (let i = 0; i < 8 && root.parentElement; i++) {
            root = root.parentElement;
            if (root.querySelector('button.send-btn')) break;
          }
          for (const el of root.querySelectorAll('img, .v-image__image, [class*="preview"], [class*="thumb"]')) {
            if (el !== ta && visible(el)) scoped++;
          }
        }
        return (local - base.local) >= need || (scoped - base.scoped) >= need;
      }, { base: baseline, need }, { timeout });
      return true;
    } catch {
      return false;
    }
  };

  // CÁCH TRUSTED: input[type=file] sẵn có; rồi .ic-violet → menu "Hình ảnh" → filechooser.
  const viaFileInput = async () => {
    for (const input of await page.$$('input[type="file"]')) {
      try {
        await input.setInputFiles(imagePaths);
        // Input "mù" có thể là ô upload khác (avatar…). Có ÍT NHẤT 1 ảnh mới trong
        // 5s = ĐÚNG input khu soạn → chốt input này rồi đòi ĐỦ số ảnh (20s, upload
        // nhiều ảnh chậm); không ảnh nào vào thì thử input/menu khác (tránh dán đè).
        if (await imageAttached(1, 5000)) return await imageAttached(expected, 20000);
      } catch {}
    }
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
      if (chooser) { await chooser.setFiles(imagePaths); return await imageAttached(expected, 20000); }
    } catch (e) {
      logger.error(`[basso] Đính ảnh (menu) lỗi: ${e.message}`);
    }
    return false;
  };

  // DỰ PHÒNG: DÁN ảnh vào textarea — dựng File rồi dispatch 'paste' kèm DataTransfer
  // (gán clipboardData qua defineProperty vì constructor ClipboardEvent bỏ qua nó).
  // Sự kiện 'paste' tổng hợp là untrusted nên app CÓ THỂ bỏ qua → PHẢI xác minh.
  const viaPaste = async () => {
    try {
      const files = imagePaths.map(p => {
        const ext = path.extname(p).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
                   : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return { name: path.basename(p), type, b64: fs.readFileSync(p).toString('base64') };
      });
      await page.locator('textarea.msg-textarea, textarea:visible').first().click({ timeout: 5000 }).catch(() => {});
      const dispatched = await page.evaluate((files) => {
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
      if (dispatched) return await imageAttached(expected, 20000);
    } catch (e) {
      logger.warn(`[basso] Dán ảnh lỗi: ${e.message}`);
    }
    return false;
  };

  // Thử tối đa 2 vòng: mỗi vòng ưu tiên cách TRUSTED (file input/menu), rồi tới paste.
  let uploaded = false;
  for (let attempt = 1; attempt <= 2 && !uploaded; attempt++) {
    uploaded = await viaFileInput();
    if (!uploaded) uploaded = await viaPaste();
    if (!uploaded && attempt < 2) {
      logger.warn(`[basso] Đính ảnh lần ${attempt} thất bại — thử lại...`);
      await sleep(1500);
    }
  }

  if (uploaded) {
    logger.info(`[basso] Đã đính đủ ${imagePaths.length} ảnh (đã xác minh đúng số lượng)`);
    // QUAN TRỌNG: preview ảnh hiện ra (blob/data) TRƯỚC khi basso upload xong ảnh
    // lên server của nó. Nếu bấm Gửi ngay thì tin gửi đi KHÔNG kèm ảnh (group rỗng)
    // nhưng salework vẫn tưởng thành công. Chờ network rảnh để upload hoàn tất.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  } else {
    logger.warn(`[basso] CHƯA đính đủ ${imagePaths.length} ảnh sau 2 lần thử — file input/menu/paste đều fail hoặc đính thiếu`);
  }

  // CHẨN ĐOÁN (1 dòng log): số ảnh blob/http + cấu trúc khu soạn — để biết ảnh có
  // vào thật không & sửa đúng DOM thay vì đoán. Xem trong log [basso][diag].
  try {
    const diag = await page.evaluate(() => {
      const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
      const out = { hasTextarea: !!ta, blobImgs: 0, httpImgs: 0, composerHtml: '' };
      for (const img of document.querySelectorAll('img')) {
        const s = img.currentSrc || img.src || '';
        if (s.startsWith('blob:') || s.startsWith('data:')) out.blobImgs++;
        else if (s.startsWith('http')) out.httpImgs++;
      }
      if (ta) {
        let root = ta;
        for (let i = 0; i < 8 && root.parentElement; i++) { root = root.parentElement; if (root.querySelector('button.send-btn')) break; }
        out.composerHtml = (root.outerHTML || '').replace(/\s+/g, ' ').slice(0, 1800);
      }
      return out;
    });
    logger.info(`[basso][diag] uploaded=${uploaded} blobImgs=${diag.blobImgs} httpImgs=${diag.httpImgs} baseline=${JSON.stringify(baseline)} composer="${diag.composerHtml}"`);
  } catch (e) { logger.warn(`[basso][diag] lỗi: ${e.message}`); }

  await sleep(1500);
  await screenshot(page, '05-after-upload');
  return uploaded;
}

async function sendMessage(page, message, imagePaths = []) {
  logger.info(`[basso] Gửi: "${message?.substring(0, 30)}" + ${imagePaths.length} ảnh`);
  let sentAny = false;

  // KIỂM TRA FILE ẢNH CÒN TỒN TẠI (bắt lỗi "đăng nhiều kênh 1 phiên bị mất hình"):
  // khi 1 lượt đăng đẩy cùng bộ ảnh tới nhiều group/kênh, file tạm có thể bị dọn
  // (cleanup) trước khi tới lượt group sau → imagePaths trỏ tới file KHÔNG còn tồn
  // tại → đính 0 ảnh mà vẫn gửi text ("chỉ gửi text thôi"). Kiểm ngay & báo lỗi rõ
  // để đăng lại, thay vì âm thầm rớt hình.
  if (imagePaths.length > 0) {
    const existing = imagePaths.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
    const sizes = existing.map(p => { try { return `${path.basename(p)}(${fs.statSync(p).size}B)`; } catch { return `${path.basename(p)}(?)`; } });
    logger.info(`[basso][files] nhận ${imagePaths.length} ảnh, tồn tại ${existing.length}/${imagePaths.length}: ${sizes.join(', ')}`);
    if (existing.length < imagePaths.length) {
      throw new Error(`Thiếu file ảnh khi gửi (${existing.length}/${imagePaths.length} còn tồn tại) — ảnh có thể đã bị dọn do đăng nhiều kênh cùng lúc. Đã HUỶ để không gửi thiếu hình. Thử đăng lại.`);
    }
  }

  // Chờ ô soạn tin sẵn sàng — group sau có thể load chậm hơn group đầu, nếu đính
  // ảnh trước khi textarea xuất hiện thì dễ rớt hình (chỉ còn text).
  await page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"], textarea:visible')
    .first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  // THỨ TỰ (theo yêu cầu): GỬI ẢNH TRƯỚC thành 1 tin riêng, RỒI GỬI TEXT thành tin riêng.

  // ----- 1. ẢNH: đính rồi gửi -----
  if (imagePaths.length > 0) {
    const uploaded = await attachImages(page, imagePaths);
    // KHÔNG đăng thiếu hình: có ảnh mà đính KHÔNG ĐỦ (thiếu/không vào được) thì BÁO
    // LỖI để đăng lại, thay vì âm thầm chỉ gửi text (chính là "rớt hình" ở group sau).
    if (!uploaded) {
      throw new Error(`Không đính đủ ${imagePaths.length} ảnh (file input/menu/paste đều fail hoặc đính thiếu sau 2 lần thử) — đã huỷ để tránh đăng thiếu hình. Thử đăng lại.`);
    }
    // Chụp trạng thái ảnh TRONG HỘI THOẠI ngay TRƯỚC khi bấm Gửi (lúc này ảnh mới
    // chỉ là preview blob trong ô soạn, CHƯA có bong bóng ảnh trong thread). Dùng làm
    // mốc để xác minh ảnh THẬT SỰ vào hội thoại sau khi gửi.
    const before = await _imageThreadState(page).catch(() => ({ http: 0, threadBlob: 0, composerBlob: 0 }));
    logger.info(`[basso][verify] trước khi gửi ảnh: ${JSON.stringify(before)}`);
    if (await clickSend(page)) { sentAny = true; logger.info('[basso] Đã bấm gửi tin ảnh'); }
    else throw new Error('Đính được ảnh nhưng không bấm gửi được tin ảnh.');
    // QUAN TRỌNG (lỗi Zalo-specific): bấm Gửi xong, basso CÒN đang upload ảnh lên
    // Zalo (chậm hơn text rất nhiều). Trước đây chỉ sleep 1500ms rồi caller đóng
    // browser ngay → upload bị cắt giữa chừng → group KHÔNG nhận ảnh dù đã báo gửi.
    // SIẾT XÁC MINH: chỉ dựa "preview rời ô soạn" là CHƯA đủ — basso có thể xoá
    // preview nhưng upload FAIL (group rỗng), rồi ta vẫn gửi text → "chỉ gửi text".
    // waitImageSent giờ đòi ảnh THẬT SỰ xuất hiện trong hội thoại (số ảnh thread
    // tăng ≥ số ảnh cần) mới coi là gửi được; không thì DỪNG, KHÔNG gửi text.
    const imageSent = await waitImageSent(page, imagePaths.length, before);
    if (!imageSent) {
      throw new Error('Đã bấm Gửi nhưng ảnh KHÔNG xuất hiện trong hội thoại sau khi chờ (preview rời ô soạn nhưng bong bóng ảnh không lên) — đã HUỶ, KHÔNG gửi text để tránh đăng thiếu hình. Thử đăng lại.');
    }
  }

  // ----- 2. TEXT: nhập vào textarea.msg-textarea rồi gửi -----
  // textarea bind Vue v-model → fill() set value + bắn 'input' để BẬT nút Gửi.
  // KHÔNG gõ Enter (Enter chỉ xuống dòng). Dispatch thêm input/change cho chắc.
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
    if (await clickSend(page)) { sentAny = true; logger.info('[basso] Đã gửi tin text'); }
  }

  if (!sentAny) {
    throw new Error('Không gửi được tin nào (ảnh & text đều thất bại)');
  }

  // Lắng đọng lần cuối TRƯỚC khi caller đóng browser: tin cuối (ảnh/text) có thể
  // vẫn đang lên server. Đóng browser sớm = mất tin. Chờ network rảnh + 1 nhịp.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(2000);
  return true;
}

// Đếm ảnh liên quan tới việc gửi, tách theo VỊ TRÍ để phân biệt "đang soạn" và "đã
// vào hội thoại":
//   - composerBlob: ảnh blob/data hiển thị TRONG ô soạn = preview ảnh CHƯA gửi.
//   - threadBlob  : ảnh blob/data hiển thị NGOÀI ô soạn = bong bóng ảnh vừa gửi
//     (basso hiển thị lạc quan bằng chính blob trước khi swap sang URL CDN).
//   - http        : ảnh URL http(s) hiển thị (lịch sử chat + ảnh vừa gửi sau khi lên CDN).
// Khu soạn = tổ tiên gần nhất của textarea mà cũng chứa nút Gửi (giống attachImages).
async function _imageThreadState(page) {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
    let root = ta;
    if (ta) {
      for (let i = 0; i < 8 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelector('button.send-btn')) break;
      }
    }
    const inComposer = (el) => !!(root && root.contains(el));
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 24 && r.height > 24; };
    let http = 0, threadBlob = 0, composerBlob = 0;
    for (const img of document.querySelectorAll('img')) {
      if (!visible(img)) continue;
      const s = img.currentSrc || img.src || '';
      if (s.startsWith('http')) http++;
      else if (s.startsWith('blob:') || s.startsWith('data:')) {
        if (inComposer(img)) composerBlob++; else threadBlob++;
      }
    }
    return { http, threadBlob, composerBlob };
  });
}

// Chờ + XÁC MINH ảnh ĐÃ VÀO HỘI THOẠI thật sự, không chỉ "đã bấm Gửi" hay "preview
// rời ô soạn". Hai bước:
//   (1) preview blob rời ô soạn (basso đã nhận lệnh gửi & xoá preview).
//   (2) SIẾT: bong bóng ảnh THẬT SỰ xuất hiện trong hội thoại — số ảnh trong thread
//       tăng ≥ số ảnh cần (http tăng khi lên CDN, HOẶC có ảnh blob mới NGOÀI ô soạn).
// Bước (2) là điểm mới: trước đây preview rời ô soạn là coi như xong, nhưng basso có
// thể xoá preview rồi upload FAIL → group rỗng, ta vẫn gửi text ("chỉ gửi text thôi").
// Trả về:
//   - true  = ảnh đã lên hội thoại → được phép gửi text.
//   - false = hết giờ chờ mà ảnh KHÔNG lên hội thoại → caller DỪNG, không gửi text.
async function waitImageSent(page, expected = 1, before = null) {
  const base = before || { http: 0, threadBlob: 0, composerBlob: 0 };
  const need = Math.max(1, expected);

  // (1) Preview rời ô soạn (không chặn kết quả, chỉ để log & chờ nhẹ).
  let previewLeft = true;
  try {
    await page.waitForFunction(() => {
      const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
      if (!ta) return true;
      let root = ta;
      for (let i = 0; i < 8 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelector('button.send-btn')) break;
      }
      for (const img of root.querySelectorAll('img')) {
        const s = img.currentSrc || img.src || '';
        if (s.startsWith('blob:') || s.startsWith('data:')) {
          const r = img.getBoundingClientRect();
          if (r.width > 12 && r.height > 12) return false;
        }
      }
      return true;
    }, { timeout: 30000 });
  } catch {
    previewLeft = false;
    logger.warn('[basso] waitImageSent: preview ảnh CHƯA rời ô soạn sau 30s');
  }

  // (2) Ảnh THẬT SỰ vào hội thoại: số ảnh thread tăng ≥ need. Upload ảnh lên Zalo
  // chậm → chờ tới 45s. Đây là điều kiện QUYẾT ĐỊNH có được gửi text hay không.
  let inThread = false;
  try {
    await page.waitForFunction(({ base, need }) => {
      const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
      let root = ta;
      if (ta) {
        for (let i = 0; i < 8 && root.parentElement; i++) {
          root = root.parentElement;
          if (root.querySelector('button.send-btn')) break;
        }
      }
      const inComposer = (el) => !!(root && root.contains(el));
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 24 && r.height > 24; };
      let http = 0, threadBlob = 0;
      for (const img of document.querySelectorAll('img')) {
        if (!visible(img)) continue;
        const s = img.currentSrc || img.src || '';
        if (s.startsWith('http')) http++;
        else if ((s.startsWith('blob:') || s.startsWith('data:')) && !inComposer(img)) threadBlob++;
      }
      return (http - base.http) >= need || (threadBlob - base.threadBlob) >= need;
    }, { base, need }, { timeout: 45000 });
    inThread = true;
  } catch {
    logger.warn(`[basso] waitImageSent: KHÔNG thấy đủ ${need} ảnh xuất hiện trong hội thoại sau 45s`);
  }

  // Chờ network rảnh để upload lên Zalo hoàn tất trước khi caller đóng browser.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const after = await _imageThreadState(page).catch(() => base);
  logger.info(`[basso][verify] sau khi gửi ảnh: ${JSON.stringify(after)} (previewLeft=${previewLeft}, inThread=${inThread})`);
  return inThread;
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
      error: `Chưa đăng nhập ZaloCRM cho tài khoản "${zaloAccountName}". Hãy xoá và thêm lại tài khoản qua UI.`,
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
    // Chờ SPA dựng xong UI (nút tài khoản/ô tìm kiếm/ô mật khẩu) thay vì sleep
    // cứng — mạng/proxy chậm thì chờ đủ lâu, nhanh thì đi tiếp ngay. Không chờ
    // được cũng vẫn thử (bước chọn tài khoản/ô soạn phía sau tự kiểm tra lại).
    if (!(await waitForChatReady(page))) {
      logger.warn('[salework] Trang chat chưa render rõ sau khi mở — vẫn thử tiếp');
    }
    await sleep(1000); // 1 nhịp cho Vue settle sau khi phần tử đầu tiên hiện
    await screenshot(page, '01-loaded');

    // Session hết hạn → basso đẩy về trang đăng nhập. Báo rõ cần admin login lại,
    // KHÔNG để rơi xuống "không chọn được tài khoản" (sai nguyên nhân).
    if (await isOnLoginPage(page)) {
      throw new Error(`Phiên đăng nhập ZaloCRM của tài khoản "${zaloAccountName}" đã hết hạn (trình duyệt mở ra trang đăng nhập). Cần kiểm tra lại — báo admin đăng nhập lại tài khoản trên ZaloCRM.`);
    }

    const accountOk = await selectZaloAccount(page, zaloAccountName);
    await screenshot(page, '02-account-selected');

    // HUỶ đăng nếu không chọn được đúng tài khoản — thà báo lỗi rõ ràng còn hơn
    // âm thầm đăng nhầm bằng tài khoản mặc định ("Tất cả tài khoản" → Basso…).
    if (!accountOk) {
      throw new Error(`Không chọn được tài khoản "${zaloAccountName}" trên ZaloCRM (ô vẫn ở "Tất cả tài khoản" hoặc chọn nhầm). Đã huỷ đăng để tránh đăng nhầm tài khoản — mở lại ZaloCRM kiểm tra danh sách tài khoản đã kết nối.`);
    }

    if (!(await searchAndClickGroup(page, groupName))) {
      throw new Error(`Không tìm thấy nhóm "${groupName}" trên ZaloCRM — kiểm tra lại tên nhóm có đúng không, hoặc tài khoản "${zaloAccountName}" có nằm trong nhóm này không.`);
    }
    await screenshot(page, '04-group-selected');

    // XÁC MINH ô soạn tin đã hiện (= hội thoại group đã mở & trang đã render thật).
    // Trang basso load chậm/treo qua proxy yếu → textarea CHƯA render; trước đây
    // code vẫn lao vào đính ảnh rồi báo nhầm "đính ảnh thất bại" (diag composer="",
    // httpImgs thấp) — thực chất là TRANG CHƯA LOAD. Ở đây nếu ô soạn chưa hiện thì
    // RELOAD + chọn lại tài khoản + mở lại group MỘT lần để vượt qua lần load chậm
    // tạm thời; vẫn không có thì báo lỗi ĐÚNG nguyên nhân (proxy/mạng) để đăng lại.
    if (!(await ensureComposerReady(page, 15000))) {
      logger.warn(`[salework] Ô soạn tin chưa hiện sau khi mở "${groupName}" — reload trang & mở lại group`);
      await page.goto(ZALO_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      if (!(await selectZaloAccount(page, zaloAccountName))) {
        throw new Error(`Không chọn được tài khoản "${zaloAccountName}" sau khi reload — đã huỷ đăng.`);
      }
      if (!(await searchAndClickGroup(page, groupName))) {
        throw new Error(`Không tìm thấy nhóm "${groupName}" sau khi reload — đã huỷ đăng.`);
      }
      if (!(await ensureComposerReady(page, 20000))) {
        throw new Error(`Mở hội thoại nhóm "${groupName}" thất bại — trang chat chưa load (proxy/mạng chậm). Đã huỷ để tránh đăng thiếu hình. Kiểm tra proxy/kết nối rồi đăng lại.`);
      }
      await screenshot(page, '04b-group-reopened');
    }

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
