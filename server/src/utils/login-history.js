const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.resolve(__dirname, '../../logs/login-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHistory(data) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

/**
 * Ghi 1 entry vao lich su
 * type: 'login' | 'session_check' | 'session_expired' | 'post_success' | 'post_error'
 */
function addEntry(profile, name, type, detail = '') {
  const history = loadHistory();
  history.unshift({
    time: new Date().toLocaleString('vi-VN'),
    timeISO: new Date().toISOString(),
    profile,
    name,
    type,
    detail,
  });
  // Giu toi da 200 entry
  if (history.length > 200) history.length = 200;
  saveHistory(history);
}

/**
 * Lay lich su, co the loc theo profile
 */
function getHistory(profileFilter = null, limit = 50) {
  const history = loadHistory();
  let filtered = history;
  if (profileFilter) {
    filtered = history.filter(h => h.profile === profileFilter);
  }
  return filtered.slice(0, limit);
}

module.exports = { addEntry, getHistory };
