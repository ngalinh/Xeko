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

function classify(snapshot) {
  const result = { type: 'unknown', sellerUS: 'unknown', eligible: false, evidence: [] };
  if (snapshot.blocked) return { ...result, reason: snapshot.blocked };
  if (snapshot.pageEvidence) { result.type = 'page'; result.reason = 'Đây là Fanpage'; return result; }
  if (!snapshot.personalEvidence) return { ...result, reason: 'Chưa có dấu hiệu rõ đây là hồ sơ cá nhân' };
  result.type = 'personal';
  // A sales action and an explicit US-market signal must occur in the SAME post.
  // Currency, English language, residence and ethnicity alone do not qualify.
  const sales = /\b(order|orders|shop|buy|sale|selling|shipping|ships|wholesale|retail|in stock)\b|đặt hàng|chốt đơn|nhận đơn|bán hàng|còn hàng|sỉ|lẻ/iu;
  const us = /\b(ship(?:ping|s)?|deliver(?:y|ing)?|sell(?:ing)?)\s+(?:\w+\s+){0,3}(?:US|USA|United States)\b|\b(?:US|USA)\s+(?:shipping|delivery|customers|market)\b|giao (?:hàng )?(?:tại|ở|đến|toàn|nội địa) mỹ|ship (?:nội địa )?(?:mỹ|us|usa)\b|khách (?:hàng )?(?:mỹ|us)\b|thị trường (?:mỹ|us)\b/iu;
  result.evidence = (snapshot.posts || []).filter(p => typeof p === 'string' && sales.test(p) && us.test(p)).slice(0,3).map(p => p.slice(0,700));
  if (result.evidence.length) {
    result.sellerUS = 'likely'; result.eligible = true;
    result.reason = 'Có bài đăng bán hàng kèm dấu hiệu phục vụ thị trường Mỹ; đây là đánh giá theo nội dung nhìn thấy';
  } else result.reason = 'Chưa đủ bằng chứng bán hàng cho thị trường Mỹ';
  return result;
}

function renderMessage(template, name) {
  if (typeof template !== 'string' || !template.trim() || template.length > 2000) throw new Error('Tin nhắn cần từ 1 đến 2000 ký tự');
  if (/\{(?!name\})[^}]*\}/.test(template)) throw new Error('Chỉ hỗ trợ biến {name}; hãy điền sản phẩm và quyền lợi thật');
  return template.trim().replaceAll('{name}', () => String(name || 'bạn').slice(0,100));
}

module.exports = { validProfileKey, profileUrl, recipientId, classify, renderMessage };
