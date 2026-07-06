/**
 * In-memory rate limit per profile cho các endpoint post FB/Zalo.
 *
 * Mục đích: tránh post liên tục cùng 1 profile → bị FB/Zalo flag spam.
 *
 * Config qua env (tùy chọn):
 *   POST_MIN_INTERVAL_MS=30000   // tối thiểu 30s giữa 2 post cùng profile
 *   POST_HOURLY_LIMIT=40         // tối đa 40 post/giờ cho 1 profile
 *
 * Lưu trong RAM — restart server reset. Acceptable vì FB/Zalo cũng không
 * nhớ hành vi qua restart từ phía mình; mục tiêu là chặn burst trong 1 phiên.
 */

const MIN_INTERVAL_MS = Number(process.env.POST_MIN_INTERVAL_MS || 30_000);
const HOURLY_LIMIT = Number(process.env.POST_HOURLY_LIMIT || 40);
const HOUR_MS = 60 * 60 * 1000;

// Map<profileKey, { last: number, timestamps: number[] }>
const state = new Map();

function pruneOld(timestamps, now) {
  const cutoff = now - HOUR_MS;
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

/**
 * @param {string} profileKey - cái gì cũng được, miễn unique per FB/Zalo account
 * @returns {{ ok: true } | { ok: false, retryAfterMs: number, reason: string }}
 */
function check(profileKey) {
  const key = profileKey || '_default';
  const now = Date.now();
  let entry = state.get(key);
  if (!entry) {
    entry = { last: 0, timestamps: [] };
    state.set(key, entry);
  }
  pruneOld(entry.timestamps, now);

  const sinceLast = now - entry.last;
  if (sinceLast < MIN_INTERVAL_MS) {
    return {
      ok: false,
      retryAfterMs: MIN_INTERVAL_MS - sinceLast,
      reason: `Quá nhanh — đợi ${Math.ceil((MIN_INTERVAL_MS - sinceLast) / 1000)}s rồi thử lại (tối thiểu ${MIN_INTERVAL_MS / 1000}s giữa 2 post).`,
    };
  }
  if (entry.timestamps.length >= HOURLY_LIMIT) {
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + HOUR_MS - now;
    return {
      ok: false,
      retryAfterMs,
      reason: `Đã post ${entry.timestamps.length} lần trong 1h (limit ${HOURLY_LIMIT}). Đợi ${Math.ceil(retryAfterMs / 60000)} phút.`,
    };
  }

  entry.last = now;
  entry.timestamps.push(now);
  return { ok: true };
}

/**
 * Chỉ kiểm tra giới hạn theo giờ (bỏ qua min-interval). Dùng cho luồng đăng
 * nhiều group cùng 1 account: min-interval đã được xử lý bằng queue tự giãn cách
 * (xem zalo-queue.js), nên ở đây chỉ cần chặn spam dài hạn theo giờ.
 *
 * @param {string} profileKey
 * @returns {{ ok: true } | { ok: false, retryAfterMs: number, reason: string }}
 */
function checkHourly(profileKey) {
  const key = profileKey || '_default';
  const now = Date.now();
  let entry = state.get(key);
  if (!entry) {
    entry = { last: 0, timestamps: [] };
    state.set(key, entry);
  }
  pruneOld(entry.timestamps, now);

  if (entry.timestamps.length >= HOURLY_LIMIT) {
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + HOUR_MS - now;
    return {
      ok: false,
      retryAfterMs,
      reason: `Đã post ${entry.timestamps.length} lần trong 1h (limit ${HOURLY_LIMIT}). Đợi ${Math.ceil(retryAfterMs / 60000)} phút.`,
    };
  }

  entry.timestamps.push(now);
  return { ok: true };
}

/**
 * Express middleware factory. profileFromReq(req) phải trả về string key
 * (lấy từ body, params, hoặc state). Trả null/undefined → dùng '_default'.
 */
function middleware(profileFromReq) {
  return (req, res, next) => {
    const key = profileFromReq(req);
    const result = check(key);
    if (!result.ok) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
      return res.status(429).json({ error: result.reason, retryAfterMs: result.retryAfterMs });
    }
    next();
  };
}

module.exports = { check, checkHourly, middleware, MIN_INTERVAL_MS, HOURLY_LIMIT };
