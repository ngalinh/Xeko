const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const PERMISSIONS_FILE = path.resolve(__dirname, '../../config/user-permissions.json');
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
};
