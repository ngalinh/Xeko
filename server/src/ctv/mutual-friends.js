const { profileUrl } = require('./rules');

function normalizeMutualFriendTarget(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Link tài khoản đối chiếu không hợp lệ');
  return value.trim() ? profileUrl(value.trim()) : '';
}

function unknownMutualFriend(targetUrl, reason = 'Chưa thấy đủ bằng chứng bạn bè chung với tài khoản đối chiếu.') {
  return { status: targetUrl ? 'unknown' : 'not_configured', targetUrl, reason: targetUrl ? reason : 'Chưa chọn tài khoản đối chiếu.', evidence: [] };
}

// Serialized into the page. Only visible header evidence is used; never infer a
// relationship from an image, a name, a post mention or the Add friend button.
function readMutualFriendEvidence({ targetUrl, profileName }) {
  const result = { status: 'unknown', targetUrl, reason: 'Chưa thấy đủ bằng chứng bạn bè chung với tài khoản đối chiếu.', evidence: [] };
  const excluded = 'article, [role="article"], [role="feed"], [role="dialog"], nav, [role="navigation"]';
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const canonical = value => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(u.hostname) || u.port || u.username || u.password) return '';
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return '';
      if (parts[0] === 'profile.php') return /^\d+$/.test(u.searchParams.get('id') || '') ? `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}` : '';
      if (/^\d+$/.test(parts[0])) return `https://www.facebook.com/profile.php?id=${parts[0]}`;
      return /^[a-z0-9.]+$/i.test(parts[0]) ? `https://www.facebook.com/${parts[0].toLowerCase()}` : '';
    } catch { return ''; }
  };
  const expected = canonical(targetUrl);
  if (!expected || canonical(location.href) === expected) {
    result.reason = 'Hồ sơ đang xem là tài khoản đối chiếu hoặc link đối chiếu không hợp lệ; không kết luận bạn bè chung.';
    return result;
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, [role="heading"], span[dir="auto"], div[dir="auto"]')];
  const heading = headings.find(e => visible(e) && !e.closest(excluded) && (e.innerText || '').trim() === profileName
    && (e.matches('h1, [role="heading"]') || parseFloat(getComputedStyle(e).fontSize) >= 24));
  if (!heading) return result;
  const title = heading.getBoundingClientRect();
  const tabs = [...document.querySelectorAll('[role="tab"], a')].filter(e => visible(e) && !e.closest(excluded)
    && /^(All|About|Posts|Tất cả|Giới thiệu|Bài viết)$/i.test((e.innerText || '').trim()) && e.getBoundingClientRect().top >= title.bottom);
  if (!tabs.length) return result;
  const bottom = Math.min(...tabs.map(e => e.getBoundingClientRect().top));
  const inHeader = e => {
    const box = e.getBoundingClientRect();
    return visible(e) && !e.closest(excluded) && box.top >= title.bottom && box.bottom <= bottom
      && box.left >= title.left - 24 && box.height > 0;
  };
  const mutualText = /^(?:\d[\d.,]*\s+)?(?:mutual friends?|bạn bè chung|bạn chung)$/iu;
  const markers = [...document.querySelectorAll('a, [role="button"], [aria-label], span')].filter(e => {
    if (!inHeader(e)) return false;
    const label = (e.getAttribute('aria-label') || e.innerText || '').trim();
    let mutualLink = false;
    try {
      const u = new URL(e.getAttribute('href'), location.href);
      mutualLink = ['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)
        && (u.searchParams.get('sk') === 'friends_mutual' || /\/friends_mutual\/?$/.test(u.pathname));
    } catch {}
    return mutualLink || (label.length <= 200 && mutualText.test(label));
  });
  const links = [...document.querySelectorAll('a[href]')].filter(e => inHeader(e) && canonical(e.href) === expected);
  for (const marker of markers) {
    // A compact row may wrap overlapping avatar links and a mutual-friends
    // label. Never climb into the whole header, bio, feed or navigation.
    for (let row = marker, depth = 0; row && depth < 4; row = row.parentElement, depth++) {
      if (!inHeader(row) || row.getBoundingClientRect().height > 100) break;
      if (row.querySelector('h1, h2, h3, [role="heading"], [role="tab"], article, [role="feed"]')) break;
      const markerBox = marker.getBoundingClientRect();
      const match = links.find(a => {
        const box = a.getBoundingClientRect();
        return row.contains(a) && box.bottom >= markerBox.top && box.top <= markerBox.bottom
          && (a.querySelector('img, svg image') || a === marker);
      });
      if (!match) continue;
      result.status = 'confirmed';
      result.reason = 'Đã thấy đúng liên kết tài khoản đối chiếu trong vùng bạn bè chung.';
      result.evidence = [{ profileUrl: targetUrl, label: (marker.getAttribute('aria-label') || marker.innerText || 'Bạn bè chung').trim().slice(0,200) }];
      return result;
    }
  }
  const avatars = [...document.querySelectorAll('a img, a svg image')].filter(inHeader);
  if (links.length || avatars.length) {
    result.status = 'needs_review';
    result.reason = links.length
      ? 'Thấy liên kết tài khoản đối chiếu nhưng chưa xác minh được thuộc vùng bạn bè chung.'
      : 'Có avatar nhỏ nhưng chưa xác minh được tài khoản đối chiếu; không kết luận theo ảnh.';
  }
  return result;
}

module.exports = { normalizeMutualFriendTarget, unknownMutualFriend, readMutualFriendEvidence };
