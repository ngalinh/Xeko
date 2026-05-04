const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = process.env.XEKO_DATA_DIR
  ? path.resolve(process.env.XEKO_DATA_DIR)
  : path.resolve(__dirname, '../..');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'config/user-permissions.json');
const SUPER_ADMIN_EMAIL = (process.env.XEKO_SUPER_ADMIN || 'tram@gmail.com').toLowerCase().trim();

function ensureFile() {
  const dir = path.dirname(PERMISSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PERMISSIONS_FILE)) {
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
      parsed.users[SUPER_ADMIN_EMAIL].isXekoAdmin = true;
      parsed.users[SUPER_ADMIN_EMAIL].allProfiles = true;
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
    logger.warn(`permissions syncToLocal: ${e.message}`);
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
    logger.warn(`permissions restoreFromLocal: ${e.message}`);
    return false;
  }
}

// Gọi sau khi LOCAL register tunnel URL: kéo data từ LOCAL về (LOCAL là source of truth).
// Nếu LOCAL chưa có file (404) thì đẩy state hiện tại của REMOTE lên LOCAL để bootstrap.
async function syncOnRegister() {
  const restored = await restoreFromLocal();
  if (!restored) {
    await syncToLocal(load());
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
  if (u.allProfiles || isXekoAdmin(email)) return null;
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
    data.users[e].isXekoAdmin = true;
    data.users[e].allProfiles = true;
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

module.exports = {
  SUPER_ADMIN_EMAIL,
  load,
  getUser,
  hasAccess,
  isXekoAdmin,
  isSuperAdmin,
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
