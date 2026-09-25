const { validProfileKey, profileUrl, recipientId, isSalesPost } = require('./rules');
const { evaluateProfile } = require('./ai');

async function assertSession(page) {
  if (/\/(login|checkpoint|challenge|two_step_verification)(?:[/?]|$)/i.test(new URL(page.url()).pathname) || await page.locator('input[type="password"]').count()) throw new Error('Cần đăng nhập hoặc xử lý checkpoint trong Quản lý tài khoản');
}

// Runs inside the page, both while waiting and when collecting the snapshot.
function readProfileSnapshot() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const roots = [...document.querySelectorAll('[role="main"], main, #content, #m_basic')].filter(visible);
  for (const main of roots) {
    const text = main.innerText || '';
    const blocked = /locked (?:their |this )?profile|đã khóa trang cá nhân|nội dung này hiện không|content isn't available/i.test(text) ? 'Hồ sơ bị khóa hoặc không xem được' : '';
    const headings = [...main.querySelectorAll('h1, [role="heading"][aria-level="1"], h2, [role="heading"][aria-level="2"]')]
      .filter(e => visible(e) && !e.closest('[role="article"], article, [role="dialog"], [role="navigation"], nav'));
    const heading = headings.find(e => e.matches('h1, [aria-level="1"]') && e.innerText.trim())
      || headings.find(e => e.innerText.trim());
    const name = heading?.innerText.trim() || '';
    const controls = [...main.querySelectorAll('[role="button"], button, a')].filter(visible)
      .map(e => (e.getAttribute('aria-label') || e.innerText || '').trim());
    const personalEvidence = controls.some(t => /^(Add friend|Friends|Cancel request|Thêm bạn bè|Bạn bè|Hủy lời mời)$/i.test(t));
    const pageEvidence = /Page transparency|Tính minh bạch của Trang|Độ minh bạch của Trang/i.test(text);
    // Secondary headings alone may be feed/navigation titles, not profile names.
    if (!blocked && (!name || (!heading.matches('h1, [aria-level="1"]') && !personalEvidence && !pageEvidence))) continue;
    const intro = main.cloneNode(true);
    intro.querySelectorAll('[role="article"], article, [role="feed"], [role="navigation"], nav').forEach(e => e.remove());
    return {
      bio: (intro.innerText || intro.textContent || '').trim().slice(0,8000),
      name, blocked, pageEvidence, personalEvidence,
      posts: [...main.querySelectorAll('[role="article"], article')].filter(visible).slice(0,10).map(e => e.innerText.slice(0,6000)),
      messageLinks: [...main.querySelectorAll('a[href]')].filter(visible).filter(e => /^(Message|Nhắn tin)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())).map(e => e.href),
    };
  }
  return false;
}

// Read caption and image pixels before virtualized feed entries disappear.
async function readPostMedia(page) {
  const articles = page.locator(':is([role="main"], main, #content, #m_basic) :is([role="article"], article)');
  const records = [];
  for (let i = 0, count = Math.min(await articles.count(), 10); i < count; i++) {
    const article = articles.nth(i);
    if (!await article.isVisible()) continue;
    const more = article.getByRole('button', { name: /^(Xem thêm|See more)$/i });
    for (let j = 0, n = Math.min(await more.count(), 3); j < n; j++) {
      try { await more.nth(j).click({ timeout: 1000 }); } catch {}
    }
    const caption = await article.evaluate(e => {
      const bodies = [...e.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')];
      return (bodies.length ? bodies.map(b => b.innerText || '').join('\n') : e.innerText || '').trim().slice(0,6000);
    });
    const images = [];
    const candidates = article.locator('img');
    for (let j = 0, n = Math.min(await candidates.count(), 12); j < n && images.length < 2; j++) {
      const img = candidates.nth(j);
      try {
        const usable = await img.evaluate(e => e.complete && e.naturalWidth >= 150 && e.naturalHeight >= 150 && e.getBoundingClientRect().width >= 120 && e.getBoundingClientRect().height >= 120);
        if (!usable || !await img.isVisible()) continue;
        const bytes = await img.screenshot({ type: 'jpeg', quality: 65, timeout: 2500 });
        if (bytes.length <= 750000) images.push({ mimeType: 'image/jpeg', data: bytes.toString('base64') });
      } catch {} // A missing image must not discard the caption.
    }
    if (caption || images.length) records.push({ caption, images });
  }
  return records;
}

// Collect across scrolls because Facebook may virtualize older feed entries.
async function collectProfilePosts(page, snapshot) {
  const posts = new Map();
  for (let step = 0; step <= 12; step++) {
    await assertSession(page);
    const batch = await readPostMedia(page);
    for (const post of batch) {
      if (!isSalesPost(post.caption) && !post.images.length) continue;
      const key = post.caption || post.images[0].data;
      if (!posts.has(key) && posts.size >= 20 && isSalesPost(post.caption)) {
        const supplementary = [...posts].find(([, value]) => !isSalesPost(value.caption));
        if (supplementary) posts.delete(supplementary[0]);
      }
      if ((!posts.has(key) && posts.size < 20) || (posts.has(key) && posts.get(key).images.length < post.images.length)) posts.set(key, post);
    }
    if ([...posts.values()].filter(p => isSalesPost(p.caption)).length >= 5 || step === 12) break;
    await page.evaluate(() => {
      const articles = [...document.querySelectorAll(':is([role="main"], main, #content, #m_basic) :is([role="article"], article)')];
      articles.at(-1)?.scrollIntoView({ block: 'end' });
      window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
    });
    await page.waitForTimeout(1500);
  }
  const selected = [...posts.values()].sort((a,b) => Number(isSalesPost(b.caption)) - Number(isSalesPost(a.caption))).slice(0,5);
  return { ...snapshot, posts: selected.map(p => p.caption), postMedia: selected };
}

async function inspect(page, url) {
  const target = profileUrl(url);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  let handle;
  let snapshot;
  try {
    handle = await page.waitForFunction(readProfileSnapshot, null, { timeout: 30000 });
    snapshot = await handle.jsonValue();
  } catch (error) {
    await assertSession(page);
    if (error.name !== 'TimeoutError') throw error;
    throw new Error('Không đọc được tên hồ sơ Facebook sau 30 giây. Trang có thể chưa tải xong hoặc dùng bố cục chưa được hỗ trợ; hãy kiểm tra hồ sơ trong Quản lý tài khoản.');
  } finally {
    if (handle) await handle.dispose();
  }
  await assertSession(page);
  const actual = profileUrl(page.url());
  if (actual !== target) throw new Error('Link chuyển sang hồ sơ khác; hãy kiểm tra và nhập lại link chính xác');
  if (!snapshot.blocked) snapshot = await collectProfilePosts(page, snapshot);
  if (profileUrl(page.url()) !== target) throw new Error('Link chuyển sang hồ sơ khác khi đọc bài viết');
  const ids = new Set();
  const directId = recipientId(actual);
  if (directId) ids.add(directId);
  for (const link of snapshot.messageLinks) {
    try {
      const u = new URL(link);
      if (u.protocol !== 'https:' || !['www.facebook.com','facebook.com','www.messenger.com','messenger.com'].includes(u.hostname)) continue;
      const match = u.pathname.match(/^\/(?:messages\/)?t\/(\d+)\/?$/);
      if (match) ids.add(match[1]);
    } catch {}
  }
  return { url: target, actualUrl: actual, name: snapshot.name, recipientId: ids.size === 1 ? [...ids][0] : null, checkedAt: new Date().toISOString(), ...await evaluateProfile(snapshot) };
}

async function send(page, lead, message, beforeSubmit, cancelled) {
  if (!/^\d+$/.test(lead.recipientId || '')) throw new Error('Không xác minh được ID người nhận; cần kiểm tra thủ công');
  const id = lead.recipientId;
  await page.goto(`https://www.facebook.com/messages/t/${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  const box = page.locator('[role="main"] [contenteditable="true"][role="textbox"][aria-label="Message"], [role="main"] [contenteditable="true"][role="textbox"][aria-label="Tin nhắn"]');
  await box.first().waitFor({ state: 'visible', timeout: 15000 });
  if (await box.count() !== 1) throw new Error('Không xác định được duy nhất ô soạn của hội thoại');
  const verify = async () => {
    const u = new URL(page.url());
    if (u.hostname !== 'www.facebook.com' || u.pathname.replace(/\/$/,'') !== `/messages/t/${id}`) throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    // Require a profile link in the conversation header, excluding message history.
    const links = await page.locator('[role="main"] [role="banner"] a[href], [role="main"] h1 a[href], [role="main"] h2 a[href]').evaluateAll(es => es.map(e => e.href));
    if (!links.some(link => { try { return recipientId(link) === id || profileUrl(link) === lead.actualUrl; } catch { return false; } })) throw new Error('Không xác minh được hồ sơ ở tiêu đề hội thoại; đã dừng');
  };
  await verify();
  if ((await box.innerText()).trim()) throw new Error('Hội thoại có bản nháp đang soạn; cần xử lý thủ công');
  await box.fill(message);
  if ((await box.innerText()).trim() !== message.trim()) throw new Error('Nội dung trong ô soạn không khớp mẫu');
  await verify();
  const confirmedCount = () => page.locator('[role="main"] [role="row"]').evaluateAll((rows, text) => rows.filter(row => {
    const exact = [...row.querySelectorAll('[dir="auto"]')].some(e => e.textContent.trim() === text);
    const receipt = [...row.querySelectorAll('[aria-label]')].some(e => /^(Sent|Delivered|Đã gửi|Đã chuyển|Đã nhận)$/i.test(e.getAttribute('aria-label') || ''));
    return exact && receipt;
  }).length, message.trim());
  const beforeCount = await confirmedCount();
  if (cancelled()) { await box.fill(''); throw new Error('Đã dừng trước khi gửi'); }
  // Durable reservation BEFORE Enter. Never automatically retry an ambiguous send.
  beforeSubmit();
  await box.press('Enter');
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if (await confirmedCount() > beforeCount) return { state: 'sent', reason: 'Messenger hiển thị trạng thái đã gửi/đã chuyển cho tin nhắn mới' };
  }
  // DOM receipts differ across Messenger variants: uncertainty must remain explicit.
  return { state: 'unconfirmed', reason: 'Đã thao tác gửi; cần kiểm tra Messenger để xác nhận. Không tự gửi lại.' };
}

function createBrowserAdapter(playwright = require('../playwright/post')) {
  const inspectionPages = new Map();
  return {
    async withPage(profile, callback, { keepOpen = false } = {}) {
      if (!validProfileKey(profile) || !playwright.profileExists(profile)) throw new Error('Tài khoản Facebook không tồn tại');
      const browser = await playwright.getBrowser(profile);
      let page = keepOpen ? inspectionPages.get(profile) : null;
      if (!page || page.isClosed() || page.context() !== browser) {
        page = await browser.newPage();
        if (keepOpen) inspectionPages.set(profile, page);
      }
      try { return await callback(page); } finally {
        if (!keepOpen) await page.close().catch(() => {});
      }
    },
    inspect, send,
  };
}
module.exports = { createBrowserAdapter, inspect, send, readProfileSnapshot, collectProfilePosts, readPostMedia };
