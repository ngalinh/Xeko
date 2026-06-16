/**
 * Logic test proxy dùng chung cho CLI (server/test-proxy.js) và API
 * (POST /api/accounts/:key/test-proxy trong local-server.js).
 *
 * Browser launch + auto-install logic dùng chung qua playwright-launch.js.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const { parseProxy } = require('./proxy');
const { safeLaunch } = require('./playwright-launch');

const META_FILE = path.resolve(__dirname, '../../config/profiles-meta.json');
const ZALO_FILE = path.resolve(__dirname, '../../config/zalo-accounts.json');

// Project-local temp dir — fix EPERM khi PM2 chạy như Windows Service
// và Temp\<session>\ không tồn tại / không có quyền ghi.
const PROJECT_TMP = path.resolve(__dirname, '../../.tmp');

function ensureWritableTmp() {
  try {
    fs.mkdirSync(PROJECT_TMP, { recursive: true });
    fs.writeFileSync(path.join(PROJECT_TMP, '.write-test'), '1');
    fs.unlinkSync(path.join(PROJECT_TMP, '.write-test'));
  } catch {
    return null;
  }
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

// Lấy IP local bằng HTTPS thuần (không cần Playwright) — nhanh hơn ~15-20s
function fetchLocalIp(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.ipify.org/?format=json', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip); }
        catch { reject(new Error('Phản hồi IP không hợp lệ: ' + data.slice(0, 100))); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout lấy IP local')); });
    req.on('error', reject);
  });
}

// Lấy IP qua proxy bằng Playwright (cần thiết để xác minh browser dùng được proxy)
async function fetchIp(opts = {}) {
  ensureWritableTmp();
  const browser = await safeLaunch({
    headless: opts.headless !== false,
    timeout: 15000,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto('https://api.ipify.org/?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
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

  try {
    result.localIp = await fetchLocalIp(10000);
  } catch (e) {
    result.localIpError = e.message;
  }

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
