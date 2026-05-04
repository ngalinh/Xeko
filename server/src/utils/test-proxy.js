/**
 * Logic test proxy dùng chung cho CLI (server/test-proxy.js) và API
 * (POST /api/accounts/:key/test-proxy trong local-server.js).
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseProxy } = require('./proxy');

const META_FILE = path.resolve(__dirname, '../../config/profiles-meta.json');
const ZALO_FILE = path.resolve(__dirname, '../../config/zalo-accounts.json');

// Project-local temp dir — fix EPERM khi PM2 chạy như Windows Service
// và Temp\<session>\ không tồn tại / không có quyền ghi.
const PROJECT_TMP = path.resolve(__dirname, '../../.tmp');

function ensureWritableTmp() {
  try {
    fs.mkdirSync(PROJECT_TMP, { recursive: true });
    // Test thật xem ghi được không
    fs.writeFileSync(path.join(PROJECT_TMP, '.write-test'), '1');
    fs.unlinkSync(path.join(PROJECT_TMP, '.write-test'));
  } catch {
    // Nếu folder dự án cũng không ghi được thì fallback về os.tmpdir() (giữ nguyên hành vi cũ)
    return null;
  }
  // Override env để Playwright tạo artifacts vào folder này thay vì system temp
  process.env.TEMP = PROJECT_TMP;
  process.env.TMP = PROJECT_TMP;
  process.env.TMPDIR = PROJECT_TMP;
  return PROJECT_TMP;
}

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
  ensureWritableTmp();
  const browser = await chromium.launch({
    headless: opts.headless !== false,
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

/**
 * Test proxy của 1 profile.
 * @returns {Promise<{ok:boolean, profileKey, source?:string, proxyServer?:string,
 *   localIp?:string, proxyIp?:string, error?:string, reason?:string}>}
 */
async function runProxyTest(profileKey, options = {}) {
  if (!profileKey) {
    return { ok: false, profileKey, error: 'Thiếu profileKey' };
  }

  const found = findProxy(profileKey);
  if (!found) {
    return {
      ok: false,
      profileKey,
      reason: 'no_proxy',
      error: `Profile "${profileKey}" chưa gán proxy. Vào tab Tài khoản → Sửa profile → nhập Proxy IP.`,
    };
  }

  const proxyOpt = parseProxy(found.proxy);
  if (!proxyOpt) {
    return {
      ok: false,
      profileKey,
      reason: 'invalid_format',
      error: `Proxy không hợp lệ: "${found.proxy}". Format: host:port | host:port:user:pass | user:pass@host:port | http(s)://... | socks5://...`,
    };
  }

  const result = {
    ok: false,
    profileKey,
    source: found.source,
    proxyServer: proxyOpt.server,
    proxyAuth: proxyOpt.username ? `${proxyOpt.username}:****` : null,
  };

  // 1) IP local (best-effort, nếu fail vẫn tiếp tục test proxy)
  try {
    result.localIp = await fetchIp({ headless: options.headless });
  } catch (e) {
    result.localIpError = e.message;
  }

  // 2) IP qua proxy
  try {
    result.proxyIp = await fetchIp({ proxy: proxyOpt, headless: options.headless });
  } catch (e) {
    result.error = `Lỗi mở browser qua proxy: ${e.message}. Proxy có thể chết, sai credentials, hoặc không reachable.`;
    result.reason = 'proxy_unreachable';
    return result;
  }

  if (result.localIp && result.localIp === result.proxyIp) {
    result.reason = 'bypass';
    result.error = `IP qua proxy (${result.proxyIp}) giống IP local — proxy bị bypass hoặc chính là IP máy.`;
    return result;
  }

  result.ok = true;
  return result;
}

module.exports = { runProxyTest, findProxy, fetchIp };
