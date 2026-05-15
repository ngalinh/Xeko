/**
 * Sinh device fingerprint (userAgent + viewport) per profile.
 *
 * Mục tiêu: mỗi FB/Zalo profile có 1 cặp UA+viewport cố định riêng, giảm rủi
 * ro FB nhận ra "N account cùng device". Cố định = đọc/ghi vào profiles-meta.json
 * lần đầu, lần sau dùng lại. Nếu profile chưa có → chọn deterministic theo
 * hash của key để stable qua restart.
 *
 * Profile meta schema (chỉ field liên quan):
 *   {
 *     "<key>": {
 *       ...,
 *       "userAgent": "Mozilla/5.0 ...",
 *       "viewport": { "width": 1366, "height": 768 }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const META_FILE = path.resolve(__dirname, '../../config/profiles-meta.json');

// Pool UA: vài Chrome version trên Windows/Mac phổ biến. Đừng quá nhiều, FB
// chỉ cần thấy device không trùng nhau là đủ.
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// Pool viewport: kích thước thường gặp trên desktop. Tránh kích thước quá lạ.
const VIEWPORT_POOL = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

function hashIndex(key, modulo) {
  if (!key) return 0;
  const h = crypto.createHash('md5').update(String(key)).digest();
  return h.readUInt32BE(0) % modulo;
}

function pickDefault(key) {
  return {
    userAgent: UA_POOL[hashIndex(key + ':ua', UA_POOL.length)],
    viewport: VIEWPORT_POOL[hashIndex(key + ':vp', VIEWPORT_POOL.length)],
  };
}

function readMeta() {
  try {
    if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {}
  return {};
}

function writeMeta(meta) {
  try {
    const dir = path.dirname(META_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  } catch {}
}

/**
 * Lấy { userAgent, viewport } cho profile key. Nếu meta chưa lưu, tự generate
 * deterministic theo hash(key) và persist để lần sau ổn định.
 *
 * Nhận key bất kỳ (FB key, Zalo key, salework key — không trùng nhau giữa các
 * pool vì FB key và Zalo key cùng namespace thì luôn khác chuỗi). Caller nên
 * truyền cùng key qua các lần gọi để có cùng fingerprint.
 *
 * @param {string} key
 * @returns {{ userAgent: string, viewport: { width: number, height: number } }}
 */
function getProfileDeviceFingerprint(key) {
  const meta = readMeta();
  const entry = meta[key] || {};
  const defaults = pickDefault(key);

  const userAgent = entry.userAgent || defaults.userAgent;
  const viewport =
    entry.viewport && typeof entry.viewport.width === 'number' && typeof entry.viewport.height === 'number'
      ? entry.viewport
      : defaults.viewport;

  // Persist nếu thiếu — chỉ ghi khi key đã tồn tại trong meta (không tạo entry
  // mới rỗng). Mục đích: profile mới sẽ được tạo entry ở các flow khác (add
  // account), lúc đó đã có name/proxy/etc. — fingerprint vô thêm sau là OK.
  if (entry && (entry.name || entry.proxy || entry.email)) {
    let changed = false;
    if (!entry.userAgent) { entry.userAgent = userAgent; changed = true; }
    if (!entry.viewport) { entry.viewport = viewport; changed = true; }
    if (changed) {
      meta[key] = entry;
      writeMeta(meta);
    }
  }

  return { userAgent, viewport };
}

module.exports = {
  getProfileDeviceFingerprint,
  UA_POOL,
  VIEWPORT_POOL,
};
