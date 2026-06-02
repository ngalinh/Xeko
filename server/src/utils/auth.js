const crypto = require('crypto');
const logger = require('./logger');

const BASSO_AUTH_URL = process.env.BASSO_AUTH_URL || 'https://ai.basso.vn/platform/api/auth/session';
const CACHE_TTL_MS = 30 * 1000;

const sessionCache = new Map();

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

function hashCookie(cookie) {
  return crypto.createHash('sha256').update(cookie).digest('hex');
}

async function verifyBassoSession(cookieHeader) {
  if (!cookieHeader) return null;

  const key = hashCookie(cookieHeader);
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  // Prefix ngắn của hash cookie để correlate các log của cùng 1 phiên mà
  // không lộ cookie thật. Giúp phân biệt "văng thật" vs "văng oan" trong log.
  const tag = key.slice(0, 8);
  const startedAt = Date.now();

  try {
    const fetchFn = await getFetch();
    const response = await fetchFn(BASSO_AUTH_URL, {
      method: 'GET',
      headers: { Cookie: cookieHeader, Accept: 'application/json' },
    });
    const elapsed = Date.now() - startedAt;
    const data = await response.json().catch(() => ({}));

    if (!data || data.success !== true || !data.user || !data.user.username) {
      // Ghi rõ LÝ DO văng để chẩn đoán:
      //  - non-2xx  → cookie hết hạn thật / Basso từ chối
      //  - success!=true → Basso báo phiên không hợp lệ
      //  - thiếu user/username → có thể Basso đổi format response (văng oan)
      let reason;
      if (!response.ok) {
        reason = `HTTP ${response.status}`;
      } else if (data && data.success !== true) {
        reason = `success=${JSON.stringify(data.success)}`;
      } else if (!data || !data.user) {
        reason = 'thiếu data.user';
      } else {
        reason = `thiếu user.username (keys: ${Object.keys(data.user).join(',') || 'none'})`;
      }
      logger.warn(`verifyBassoSession FAIL [${tag}] ${reason} (${elapsed}ms)`);
      sessionCache.set(key, { user: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const user = {
      email: String(data.user.username).toLowerCase().trim(),
      roles: Array.isArray(data.user.roles) ? data.user.roles : [],
      raw: data.user,
    };
    if (elapsed > 3000) {
      logger.warn(`verifyBassoSession OK nhưng CHẬM [${tag}] ${user.email} (${elapsed}ms)`);
    }
    sessionCache.set(key, { user, expiresAt: Date.now() + CACHE_TTL_MS });
    return user;
  } catch (e) {
    // Lỗi mạng/timeout khi gọi Basso → văng oan do hạ tầng, không phải hết hạn.
    const elapsed = Date.now() - startedAt;
    logger.error(`verifyBassoSession NETWORK ERROR [${tag}] ${e.message} (${elapsed}ms)`);
    return null;
  }
}

function requireAuth(permissions) {
  return async (req, res, next) => {
    const cookie = req.headers.cookie || '';
    const user = await verifyBassoSession(cookie);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 'NOT_LOGGED_IN' });
    }
    req.user = user;
    req.user.isXekoAdmin = permissions.isXekoAdmin(user.email);
    if (!permissions.hasAccess(user.email)) {
      return res.status(403).json({
        success: false,
        error: 'Bạn chưa được phân quyền sử dụng Xeko. Liên hệ admin để được cấp quyền.',
        code: 'NO_XEKO_ACCESS',
        email: user.email,
      });
    }
    next();
  };
}

function requireAdmin() {
  return (req, res, next) => {
    if (!req.user || !req.user.isXekoAdmin) {
      return res.status(403).json({ success: false, error: 'Chỉ admin Xeko mới có quyền này' });
    }
    next();
  };
}

module.exports = { verifyBassoSession, requireAuth, requireAdmin };
