// Profile keys are existing directory names, including Vietnamese and spaces.
// Preserve the exact key while rejecting path separators and special entries.
function validProfileKey(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= 255
    && value !== '.' && value !== '..'
    && !/[\/\\\x00-\x1f\x7f]/.test(value);
}

const RESERVED = new Set(['groups', 'pages', 'watch', 'reel', 'reels', 'marketplace', 'share', 'stories', 'events', 'login', 'checkpoint', 'messages', 'me', 'settings', 'photo.php', 'permalink.php', 'story.php']);

function profileUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Link Facebook không hợp lệ'); }
  if (u.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(u.hostname) || u.port || u.username || u.password) throw new Error('Chỉ nhận link https://facebook.com của hồ sơ');
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'profile.php' && parts.length === 1 && /^\d+$/.test(u.searchParams.get('id') || '')) return `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}`;
  if (parts.length !== 1 || parts[0] === 'profile.php' || RESERVED.has(parts[0].toLowerCase()) || !/^[a-zA-Z0-9.]+$/.test(parts[0])) throw new Error('Cần link hồ sơ, không phải link bài viết, nhóm hoặc link chia sẻ');
  return `https://www.facebook.com/${parts[0].toLowerCase()}`;
}

function recipientId(value) {
  const u = new URL(profileUrl(value));
  const id = u.searchParams.get('id') || u.pathname.slice(1);
  return /^\d+$/.test(id) ? id : null;
}

function isSalesPost(text) {
  return typeof text === 'string' && /\b(order|orders|shop|buy|sale|selling|wholesale|retail|in stock)\b|đặt hàng|chốt đơn|nhận đơn|bán|còn hàng|sỉ|lẻ|giá|mua|sale/iu.test(text);
}

function classify(snapshot) {
  const result = { type: 'unknown', sellerUS: 'unknown', eligible: false, evidence: [] };
  if (snapshot.blocked) return { ...result, reason: snapshot.blocked };
  if (snapshot.pageEvidence) { result.type = 'page'; result.reason = 'Đây là Fanpage'; return result; }
  if (!snapshot.personalEvidence) return { ...result, reason: 'Chưa có dấu hiệu rõ đây là hồ sơ cá nhân' };
  result.type = 'personal';
  const posts = [...new Set((snapshot.posts || []).filter(p => typeof p === 'string' && isSalesPost(p)))];
  result.evidence = posts.slice(0,5).map(p => p.slice(0,700));
  // Website/product matching is semantic and belongs to the grounded AI review.
  // Never use buyer location, shipping destination or currency as a gate.
  result.eligible = posts.length >= 3;
  result.reason = result.eligible
    ? 'Đã đọc ít nhất 3 bài bán hàng; cần AI đối chiếu sản phẩm có bán trên website Mỹ'
    : `Chưa đủ dữ liệu: chỉ đọc được ${posts.length}/3 bài bán hàng; cần kiểm tra thêm`;

  return result;
}

function renderMessage(template, name) {
  if (typeof template !== 'string' || !template.trim() || template.length > 2000) throw new Error('Tin nhắn cần từ 1 đến 2000 ký tự');
  if (/\{(?!name\})[^}]*\}/.test(template)) throw new Error('Chỉ hỗ trợ biến {name}; hãy điền sản phẩm và quyền lợi thật');
  return template.trim().replaceAll('{name}', () => String(name || 'bạn').slice(0,100));
}

module.exports = { validProfileKey, profileUrl, recipientId, isSalesPost, classify, renderMessage };
