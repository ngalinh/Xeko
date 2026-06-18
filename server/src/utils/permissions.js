const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = process.env.XEKO_DATA_DIR
  ? path.resolve(process.env.XEKO_DATA_DIR)
  : path.resolve(__dirname, '../../..');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'data/user-permissions.json');
// Legacy path used before migration (was server/config/user-permissions.json)
const PERMISSIONS_FILE_LEGACY = path.join(path.resolve(__dirname, '../..'), 'config/user-permissions.json');
const SUPER_ADMIN_EMAIL = (process.env.XEKO_SUPER_ADMIN || 'tram@gmail.com').toLowerCase().trim();

function ensureFile() {
  const dir = path.dirname(PERMISSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PERMISSIONS_FILE)) {
    // Migrate from legacy path (server/config/) if it exists
    if (fs.existsSync(PERMISSIONS_FILE_LEGACY)) {
      try {
        fs.copyFileSync(PERMISSIONS_FILE_LEGACY, PERMISSIONS_FILE);
        logger.info(`permissions migrated from legacy path to ${PERMISSIONS_FILE}`);
        return;
      } catch (e) {
        logger.warn(`permissions migration failed: ${e.message}`);
      }
    }
    const initial = {
      users: {
        [SUPER_ADMIN_EMAIL]: {
          email: SUPER_ADMIN_EMAIL,
          isXekoAdmin: true,
          allProfiles: true,
          profiles: [],
          createdAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(initial, null, 2));
  }
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    if (!parsed.users[SUPER_ADMIN_EMAIL]) {
      parsed.users[SUPER_ADMIN_EMAIL] = {
        email: SUPER_ADMIN_EMAIL,
        isXekoAdmin: true,
        allProfiles: true,
        profiles: [],
        createdAt: new Date().toISOString(),
      };
      save(parsed);
    } else {
      // Only lock isXekoAdmin; let allProfiles + profiles[] be user-editable for super-admin.
      parsed.users[SUPER_ADMIN_EMAIL].isXekoAdmin = true;
    }
    return parsed;
  } catch (e) {
    logger.error(`permissions load error: ${e.message}`);
    return { users: {} };
  }
}

function save(data) {
  fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(data, null, 2));
}

let _getLocalUrl = null;
let _localApiKey = null;

function configureSync({ getLocalUrl, apiKey }) {
  _getLocalUrl = typeof getLocalUrl === 'function' ? getLocalUrl : null;
  _localApiKey = apiKey || null;
}

async function _fetchFn() {
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

async function syncToLocal(data) {
  if (!data) data = load();
  if (!_getLocalUrl) return;
  const url = _getLocalUrl();
  if (!url) return;
  try {
    const f = await _fetchFn();
    const res = await f(`${url}/api/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': _localApiKey || '' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      logger.warn(`permissions syncToLocal: HTTP ${res.status}`);
    }
  } catch (e) {
    logger.info(`permissions syncToLocal: LOCAL chưa sẵn sàng (${e.message})`);
  }
}

async function restoreFromLocal() {
  if (!_getLocalUrl) return false;
  const url = _getLocalUrl();
  if (!url) return false;
  try {
    const f = await _fetchFn();
    const res = await f(`${url}/api/permissions`, {
      headers: { 'x-api-key': _localApiKey || '' },
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      logger.warn(`permissions restoreFromLocal: HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.users) return false;
    save(data);
    logger.info(`permissions restored from LOCAL (${Object.keys(data.users).length} users)`);
    return true;
  } catch (e) {
    logger.info(`permissions restoreFromLocal: LOCAL chưa sẵn sàng (${e.message})`);
    return null; // null = network error (có thể retry), false = local up nhưng không có data
  }
}

// Gọi sau khi LOCAL register tunnel URL: kéo data từ LOCAL về (LOCAL là source of truth).
// Nếu LOCAL chưa có file (404) thì đẩy state hiện tại của REMOTE lên LOCAL để bootstrap.
// maxRetries > 0 dùng cho startup để retry khi local chưa kịp sẵn sàng.
async function syncOnRegister({ maxRetries = 0, retryDelay = 3000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logger.info(`permissions startup: thử lại lần ${attempt}/${maxRetries}...`);
      await new Promise(r => setTimeout(r, retryDelay * attempt));
    }
    const result = await restoreFromLocal();
    if (result === true) return;
    if (result === null && attempt < maxRetries) continue; // network error, retry
    await syncToLocal(load());
    return;
  }
}

function normalize(email) {
  return String(email || '').toLowerCase().trim();
}

function getUser(email) {
  const e = normalize(email);
  if (!e) return null;
  const data = load();
  return data.users[e] || null;
}

function hasAccess(email) {
  return !!getUser(email);
}

function isXekoAdmin(email) {
  const e = normalize(email);
  if (e === SUPER_ADMIN_EMAIL) return true;
  const u = getUser(e);
  return !!(u && u.isXekoAdmin);
}

function getAllowedProfileKeys(email) {
  const u = getUser(email);
  if (!u) return [];
  const e = normalize(email);
  // Super-admin: tôn trọng setting (allProfiles + profiles[]) để filter view.
  // Non-super admin: giữ bypass cũ — admin auto sees all (backwards-compat).
  if (u.allProfiles) return null;
  if (e !== SUPER_ADMIN_EMAIL && isXekoAdmin(email)) return null;
  return Array.isArray(u.profiles) ? u.profiles : [];
}

function filterProfiles(email, profiles) {
  if (!Array.isArray(profiles)) return [];
  const allowed = getAllowedProfileKeys(email);
  if (allowed === null) return profiles;
  const set = new Set(allowed);
  return profiles.filter(p => set.has(p.key));
}

function listUsers() {
  const data = load();
  return Object.values(data.users).sort((a, b) => {
    if (a.email === SUPER_ADMIN_EMAIL) return -1;
    if (b.email === SUPER_ADMIN_EMAIL) return 1;
    return (a.email || '').localeCompare(b.email || '');
  });
}

function upsertUser({ email, name, isXekoAdmin: admin, allProfiles, profiles, note }) {
  const e = normalize(email);
  if (!e) throw new Error('Email không hợp lệ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Email không hợp lệ');
  const data = load();
  const existing = data.users[e] || { email: e, createdAt: new Date().toISOString() };
  data.users[e] = {
    ...existing,
    email: e,
    name: typeof name === 'string' ? name.trim() : (existing.name || ''),
    isXekoAdmin: !!admin,
    allProfiles: !!allProfiles,
    profiles: Array.isArray(profiles) ? profiles : [],
    note: note || existing.note || '',
    updatedAt: new Date().toISOString(),
  };
  if (e === SUPER_ADMIN_EMAIL) {
    // Super-admin phải luôn là admin Xeko (không cho downgrade)
    data.users[e].isXekoAdmin = true;
    // allProfiles + profiles[] cho phép super-admin tự chỉnh để filter view
  } else {
    // Đánh dấu rằng file này đã từng có user thật (không chỉ seed super-admin).
    // Flag này giúp isEffectivelyEmpty() phân biệt "trống vì restart" vs
    // "trống vì admin vừa xoá user" — sau khi xoá, hasHadUsers vẫn true →
    // heartbeat sẽ PUSH lên LOCAL thay vì PULL về (tránh hoàn tác việc xoá).
    data.hasHadUsers = true;
  }
  save(data);
  syncToLocal(data).catch(() => {});
  return data.users[e];
}

function deleteUser(email) {
  const e = normalize(email);
  if (e === SUPER_ADMIN_EMAIL) {
    throw new Error('Không thể xoá super-admin');
  }
  const data = load();
  if (!data.users[e]) return false;
  delete data.users[e];
  save(data);
  syncToLocal(data).catch(() => {});
  return true;
}

function isSuperAdmin(email) {
  return normalize(email) === SUPER_ADMIN_EMAIL;
}

// REMOTE coi như "trống" khi chỉ còn super-admin được seed sẵn (chưa có user
// thật nào). Dùng để quyết định chiều sync ở mỗi heartbeat: trống → KÉO từ
// LOCAL về (hồi phục sau khi container restart); có data → ĐẨY lên LOCAL backup,
// KHÔNG ghi đè để tránh xoá phân quyền admin vừa chỉnh trên web.
//
// hasHadUsers=true phân biệt "trống do restart" (chưa bao giờ có user → PULL)
// với "trống do admin vừa xoá hết user" (đã có user rồi → PUSH, không restore).
function isEffectivelyEmpty() {
  const data = load();
  if (data.hasHadUsers) return false;
  const emails = Object.keys(data.users || {});
  if (emails.length === 0) return true;
  return emails.length === 1 && emails[0] === SUPER_ADMIN_EMAIL;
}

module.exports = {
  SUPER_ADMIN_EMAIL,
  load,
  getUser,
  hasAccess,
  isXekoAdmin,
  isSuperAdmin,
  isEffectivelyEmpty,
  getAllowedProfileKeys,
  filterProfiles,
  listUsers,
  upsertUser,
  deleteUser,
  configureSync,
  syncToLocal,
  restoreFromLocal,
  syncOnRegister,
};
