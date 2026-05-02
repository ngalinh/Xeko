/**
 * TEST-PROXY.JS - Kiểm tra proxy IP của 1 profile có hoạt động đúng không
 *
 * Cách dùng:
 *   node server/test-proxy.js <profileKey>
 *   node server/test-proxy.js linhthao
 *   node server/test-proxy.js linhthao --headed   (mở cửa sổ thấy được)
 *
 * Script sẽ:
 * 1) In ra IP local hiện tại (không qua proxy) — để so sánh
 * 2) Đọc proxy của profile từ profiles-meta.json hoặc zalo-accounts.json
 * 3) Mở Chromium headless với proxy đã gán
 * 4) Vào api.ipify.org → in IP thực sự đang dùng
 * 5) So sánh: IP qua proxy phải KHÁC IP local → proxy hoạt động đúng
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { parseProxy } = require('./src/utils/proxy');

const profileKey = process.argv[2];
const headed = process.argv.includes('--headed');

if (!profileKey) {
  console.log('Usage: node server/test-proxy.js <profileKey> [--headed]');
  process.exit(1);
}

const META_FILE = path.resolve(__dirname, 'config/profiles-meta.json');
const ZALO_FILE = path.resolve(__dirname, 'config/zalo-accounts.json');

function loadJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return null;
}

function findProxy(key) {
  const meta = loadJson(META_FILE) || {};
  if (meta[key] && meta[key].proxy) return { proxy: meta[key].proxy, source: 'profiles-meta.json (FB)' };

  const zalo = loadJson(ZALO_FILE) || [];
  const acct = zalo.find(a => a.key === key);
  if (acct && acct.proxy) return { proxy: acct.proxy, source: 'zalo-accounts.json' };

  return null;
}

async function fetchIp(opts = {}) {
  const browser = await chromium.launch({
    headless: !headed,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto('https://api.ipify.org/?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const text = await page.locator('body').innerText();
    return JSON.parse(text).ip;
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`\n=== Test proxy cho profile: ${profileKey} ===\n`);

  const found = findProxy(profileKey);
  if (!found) {
    console.log(`❌ Profile "${profileKey}" chưa gán proxy.`);
    console.log(`   Vào tab Tài khoản → Sửa profile → nhập Proxy IP rồi lưu.\n`);
    process.exit(1);
  }

  const proxyOpt = parseProxy(found.proxy);
  if (!proxyOpt) {
    console.log(`❌ Proxy không hợp lệ: "${found.proxy}"`);
    console.log(`   Format hỗ trợ: host:port | host:port:user:pass | user:pass@host:port | http(s)://... | socks5://...\n`);
    process.exit(1);
  }

  console.log(`Nguồn:  ${found.source}`);
  console.log(`Proxy:  ${proxyOpt.server}${proxyOpt.username ? ` (auth: ${proxyOpt.username}:****)` : ''}`);
  console.log('');

  console.log('1) Lấy IP local (không proxy)...');
  let localIp;
  try {
    localIp = await fetchIp();
    console.log(`   IP local: ${localIp}\n`);
  } catch (e) {
    console.log(`   ⚠️  Không lấy được IP local: ${e.message}\n`);
  }

  console.log('2) Lấy IP qua proxy...');
  let proxyIp;
  try {
    proxyIp = await fetchIp({ proxy: proxyOpt });
    console.log(`   IP qua proxy: ${proxyIp}\n`);
  } catch (e) {
    console.log(`   ❌ Lỗi mở browser qua proxy: ${e.message}`);
    console.log(`   → Proxy có thể chết, sai credentials, hoặc không reachable.\n`);
    process.exit(1);
  }

  console.log('=== Kết quả ===');
  if (localIp && proxyIp && localIp === proxyIp) {
    console.log(`⚠️  IP qua proxy (${proxyIp}) GIỐNG IP local — proxy KHÔNG hoạt động!`);
    console.log(`   Có thể: proxy bị bypass, hoặc proxy chính là IP local.`);
    process.exit(2);
  }
  console.log(`✅ Proxy OK. Profile "${profileKey}" đang đi qua IP: ${proxyIp}`);
})().catch(err => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
