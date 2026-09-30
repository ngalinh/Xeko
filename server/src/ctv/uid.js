const { profileUrl, recipientId } = require('./rules');

// Only accept IDs explicitly attached to the requested profile URL. A raw
// userID/profile_id match can belong to the viewer, a commenter or a friend.
function identifyProfile({ target, actualUrl, scripts = [], messageLinks = [], blocked = '' }) {
  const unresolved = reason => ({ recipientId: null, uidStatus: 'unresolved', uidReason: reason });
  if (blocked) return unresolved(blocked);
  target = profileUrl(target);
  if (profileUrl(actualUrl) !== target) return unresolved('Link chuyển sang hồ sơ khác; cần kiểm tra lại link');
  const ids = new Map();
  const add = (id, source) => { if (typeof id === 'string' && /^\d+$/.test(id)) ids.set(id, source); };
  add(recipientId(target), 'profile_url');
  const matches = value => {
    try { return typeof value === 'string' && profileUrl(value) === target; } catch { return false; }
  };
  let visited = 0;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 60 || ++visited > 100000) return;
    if (node.__typename === 'User' && (matches(node.url) || matches(node.profile_url))) {
      add(node.id, 'profile_data');
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  for (const text of scripts) {
    // Never execute script contents, and never round numeric IDs through Number.
    if (typeof text !== 'string' || text.length > 5000000) continue;
    try { walk(JSON.parse(text)); } catch {}
  }
  for (const value of messageLinks) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.port || u.username || u.password
        || !['facebook.com','www.facebook.com','messenger.com','www.messenger.com'].includes(u.hostname)) continue;
      const match = u.pathname.match(/^\/(?:messages\/)?t\/(\d+)\/?$/);
      if (match) add(match[1], 'profile_message_link');
    } catch {}
  }
  if (ids.size !== 1) return unresolved(ids.size ? 'Có nhiều UID mâu thuẫn; chưa xác định được đúng người nhận' : 'Chưa tìm thấy UID gắn với đúng link hồ sơ');
  const [id, source] = [...ids][0];
  return { recipientId: id, uidStatus: 'resolved', uidSource: source, uidReason: '' };
}

async function resolveCurrentProfileUid(page, target, snapshot) {
  const scripts = snapshot.blocked ? [] : await page.evaluate(() => {
    let remaining = 10000000;
    return [...document.querySelectorAll('script[type="application/json"]')].flatMap(e => {
      const text = e.textContent || '';
      if (text.length > 5000000 || text.length > remaining) return [];
      remaining -= text.length;
      return [text];
    });
  });
  return identifyProfile({ target, actualUrl: page.url(), scripts: Array.isArray(scripts) ? scripts : [],
    messageLinks: snapshot.messageLinks || [], blocked: snapshot.blocked });
}

module.exports = { identifyProfile, resolveCurrentProfileUid };
