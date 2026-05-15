/**
 * Central LOCAL_API_KEY handling.
 *
 * - assertConfigured(): gọi ở startup các process verify auth (local-server,
 *   index.js của remote). Throw nếu env unset hoặc còn để 'change-this-secret-key'.
 * - verify(req): kiểm tra header x-api-key bằng timing-safe compare.
 */
const crypto = require('crypto');

const DEFAULT_PLACEHOLDER = 'change-this-secret-key';

function getKey() {
  return process.env.LOCAL_API_KEY || '';
}

function isDefaultOrEmpty(k) {
  return !k || k === DEFAULT_PLACEHOLDER;
}

function assertConfigured(processName = 'this server') {
  const k = getKey();
  if (isDefaultOrEmpty(k)) {
    throw new Error(
      `LOCAL_API_KEY chưa đặt (hoặc còn là '${DEFAULT_PLACEHOLDER}'). ` +
      `${processName} sẽ không khởi động vì auth không an toàn. ` +
      `Tạo key dài random (vd: openssl rand -hex 32) và set vào server/.env.`
    );
  }
}

function verify(req) {
  const expected = getKey();
  if (isDefaultOrEmpty(expected)) return false;
  const got = req.headers && req.headers['x-api-key'];
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { assertConfigured, verify, DEFAULT_PLACEHOLDER };
