/**
 * TEST TỰ ĐỘNG ĐĂNG NHẬP ZaloCRM (zalo.basso.vn)
 * ---------------------------------------------------------------------------
 * Mục đích: kiểm tra bước tự-đăng-nhập KHÔNG cần chờ session hết hạn 7 ngày.
 * Script mở 1 profile MỚI (trống) → chắc chắn thấy trang đăng nhập → chạy đúng
 * hàm performCrmLogin() dùng trong luồng đăng bài để xem selector có khớp form
 * thật của basso không, và có vào được /chat không.
 *
 * Cách chạy (trong thư mục server/):
 *   1. Đã đặt BASSO_ZALO_USERNAME / BASSO_ZALO_PASSWORD trong server/.env
 *      (hoặc crmUsername/crmPassword trong config/zalo-accounts.json rồi truyền key).
 *   2. node test-auto-login.js            # dùng thông tin chung (env)
 *      node test-auto-login.js <accountKey>   # dùng override theo tài khoản
 *
 * Biến môi trường phụ:
 *   HEADLESS=1   chạy ẩn (mặc định hiện cửa sổ để bạn xem tận mắt)
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
const salework = require('./src/playwright/salework');

const accountKey = process.argv[2] || '';
const headless = process.env.HEADLESS === '1';

(async () => {
  const creds = salework.getCrmCredentials(accountKey);
  if (!creds) {
    console.error('✗ CHƯA cấu hình thông tin đăng nhập.');
    console.error('  Đặt BASSO_ZALO_USERNAME/BASSO_ZALO_PASSWORD trong server/.env,');
    console.error('  hoặc crmUsername/crmPassword trong config/zalo-accounts.json rồi truyền <accountKey>.');
    process.exit(1);
  }
  console.log(`✓ Có thông tin đăng nhập cho "${accountKey || '(chung/env)'}": user=${creds.username}, pass=${'*'.repeat(creds.password.length)}`);

  // Profile TẠM (trống) → luôn hiện trang login, không đụng profile thật.
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'xeko-login-test-'));
  console.log(`→ Profile tạm: ${tmpProfile}`);

  let browser;
  try {
    browser = await safeLaunchPersistentContext(tmpProfile, {
      headless,
      slowMo: 300,
      viewport: { width: 1280, height: 720 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    const page = browser.pages()[0] || await browser.newPage();

    console.log(`→ Mở ${salework.ZALO_LOGIN_URL} ...`);
    await page.goto(salework.ZALO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Nếu vào thẳng chat (basso không bắt login?) thì báo & dừng.
    if (!/login/i.test(page.url()) && !(await page.$('input[type="password"]'))) {
      console.log('ℹ Trang không hiện form đăng nhập (có thể đã vào thẳng chat). URL:', page.url());
      console.log('  → Không test được auto-login ở trạng thái này.');
      return;
    }

    console.log('→ Thấy trang đăng nhập, chạy performCrmLogin() ...');
    const ok = await salework.performCrmLogin(page, creds);
    console.log(`→ URL sau đăng nhập: ${page.url()}`);

    // Sang /chat để xác nhận session dùng được.
    await page.goto(salework.ZALO_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    const stillLogin = /login/i.test(page.url()) || !!(await page.$('input[type="password"]'));

    const shot = path.join(os.tmpdir(), 'xeko-login-test-result.png');
    await page.screenshot({ path: shot }).catch(() => {});

    if (ok && !stillLogin) {
      console.log('\n✅ THÀNH CÔNG: đã tự đăng nhập và vào được ZaloCRM.');
      console.log(`   Screenshot: ${shot}`);
    } else {
      console.log('\n❌ THẤT BẠI: vẫn ở trang đăng nhập sau khi thử.');
      console.log('   Khả năng: sai mật khẩu, có OTP/captcha, hoặc SELECTOR form không khớp.');
      console.log(`   Xem screenshot để đối chiếu: ${shot}`);
      console.log('   Nếu do selector: gửi mình HTML của form login để chỉnh performCrmLogin().');
    }
  } catch (e) {
    console.error('✗ Lỗi:', e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }
})();
