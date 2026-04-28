/**
 * Parse proxy string sang Playwright proxy object.
 *
 * Hỗ trợ các format:
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   http://host:port
 *   http://user:pass@host:port
 *   https://user:pass@host:port
 *   socks5://user:pass@host:port
 *
 * Hoặc nhận object có sẵn { server, username, password, bypass }.
 *
 * Trả về null nếu không có proxy hoặc parse fail (caller bỏ qua).
 */

const fs = require('fs');
const path = require('path');

function parseProxy(input) {
  if (!input) return null;

  if (typeof input === 'object') {
    if (!input.server) return null;
    return {
      server: input.server,
      username: input.username || undefined,
      password: input.password || undefined,
      bypass: input.bypass || undefined,
    };
  }

  let raw = String(input).trim();
  if (!raw) return null;

  let scheme = 'http';
  const schemeMatch = raw.match(/^(\w+):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    raw = raw.slice(schemeMatch[0].length);
  }

  // user:pass@host:port
  let user, pass, hostPort = raw;
  if (raw.includes('@')) {
    const [creds, rest] = raw.split('@');
    hostPort = rest;
    const colonIdx = creds.indexOf(':');
    if (colonIdx >= 0) {
      user = creds.slice(0, colonIdx);
      pass = creds.slice(colonIdx + 1);
    } else {
      user = creds;
    }
  } else {
    // host:port[:user:pass]
    const parts = raw.split(':');
    if (parts.length >= 4) {
      hostPort = `${parts[0]}:${parts[1]}`;
      user = parts[2];
      pass = parts.slice(3).join(':');
    } else {
      hostPort = raw;
    }
  }

  if (!hostPort.includes(':')) return null;
  return {
    server: `${scheme}://${hostPort}`,
    username: user || undefined,
    password: pass || undefined,
  };
}

function readMeta() {
  const metaFile = path.resolve(__dirname, '../../config/profiles-meta.json');
  try {
    if (fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {}
  return {};
}

function readZaloAccounts() {
  const zaloFile = path.resolve(__dirname, '../../config/zalo-accounts.json');
  try {
    if (fs.existsSync(zaloFile)) return JSON.parse(fs.readFileSync(zaloFile, 'utf8'));
  } catch {}
  return [];
}

/**
 * Lấy proxy cho 1 profile FB theo key (tra meta trước, fallback config tĩnh).
 */
function getFbProxyForProfile(profileKey, profileFromConfig = null) {
  const meta = readMeta();
  const proxy = (meta[profileKey] && meta[profileKey].proxy) || (profileFromConfig && profileFromConfig.proxy);
  return parseProxy(proxy);
}

/**
 * Lấy proxy cho 1 tài khoản Zalo theo key.
 */
function getZaloProxyForAccount(accountKey) {
  const accounts = readZaloAccounts();
  const acct = accounts.find(a => a.key === accountKey);
  return parseProxy(acct && acct.proxy);
}

/**
 * Trả về object launchOptions { proxy } để spread vào launchPersistentContext.
 * Nếu không có proxy hợp lệ, trả về {} (không thêm field proxy).
 */
function launchOptsFromProxy(proxyInput) {
  const proxy = parseProxy(proxyInput);
  return proxy ? { proxy } : {};
}

module.exports = {
  parseProxy,
  getFbProxyForProfile,
  getZaloProxyForAccount,
  launchOptsFromProxy,
};
