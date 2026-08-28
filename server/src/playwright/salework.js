const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getZaloProxyForAccount } = require('../utils/proxy');
const { randomDelay, humanType, sleep } = require('../utils/delay');
const { getProfileDeviceFingerprint } = require('../utils/device-fingerprint');
const { checkProxy } = require('../utils/proxy-health');
const loginHistory = require('../utils/login-history');

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
// TỰ ĐỘNG ĐĂNG NHẬP LẠI ZaloCRM (zalo.basso.vn) khi session hết hạn (~7 ngày).
// ----------------------------------------------------------------------------
// Trước đây session hết hạn → ném lỗi, admin phải MỞ TAY trình duyệt gõ lại
// username/password mỗi 7 ngày. Nay nếu đã CẤU HÌNH SẴN thông tin đăng nhập
// ZaloCRM thì tự điền form và bấm "Đăng nhập", khỏi cần thao tác tay.
//
// Nguồn thông tin đăng nhập (ưu tiên từ trên xuống):
//   1. Ghi đè theo từng tài khoản trong config/zalo-accounts.json:
//        { "key": "...", "crmUsername": "...", "crmPassword": "..." }
//   2. Biến môi trường dùng chung cho MỌI tài khoản (1 CRM login quản nhiều Zalo):
//        BASSO_ZALO_USERNAME / BASSO_ZALO_PASSWORD
// Không có thông tin nào → trả null → GIỮ hành vi cũ (báo admin đăng nhập tay).
// ============================================================================

const ZALO_ACCOUNTS_FILE = path.resolve(__dirname, '../../config/zalo-accounts.json');

function getCrmCredentials(accountKey) {
  let username = process.env.BASSO_ZALO_USERNAME || '';
  let password = process.env.BASSO_ZALO_PASSWORD || '';
  try {
    if (fs.existsSync(ZALO_ACCOUNTS_FILE)) {
      const accounts = JSON.parse(fs.readFileSync(ZALO_ACCOUNTS_FILE, 'utf8'));
      const acct = Array.isArray(accounts) ? accounts.find(a => a.key === accountKey) : null;
      if (acct) {
        if (acct.crmUsername) username = acct.crmUsername;
        if (acct.crmPassword) password = acct.crmPassword;
      }
    }
  } catch (e) {
    logger.warn(`[basso][login] Đọc zalo-accounts.json lỗi: ${e.message}`);
  }
  if (!username || !password) return null;
  return { username, password };
}

// Điền form đăng nhập ZaloCRM và bấm "Đăng nhập". Trả true nếu đã RỜI khỏi trang
// login (đăng nhập thành công), false nếu vẫn kẹt (sai mật khẩu / OTP / captcha).
// DOM login của basso có thể là email/username/sđt → thử nhiều selector cho ô
// tài khoản; ô mật khẩu luôn là input[type="password"].
async function performCrmLogin(page, creds) {
  const userSelectors = [
    'input[name="username"]', 'input[name="email"]', 'input[name="account"]',
    'input[name="phone"]', 'input[type="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="ài khoản"]', 'input[placeholder*="mail"]',
    'input[placeholder*="iện thoại"]', 'input[placeholder*="ăng nhập"]',
  ];
  let filledUser = false;
  for (const sel of userSelectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    try {
      await loc.fill(creds.username, { timeout: 3000 });
      filledUser = true;
      logger.info(`[basso][login] Điền tài khoản bằng: ${sel}`);
      break;
    } catch {}
  }
  if (!filledUser) {
    // Dự phòng: ô nhập text ĐẦU TIÊN không phải password/hidden/checkbox.
    const loc = page.locator(
      'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
    ).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.fill(creds.username, { timeout: 3000 }); filledUser = true; } catch {}
    }
  }
  if (!filledUser) {
    logger.error('[basso][login] Không tìm thấy ô nhập tài khoản trên trang đăng nhập');
    return false;
  }

  const passLoc = page.locator('input[type="password"]').first();
  try {
    await passLoc.fill(creds.password, { timeout: 3000 });
  } catch (e) {
    logger.error(`[basso][login] Không điền được mật khẩu: ${e.message}`);
    return false;
  }

  // Bấm nút "Đăng nhập"; không thấy nút thì Enter dự phòng.
  const btn = page.locator('button:has-text("Đăng nhập"), button:has-text("đăng nhập")').first();
  try {
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 4000 });
    } else {
      await passLoc.press('Enter');
    }
  } catch (e) {
    logger.warn(`[basso][login] Click nút đăng nhập lỗi (${e.message}) — thử Enter`);
    try { await passLoc.press('Enter'); } catch {}
  }

  // Chờ ô mật khẩu biến mất = đã rời trang login (tối đa ~15s cho login + redirect).
  await page.waitForFunction(
    () => !document.querySelector('input[type="password"]'),
    { timeout: 15000 }
  ).catch(() => {});
  await sleep(1500);
  return !(await isOnLoginPage(page));
}

// Nếu đang ở trang đăng nhập ZaloCRM, thử TỰ đăng nhập lại rồi quay về trang chat.
// Ném lỗi rõ ràng nếu chưa cấu hình thông tin đăng nhập, hoặc tự đăng nhập thất
// bại (sai mật khẩu / OTP / captcha) — để caller báo admin xử lý tay.
async function ensureLoggedIn(page, accountKey, zaloAccountName) {
  if (!(await isOnLoginPage(page))) return;

  const creds = getCrmCredentials(accountKey);
  if (!creds) {
    loginHistory.addEntry(accountKey, zaloAccountName, 'session_expired',
      'Session ZaloCRM hết hạn — chưa cấu hình tự đăng nhập');
    throw new Error(
      `Phiên đăng nhập ZaloCRM của tài khoản "${zaloAccountName}" đã hết hạn và CHƯA cấu hình tự đăng nhập. ` +
      `Đặt BASSO_ZALO_USERNAME/BASSO_ZALO_PASSWORD (hoặc crmUsername/crmPassword trong config/zalo-accounts.json) ` +
      `để tự đăng nhập lại, hoặc mở ZaloCRM đăng nhập tay.`
    );
  }

  logger.info(`[basso][login] Session "${zaloAccountName}" hết hạn — thử tự đăng nhập lại...`);
  await screenshot(page, '01b-login-page');
  const ok = await performCrmLogin(page, creds);
  if (!ok) {
    await screenshot(page, '01c-login-failed');
    loginHistory.addEntry(accountKey, zaloAccountName, 'session_expired',
      'Tự đăng nhập ZaloCRM thất bại (sai mật khẩu / OTP / captcha)');
    throw new Error(
      `Tự đăng nhập ZaloCRM cho "${zaloAccountName}" thất bại (sai mật khẩu, hoặc bị hỏi OTP/captcha). ` +
      `Cần admin đăng nhập tay trên ZaloCRM.`
    );
  }

  logger.info(`[basso][login] ✓ Đã tự đăng nhập lại ZaloCRM cho "${zaloAccountName}"`);
  loginHistory.addEntry(accountKey, zaloAccountName, 'login', 'Tự đăng nhập lại ZaloCRM thành công');

  // Về lại trang chat để tiếp tục quy trình đăng.
  await page.goto(ZALO_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await waitForChatReady(page);
  await sleep(1000);
  if (await isOnLoginPage(page)) {
    throw new Error(
      `Đã tự đăng nhập ZaloCRM nhưng vẫn bị đẩy về trang login cho "${zaloAccountName}" — cần admin kiểm tra tay.`
    );
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
    // Chờ list tài khoản hiện (thay sleep cứng) — render sớm thì đi tiếp ngay.
    await page.locator('.v-list:has(.acc-tick)').first()
      .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
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
  // Chờ có ít nhất 1 dòng tài khoản render thay vì sleep cứng (vòng lặp bên dưới
  // vẫn tự đọc lại nhiều lần nếu list còn dựng dở).
  await page.locator('.v-list .v-list-item').first()
    .waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});

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
  // Chờ dropdown ĐÓNG hẳn (list biến mất) thay vì sleep cứng — để bước tìm nhóm
  // không bị overlay dropdown che, đọc đúng danh sách hội thoại đã lọc.
  await page.locator('.v-list:has(.acc-tick)').first()
    .waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});

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
    // Chờ hội thoại mở THẬT (ô soạn hiện) thay vì sleep cứng — click xong Vue cần
    // dựng khung chat; proxy chậm thì chờ đủ, nhanh thì đi tiếp ngay. Không hiện
    // cũng không sao: ensureComposerReady ở caller sẽ reload + mở lại group.
    await page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"]')
      .first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await screenshot(page, '03c-after-click');
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

// Zalo (qua basso CRM) hiển thị INLINE dạng bong bóng ảnh với JPEG/PNG chuẩn, nhưng
// các định dạng khác (webp/heic/heif/bmp/gif) hoặc ảnh QUÁ LỚN thường bị gửi thành
// FILE ĐÍNH KÈM thay vì ảnh — đúng hiện tượng "hình cuối gửi vào Zalo chuyển thành
// file" khi trong bộ ảnh lẫn 1 tấm khác định dạng/khổ (vd 1 ảnh webp giữa các ảnh jpg).
// CHUẨN HOÁ tất cả ảnh về JPEG baseline + giới hạn cạnh dài ≤ MAX_EDGE TRƯỚC khi đính,
// để Zalo đối xử đồng nhất = luôn là ảnh. Dùng chính Chromium (đã có sẵn) để decode +
// canvas re-encode → KHÔNG cần thư viện ngoài (sharp/jimp). Ảnh nào Chromium không đọc
// được (vd HEIC) hoặc lỗi thì GIỮ NGUYÊN file gốc — thà gửi nguyên còn hơn rớt hình.
const ZALO_IMG_MAX_EDGE = 2048;      // px — cạnh dài tối đa (tránh Zalo hạ ảnh lớn thành file)
const ZALO_IMG_JPEG_QUALITY = 0.92;  // chất lượng JPEG khi re-encode

// Trả về mảng đường dẫn MỚI cùng độ dài với imagePaths. Với mỗi ảnh chuẩn hoá được,
// ghi 1 file .zalo.jpg cạnh file gốc và trả về đường dẫn đó; ảnh không chuẩn hoá được
// giữ nguyên đường dẫn gốc. Đường dẫn .zalo.jpg mới nằm cùng thư mục job → caller nên
// dọn (được liệt kê để xoá trong _postToZaloGroupImpl).
async function normalizeImagesForZalo(browser, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return imagePaths;
  let scratch;
  try {
    scratch = await browser.newPage();
    await scratch.goto('about:blank').catch(() => {});
  } catch (e) {
    logger.warn(`[salework][img] Không mở được trang chuẩn hoá ảnh (${e.message}) — dùng ảnh gốc`);
    return imagePaths;
  }
  const out = [];
  for (const src of imagePaths) {
    try {
      const ext = path.extname(src).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
                 : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp'
                 : (ext === '.heic' || ext === '.heif') ? 'image/heic' : 'image/jpeg';
      const b64 = fs.readFileSync(src).toString('base64');
      const jpegB64 = await scratch.evaluate(async ({ dataUrl, maxEdge, quality }) => {
        const img = new Image();
        const loaded = await new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = dataUrl;
        });
        if (!loaded || !img.naturalWidth || !img.naturalHeight) return null;
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        // Nền trắng cho ảnh có alpha (PNG/webp trong suốt) khỏi thành nền đen khi sang JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const url = canvas.toDataURL('image/jpeg', quality);
          const comma = url.indexOf(',');
          return comma >= 0 ? url.slice(comma + 1) : null;
        } catch { return null; } // canvas tainted (không xảy ra với data: URL cùng gốc)
      }, { dataUrl: `data:${mime};base64,${b64}`, maxEdge: ZALO_IMG_MAX_EDGE, quality: ZALO_IMG_JPEG_QUALITY });

      if (!jpegB64) {
        logger.warn(`[salework][img] Không chuẩn hoá được ${path.basename(src)} (Chromium không decode được — vd HEIC) — giữ file gốc`);
        out.push(src);
        continue;
      }
      const dest = src.replace(/\.[^.]+$/, '') + '.zalo.jpg';
      fs.writeFileSync(dest, Buffer.from(jpegB64, 'base64'));
      out.push(dest);
    } catch (e) {
      logger.warn(`[salework][img] Lỗi chuẩn hoá ${path.basename(src)}: ${e.message} — giữ file gốc`);
      out.push(src);
    }
  }
  try { await scratch.close(); } catch {}
  const changed = out.filter((p, i) => p !== imagePaths[i]).length;
  logger.info(`[salework][img] Chuẩn hoá ${changed}/${imagePaths.length} ảnh về JPEG (cạnh dài ≤ ${ZALO_IMG_MAX_EDGE}px) cho Zalo`);
  return out;
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

async function sendMessage(page, message, imagePaths = [], shouldCancel = null) {
  logger.info(`[basso] Gửi: "${message?.substring(0, 30)}" + ${imagePaths.length} ảnh`);
  let sentAny = false;

  // Điểm cuối cùng còn ngăn được tin SAI nội dung lên thật: kiểm tra "⏹ Dừng" ngay TRƯỚC
  // mỗi lần bấm Gửi (ảnh và text là 2 tin nhắn RIÊNG, bấm Gửi lần nào là tin đó lên thật
  // ngay lần đó — không có bước "soạn xong chờ xác nhận" như dialog Facebook). Đính ảnh/
  // nhập text trước đó vẫn chạy vì chưa lộ ra ngoài (mới là preview trong ô soạn).
  const _throwIfCancelled = () => {
    if (typeof shouldCancel !== 'function' || !shouldCancel()) return;
    const err = new Error('Đã dừng theo yêu cầu người dùng');
    err.cancelled = true;
    throw err;
  };

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
  // Thử tối đa 2 lần TOÀN BỘ chuỗi (đính → bấm Gửi → xác minh vào hội thoại). Nếu
  // cả 2 lần đều fail thì HUỶ LUÔN toàn bộ tin nhắn — KHÔNG gửi text nữa. Có ảnh
  // mà thiếu ảnh đăng thành công thì thà không đăng gì còn hơn đăng thiếu hình.
  if (imagePaths.length > 0) {
    let imageOk = false;
    let lastImageError = null;
    for (let attempt = 1; attempt <= 2 && !imageOk; attempt++) {
      if (attempt > 1) {
        logger.warn(`[basso] Gửi ảnh lần ${attempt - 1} thất bại (${lastImageError?.message}) — thử lại lần ${attempt}...`);
        await sleep(1500);
      }
      try {
        const uploaded = await attachImages(page, imagePaths);
        // Đính KHÔNG ĐỦ (thiếu/không vào được) → coi là fail của lượt này, để vòng
        // lặp thử lại thay vì âm thầm chỉ gửi text (chính là "rớt hình" ở group sau).
        if (!uploaded) {
          throw new Error(`Không đính đủ ${imagePaths.length} ảnh (file input/menu/paste đều fail hoặc đính thiếu sau 2 lần thử)`);
        }
        // Chụp trạng thái ảnh TRONG HỘI THOẠI ngay TRƯỚC khi bấm Gửi (lúc này ảnh mới
        // chỉ là preview blob trong ô soạn, CHƯA có bong bóng ảnh trong thread). Dùng làm
        // mốc để xác minh ảnh THẬT SỰ vào hội thoại sau khi gửi.
        const before = await _imageThreadState(page).catch(() => ({ http: 0, threadBlob: 0, composerBlob: 0 }));
        logger.info(`[basso][verify] trước khi gửi ảnh (lần ${attempt}): ${JSON.stringify(before)}`);
        _throwIfCancelled();
        if (await clickSend(page)) { logger.info('[basso] Đã bấm gửi tin ảnh'); }
        else throw new Error('Đính được ảnh nhưng không bấm gửi được tin ảnh.');
        // QUAN TRỌNG (lỗi Zalo-specific): bấm Gửi xong, basso CÒN đang upload ảnh lên
        // Zalo (chậm hơn text rất nhiều). Trước đây chỉ sleep 1500ms rồi caller đóng
        // browser ngay → upload bị cắt giữa chừng → group KHÔNG nhận ảnh dù đã báo gửi.
        // SIẾT XÁC MINH: chỉ dựa "preview rời ô soạn" là CHƯA đủ — basso có thể xoá
        // preview nhưng upload FAIL (group rỗng), rồi ta vẫn gửi text → "chỉ gửi text".
        // waitImageSent giờ đòi ảnh THẬT SỰ xuất hiện trong hội thoại (số ảnh thread
        // tăng ≥ số ảnh cần) mới coi là gửi được.
        const imageSent = await waitImageSent(page, imagePaths.length, before);
        if (!imageSent) {
          throw new Error('Đã bấm Gửi nhưng ảnh KHÔNG xuất hiện trong hội thoại sau khi chờ (preview rời ô soạn nhưng bong bóng ảnh không lên)');
        }
        imageOk = true;
        sentAny = true;
      } catch (e) {
        if (e.cancelled) throw e; // người dùng bấm Dừng — không thử lại
        lastImageError = e;
        logger.error(`[basso] Gửi ảnh lần ${attempt} lỗi: ${e.message}`);
      }
    }
    if (!imageOk) {
      throw new Error(`Gửi ảnh thất bại sau 2 lần thử (${lastImageError?.message}) — đã HUỶ, KHÔNG gửi text để tránh đăng thiếu hình. Thử đăng lại.`);
    }
  }

  // ----- 2. TEXT: nhập vào textarea.msg-textarea rồi gửi -----
  // textarea bind Vue v-model → fill() set value + bắn 'input' để BẬT nút Gửi.
  // KHÔNG gõ Enter (Enter chỉ xuống dòng). Dispatch thêm input/change cho chắc.
  // Thử tối đa 2 lần: bấm Gửi xong mà ô soạn KHÔNG rỗng lại (= tin chưa thật sự
  // rời ô soạn/hiển thị) thì nhập lại & bấm Gửi lần nữa trước khi báo lỗi.
  if (message) {
    let textOk = false;
    let lastTextError = null;
    for (let attempt = 1; attempt <= 2 && !textOk; attempt++) {
      if (attempt > 1) {
        logger.warn(`[basso] Gửi text lần ${attempt - 1} thất bại (${lastTextError?.message}) — thử lại lần ${attempt}...`);
        await sleep(1500);
      }
      try {
        const ta = page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"], textarea:visible').first();
        await ta.click({ timeout: 5000 });
        await ta.fill(message);
        await ta.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, message);
        logger.info('[basso] Đã nhập nội dung tin nhắn');
        _throwIfCancelled();
        if (!(await clickSend(page))) {
          throw new Error('Không bấm gửi được tin text.');
        }
        // Xác minh tin ĐÃ RỜI Ô SOẠN (Zalo tự xoá nội dung ô soạn khi gửi thành
        // công) — bấm Gửi mà ô soạn vẫn còn nguyên nội dung = tin CHƯA thật sự
        // hiển thị/gửi đi, cần nhập & gửi lại thay vì coi như xong.
        const cleared = await page.waitForFunction(() => {
          const el = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
          return !el || el.value.trim() === '';
        }, { timeout: 8000 }).then(() => true).catch(() => false);
        if (!cleared) {
          throw new Error('Đã bấm Gửi nhưng tin text KHÔNG hiển thị/rời khỏi ô soạn sau khi chờ.');
        }
        textOk = true;
        sentAny = true;
        logger.info('[basso] Đã gửi tin text');
      } catch (e) {
        if (e.cancelled) throw e; // người dùng bấm Dừng — không thử lại
        lastTextError = e;
        logger.error(`[basso] Gửi text lần ${attempt} lỗi: ${e.message}`);
      }
    }
    if (!textOk) {
      throw new Error(`Gửi text thất bại sau 2 lần thử (${lastTextError?.message}) — đã HUỶ. Thử đăng lại.`);
    }
  }

  if (!sentAny) {
    throw new Error('Không gửi được tin nào (ảnh & text đều thất bại)');
  }

  // Lắng đọng lần cuối TRƯỚC khi caller đóng browser: tin cuối (ảnh/text) có thể
  // vẫn đang lên server. Đóng browser sớm = mất tin. Chờ network rảnh + nghỉ dài
  // hơn hẳn trước đây (2s → 5s) để chắc chắn mọi request cuối đã hoàn tất.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(5000);
  return true;
}

// Đếm ảnh liên quan tới việc gửi, tách theo VỊ TRÍ để phân biệt "đang soạn" và "đã
// vào hội thoại":
//   - composerBlob: ảnh blob/data hiển thị TRONG ô soạn = preview ảnh CHƯA gửi.
//   - threadBlob  : ảnh blob/data hiển thị NGOÀI ô soạn = bong bóng ảnh vừa gửi
//     (basso hiển thị lạc quan bằng chính blob trước khi swap sang URL CDN).
//   - http        : ảnh URL http(s) hiển thị (lịch sử chat + ảnh vừa gửi sau khi lên CDN).
// Khu soạn = tổ tiên gần nhất của textarea mà cũng chứa nút Gửi (giống attachImages).
// Lấy URL "nguồn" thật của 1 phần tử ảnh — không chỉ <img src/currentSrc> mà còn:
//  - data-src/data-original: ảnh lazy-load (src rỗng/placeholder tới khi cuộn vào view).
//  - CSS background-image: bong bóng ảnh nhiều tấm (mosaic) basso hay dựng bằng div nền
//    thay vì thẻ <img> thật — đếm theo <img> thôi thì ảnh ĐÃ HIỆN RÕ trên màn hình vẫn
//    không được tính, khiến hệ thống báo "chưa xác nhận" dù ảnh đã lên hội thoại thật.
// Dùng CHUNG 1 định nghĩa (đưa vào page.evaluate mỗi lần vì browser context không gọi
// được hàm Node) để 3 chỗ đếm ảnh (preview rời ô soạn / ảnh vào hội thoại / snapshot)
// khớp nhau tuyệt đối, tránh lệch tiêu chí.
const _IMG_SRC_OF_SRC = `function(el) {
  if (el.tagName === 'IMG') {
    return el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
  }
  const bg = getComputedStyle(el).backgroundImage || '';
  const m = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
  return m ? m[1] : '';
}`;

async function _imageThreadState(page) {
  return page.evaluate(({ srcOfSrc }) => {
    const srcOf = new Function('return ' + srcOfSrc)();
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
    for (const el of document.querySelectorAll('img, [style*="background-image"]')) {
      if (!visible(el)) continue;
      const s = srcOf(el);
      if (s.startsWith('http')) http++;
      else if (s.startsWith('blob:') || s.startsWith('data:')) {
        if (inComposer(el)) composerBlob++; else threadBlob++;
      }
    }
    return { http, threadBlob, composerBlob };
  }, { srcOfSrc: _IMG_SRC_OF_SRC });
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

  // (1) Preview rời ô soạn (không chặn kết quả, chỉ để log & chờ nhẹ). Rút ngắn
  // còn 10s — chỉ cần tín hiệu nhanh là basso đã nhận lệnh gửi, không cần chờ lâu.
  let previewLeft = true;
  try {
    await page.waitForFunction(({ srcOfSrc }) => {
      const srcOf = new Function('return ' + srcOfSrc)();
      const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea');
      if (!ta) return true;
      let root = ta;
      for (let i = 0; i < 8 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelector('button.send-btn')) break;
      }
      for (const el of root.querySelectorAll('img, [style*="background-image"]')) {
        const s = srcOf(el);
        if (s.startsWith('blob:') || s.startsWith('data:')) {
          const r = el.getBoundingClientRect();
          if (r.width > 12 && r.height > 12) return false;
        }
      }
      return true;
    }, { srcOfSrc: _IMG_SRC_OF_SRC }, { timeout: 10000 });
  } catch {
    previewLeft = false;
    logger.warn('[basso] waitImageSent: preview ảnh CHƯA rời ô soạn sau 10s');
  }

  // (2) Ảnh THẬT SỰ vào hội thoại: số ảnh thread tăng ≥ need. RÚT NGẮN còn 15s
  // (trước đây 75s quá lâu, làm chậm cả loạt bài đăng) — không cần chờ lâu vì có
  // bước xác nhận cuối bên dưới bù lại các ca lên chậm.
  let inThread = false;
  try {
    await page.waitForFunction(({ base, need, srcOfSrc }) => {
      const srcOf = new Function('return ' + srcOfSrc)();
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
      for (const el of document.querySelectorAll('img, [style*="background-image"]')) {
        if (!visible(el)) continue;
        const s = srcOf(el);
        if (s.startsWith('http')) http++;
        else if ((s.startsWith('blob:') || s.startsWith('data:')) && !inComposer(el)) threadBlob++;
      }
      return (http - base.http) >= need || (threadBlob - base.threadBlob) >= need;
    }, { base, need, srcOfSrc: _IMG_SRC_OF_SRC }, { timeout: 15000 });
    inThread = true;
  } catch {
    logger.warn(`[basso] waitImageSent: KHÔNG thấy đủ ${need} ảnh xuất hiện trong hội thoại sau 15s — kiểm tra lại lần cuối rồi cho gửi text`);
  }

  // Chờ network rảnh (rút ngắn) rồi chấm lại lần CUỐI bằng snapshot thật (dùng
  // CHUNG bộ nhận diện ảnh với bước (2) — kể cả ảnh dạng background-image) trước
  // khi cho phép gửi text ngay, không chờ lâu thêm nữa.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(1000);
  const after = await _imageThreadState(page).catch(() => base);
  if (!inThread) {
    const httpUp = after.http - base.http;
    const threadUp = after.threadBlob - base.threadBlob;
    if (httpUp >= need || threadUp >= need) {
      inThread = true;
      logger.info(`[basso] waitImageSent: ảnh đã lên hội thoại ở lần kiểm tra CUỐI (httpUp=${httpUp}, threadUp=${threadUp}) — coi là gửi thành công.`);
    }
  }
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

async function postToZaloGroup({ zaloAccountName, accountKey, groupName, message, imagePaths, shouldCancel = null }) {
  return _withAccountLock(accountKey || zaloAccountName, () =>
    _postToZaloGroupImpl({ zaloAccountName, accountKey, groupName, message, imagePaths, shouldCancel })
  );
}

async function _postToZaloGroupImpl({ zaloAccountName, accountKey, groupName, message, imagePaths, shouldCancel = null }) {
  // Job có thể đã chờ khá lâu trong hàng đợi account/zaloQueue trước khi tới đây — kiểm
  // tra "⏹ Dừng" ngay đầu, trước khi tốn công mở trình duyệt.
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    return { success: false, error: 'Đã dừng theo yêu cầu người dùng', cancelled: true };
  }

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
  let normalizedImageFiles = []; // file .zalo.jpg do chuẩn hoá tạo ra → dọn khi xong
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Dọn ảnh JPEG chuẩn hoá tạm (upload đã xong khi tới đây). File gốc do
    // local-server quản lý vòng đời, không đụng ở đây.
    for (const f of normalizedImageFiles) { try { fs.unlinkSync(f); } catch {} }
    // Chờ thêm một nhịp TRƯỚC khi đóng trình duyệt — không đóng vội ngay khi vừa
    // gửi xong, để có thời gian xác nhận trực quan trên màn hình (headless: false)
    // và tránh cắt ngang bất kỳ request nào của Zalo còn sót lại.
    sleep(4000)
      .then(() => Promise.race([page.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {}))
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

    // Session hết hạn → basso đẩy về trang đăng nhập. TỰ đăng nhập lại nếu đã cấu
    // hình thông tin (BASSO_ZALO_USERNAME/PASSWORD hoặc crmUsername/crmPassword);
    // chưa cấu hình / tự login thất bại → ensureLoggedIn ném lỗi rõ ràng cho admin.
    // KHÔNG để rơi xuống "không chọn được tài khoản" (sai nguyên nhân).
    await ensureLoggedIn(page, accountKey, zaloAccountName);

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

    // Chuẩn hoá ảnh về JPEG đồng nhất TRƯỚC khi gửi để Zalo không biến ảnh khác
    // định dạng/khổ (vd webp) thành FILE đính kèm ("hình cuối chuyển thành file").
    let sendImagePaths = imagePaths;
    if (imagePaths && imagePaths.length > 0) {
      sendImagePaths = await normalizeImagesForZalo(browser, imagePaths);
      normalizedImageFiles = sendImagePaths.filter((p, i) => p !== imagePaths[i]);
    }

    await sendMessage(page, message, sendImagePaths, shouldCancel);

    logger.info(`[salework] Đã đăng lên "${groupName}" qua "${zaloAccountName}"`);
    cleanup(); // chạy nền, không await — trả kết quả ngay
    return { success: true };
  } catch (e) {
    if (e.cancelled) logger.info(`[salework] Đã bị dừng theo yêu cầu người dùng — không gửi`);
    else logger.error(`[salework] Lỗi: ${e.message}`);
    try { await screenshot(page, '99-error'); } catch {}
    cleanup(); // chạy nền, không await
    return { success: false, error: e.message, cancelled: !!e.cancelled };
  }
}

module.exports = {
  postToZaloGroup, getSaleworkProfile, ZALO_LOGIN_URL, ZALO_CHAT_URL,
  getCrmCredentials, performCrmLogin, ensureLoggedIn,
};
