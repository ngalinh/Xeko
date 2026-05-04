/**
 * TEST-PROXY.JS - Kiểm tra proxy IP của 1 profile có hoạt động đúng không
 *
 * Cách dùng:
 *   node server/test-proxy.js <profileKey>
 *   node server/test-proxy.js linhthao
 *   node server/test-proxy.js linhthao --headed   (mở cửa sổ thấy được)
 */

const { runProxyTest } = require('./src/utils/test-proxy');

const profileKey = process.argv[2];
const headed = process.argv.includes('--headed');

if (!profileKey) {
  console.log('Usage: node server/test-proxy.js <profileKey> [--headed]');
  process.exit(1);
}

(async () => {
  console.log(`\n=== Test proxy cho profile: ${profileKey} ===\n`);

  const r = await runProxyTest(profileKey, { headless: !headed });

  if (r.reason === 'no_proxy') {
    console.log(`❌ ${r.error}\n`);
    process.exit(1);
  }
  if (r.reason === 'invalid_format') {
    console.log(`❌ ${r.error}\n`);
    process.exit(1);
  }

  console.log(`Nguồn:  ${r.source}`);
  console.log(`Proxy:  ${r.proxyServer}${r.proxyAuth ? ` (auth: ${r.proxyAuth})` : ''}`);
  console.log('');

  console.log('1) Lấy IP local (không proxy)...');
  if (r.localIp) console.log(`   IP local: ${r.localIp}\n`);
  else console.log(`   ⚠️  Không lấy được: ${r.localIpError || 'unknown'}\n`);

  console.log('2) Lấy IP qua proxy...');
  if (r.proxyIp) console.log(`   IP qua proxy: ${r.proxyIp}\n`);
  else {
    console.log(`   ❌ ${r.error}\n`);
    process.exit(1);
  }

  console.log('=== Kết quả ===');
  if (r.reason === 'bypass') {
    console.log(`⚠️  ${r.error}`);
    process.exit(2);
  }
  console.log(`✅ Proxy OK. Profile "${r.profileKey}" đang đi qua IP: ${r.proxyIp}`);
})().catch(err => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
