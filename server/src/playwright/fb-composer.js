'use strict';
const { randomUUID } = require('crypto');

// Pin the smallest visible post surface containing its title and controls.
// Never use a document-wide textbox: Messenger and comments can remain open.
function findPostSurface({ token, requireEditor }) {
  const visible = el => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const title = /^(Tạo bài viết|Create post|Create a post|Cài đặt bài viết|Post settings)$|bạn đang nghĩ gì thế|on your mind/i;
  const editors = root => [...root.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  const buttons = root => [...root.querySelectorAll('button, [role="button"]')].filter(el =>
    visible(el) && /^(Đăng|Post|Tiếp|Next)$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()));
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],span')]
    .filter(h => visible(h) && title.test((h.textContent || '').trim()));

  const candidates = [];
  for (const heading of headings) {
    for (let root = heading.parentElement; root && root !== document.body; root = root.parentElement) {
      const count = editors(root).length;
      if (buttons(root).length && (requireEditor ? count === 1 : count <= 1)) {
        candidates.push(root);
        break;
      }
      if (root.matches('[role="dialog"],[aria-modal="true"],[role="main"],main')) break;
    }
  }
  let unique = [...new Set(candidates)].filter(root =>
    !candidates.some(other => other !== root && root.contains(other)));

  // Composer full-page (không nằm trong dialog riêng) có thể lẫn với một ô nhập
  // không liên quan (vd ô comment của bài khác) cùng nằm trong role="main" —
  // phép đếm editor ở trên luôn >1 trước khi chạm biên nên không root nào qua
  // được điều kiện chặt (candidates rỗng). Fallback: neo theo editor GẦN
  // heading nhất (khoảng cách DOM), bỏ qua các editor khác trong root.
  if (unique.length === 0 && headings.length) {
    const domDistance = (a, b) => {
      const depthB = new Map();
      let n = b, d = 0;
      for (; n; n = n.parentElement, d++) depthB.set(n, d);
      let i = 0;
      for (let m = a; m; m = m.parentElement, i++) {
        const hit = depthB.get(m);
        if (hit !== undefined) return i + hit;
      }
      return Infinity;
    };
    const docEditors = editors(document.body);
    for (const heading of headings) {
      let nearest = null, bestDist = Infinity;
      for (const ed of docEditors) {
        const d = domDistance(heading, ed);
        if (d < bestDist) { bestDist = d; nearest = ed; }
      }
      if (!nearest) continue;
      for (let root = nearest; root && root !== document.body; root = root.parentElement) {
        if (buttons(root).length) { candidates.push(root); break; }
        if (root.matches('[role="dialog"],[aria-modal="true"],[role="main"],main')) break;
      }
    }
    unique = [...new Set(candidates)].filter(root =>
      !candidates.some(other => other !== root && root.contains(other)));
  }

  if (unique.length !== 1) return false;
  unique[0].setAttribute('data-xeko-post-surface', token);
  return true;
}
const surfaceTokens = new WeakMap();
async function resolvePostSurface(page, { requireEditor = true, timeout = 10000 } = {}) {
  const token = surfaceTokens.get(page) || randomUUID();
  surfaceTokens.set(page, token);
  await page.waitForFunction(findPostSurface, { token, requireEditor }, { timeout });
  return page.locator('[data-xeko-post-surface="' + token + '"]');
}
// Chạy LẠI đúng logic findPostSurface nhưng trả về vết đi-lên (walk trace) thay vì
// boolean — dùng khi resolvePostSurface fail, để biết chính xác dừng ở đâu
// (không có heading nào khớp tiêu đề, hay có khớp nhưng không tìm được root hợp lệ,
// hay tìm được NHIỀU root hợp lệ khác nhau → ambiguous).
function diagnosePostSurface() {
  const visible = el => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const title = /^(Tạo bài viết|Create post|Create a post|Cài đặt bài viết|Post settings)$|bạn đang nghĩ gì thế|on your mind/i;
  const editors = root => [...root.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  const buttons = root => [...root.querySelectorAll('button, [role="button"]')].filter(el =>
    visible(el) && /^(Đăng|Post|Tiếp|Next)$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()));
  const describe = el => el.tagName +
    (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '') +
    (el.getAttribute('aria-label') ? ` aria-label="${el.getAttribute('aria-label').slice(0, 40)}"` : '');
  const out = [];
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,[role="heading"],span')) {
    const text = (heading.textContent || '').trim();
    if (!visible(heading) || !title.test(text)) continue;
    const trace = [];
    let qualified = null;
    for (let root = heading.parentElement; root && root !== document.body; root = root.parentElement) {
      const eCount = editors(root).length;
      const bCount = buttons(root).length;
      trace.push(`${describe(root)} editors=${eCount} buttons=${bCount}`);
      if (bCount && eCount <= 1) { qualified = describe(root); break; }
      if (root.matches('[role="dialog"],[aria-modal="true"],[role="main"],main')) {
        trace.push('STOP: hit dialog/main boundary trước khi tìm được root hợp lệ');
        break;
      }
    }
    out.push({ headingText: text.slice(0, 60), headingTag: describe(heading), qualified, trace: trace.slice(0, 12) });
  }
  return out;
}
module.exports = { findPostSurface, resolvePostSurface, diagnosePostSurface };
