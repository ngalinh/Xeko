/**
 * TEST-IG-COMPOSER.JS - Đăng thử 1 bài Instagram (feed, 1 hoặc nhiều ảnh + caption)
 * trên MỘT tài khoản thật. Chạy thủ công, nhìn trực tiếp cửa sổ Chromium để biết
 * bước nào fail (selector Instagram thay đổi theo thời gian, chưa kiểm chứng
 * được bằng sandbox không có mạng/Chromium thật).
 *
 * Lần đầu dùng 1 profileKey: nếu chưa có profile (playwright-data/ig-<profileKey>),
 * script tự tạo thư mục và mở Chromium để bạn đăng nhập Instagram thủ công — đăng
 * nhập xong, quay lại terminal gõ Enter để script tiếp tục đăng bài thử.
 *
 * Cách dùng:
 *   node server/test-ig-composer.js <profileKey> "<caption>" <ảnh1> [ảnh2 ...]
 *   node server/test-ig-composer.js tram "Hàng mới về!" /path/to/anh1.jpg
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
const ig = require('./src/playwright/post-instagram');

const [profileKey, caption, ...images] = process.argv.slice(2);

if (!profileKey || !caption || images.length === 0) {
  console.log('Usage: node server/test-ig-composer.js <profileKey> "<caption>" <ảnh1> [ảnh2 ...]');
  process.exit(1);
}

for (const img of images) {
  if (!fs.existsSync(img)) {
    console.log(`❌ Không tìm thấy ảnh: ${img}`);
    process.exit(1);
  }
}

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const profileDir = path.resolve(__dirname, `playwright-data/ig-${profileKey}`);
  if (!fs.existsSync(profileDir)) {
    console.log(`\n=== Chưa có profile Instagram "${profileKey}" — mở Chromium để đăng nhập thủ công ===\n`);
    fs.mkdirSync(profileDir, { recursive: true });
    const browser = await safeLaunchPersistentContext(profileDir, {
      stealth: false,
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
    const page = browser.pages()[0] || await browser.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForEnter('Đăng nhập Instagram xong trong cửa sổ Chromium rồi quay lại đây, nhấn Enter để tiếp tục...\n');
    await browser.close();
  }

  console.log(`\n=== Đăng thử bài Instagram cho profile "${profileKey}" (${images.length} ảnh) ===\n`);
  const result = await ig.postToFeed(profileKey, caption, images, null);

  if (result.success) {
    console.log('✅ Đăng bài thành công.');
  } else {
    console.log(`❌ Đăng bài lỗi: ${result.error}`);
    process.exit(1);
  }
})();
