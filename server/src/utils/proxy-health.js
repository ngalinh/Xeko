/**
 * Probe proxy có sống không, KHÔNG launch browser (~3s timeout).
 *
 * Cách hoạt động:
 *   - TCP connect tới host:port của proxy với timeout 3s.
 *   - Connect OK → proxy alive. Không verify auth/forwarding — chỉ phát hiện
 *     proxy chết / firewall block, vốn là failure mode phổ biến nhất.
 *
 * Cache 5 phút per host:port để không probe nhiều lần liên tiếp.
 * Khi cache hit ok=false, trả về retry hint thay vì re-probe ngay.
 */

const net = require('net');

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;

// Map<"host:port", { ok: boolean, error?: string, expireAt: number }>
const cache = new Map();

function parseHostPort(server) {
  if (!server) return null;
  const m = String(server).match(/^(?:[a-z]+:\/\/)?([^:/?#]+):(\d+)/i);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok ? { ok: true } : { ok: false, error: err });
    };
    const timer = setTimeout(() => finish(false, `TCP connect timeout (>${timeoutMs}ms)`), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      finish(false, e.code || e.message);
    });
  });
}

/**
 * @param {object|string} proxy - Playwright proxy object hoặc proxy string
 * @returns {Promise<{ok: boolean, error?: string, cached?: boolean}>}
 */
async function checkProxy(proxy) {
  if (!proxy) return { ok: true }; // không có proxy = không cần check
  const server = typeof proxy === 'string' ? proxy : proxy.server;
  const parsed = parseHostPort(server);
  if (!parsed) return { ok: false, error: `Proxy URL không parse được: "${server}"` };

  const key = `${parsed.host}:${parsed.port}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expireAt > now) {
    return { ...cached, cached: true };
  }

  const result = await tcpProbe(parsed.host, parsed.port);
  cache.set(key, { ...result, expireAt: now + CACHE_TTL_MS });
  return result;
}

function clearCache() {
  cache.clear();
}

module.exports = { checkProxy, clearCache, CACHE_TTL_MS, PROBE_TIMEOUT_MS };
