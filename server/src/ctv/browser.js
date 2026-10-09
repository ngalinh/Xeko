const { readSelfDeclaredGender } = require('./gender');
const { validProfileKey, profileUrl, recipientId, isSalesPost } = require('./rules');
const { evaluateProfile } = require('./ai');
const { resolveCurrentProfileUid } = require('./uid');
const { imagePayloads } = require('./attachments');
const { randomUUID } = require('crypto');
const { withClipboard } = require('../utils/clipboard-queue');
// Messenger's Lexical composer label varies with recipient and language
// (e.g. "Write to Linh Thảo US"). This selector is used only inside a verified chat.
const COMPOSER = '[contenteditable="true"][role="textbox"]:visible';
const CHAT_ROOT = '[role="dialog"], [role="main"], [role="complementary"]';

// Only the header of the composer's nearest chat container can identify it.
function conversationHeaderLinks(root) {
  const boxes = [...root.querySelectorAll('[contenteditable="true"][role="textbox"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
      && e.closest('[role="dialog"], [role="main"], [role="complementary"]') === root);
  if (boxes.length !== 1) return [];
  const floating = root.getAttribute('role') !== 'main';
  return [...root.querySelectorAll(floating ? 'a[href]' : '[role="banner"] a[href], h1 a[href], h2 a[href], [role="heading"] a[href]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
      && !e.closest('[role="log"], [role="row"], [role="grid"], [role="article"], article')
      && e.closest('[role="dialog"], [role="main"], [role="complementary"]') === root)
    .map(e => e.href);
}
function matchesRecipient(link, id, target) {
  try { const uid = recipientId(link); return uid ? uid === id : profileUrl(link) === target; } catch { return false; }
}
async function selectRecipientConversation(page, id, target, cancelled) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (cancelled()) throw new Error('Đã dừng trước khi gửi');
    const roots = page.locator(CHAT_ROOT), matches = [];
    for (let i = 0, n = await roots.count(); i < n; i++) {
      const root = roots.nth(i);
      if (!await root.isVisible()) continue;
      const links = await root.evaluate(conversationHeaderLinks);
      if (links.some(link => matchesRecipient(link, id, target))) matches.push(root);
    }
    if (matches.length > 1) throw new Error('Có nhiều khung chat cùng người nhận; chưa gửi tin');
    if (matches.length === 1) {
      // Pin this DOM container; inserting/reordering another popup cannot retarget it.
      const token = randomUUID();
      await matches[0].evaluate((root, value) => root.setAttribute('data-xeko-recipient-chat', value), token);
      return page.locator(`[data-xeko-recipient-chat="${token}"]`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Không xác minh được hồ sơ ở tiêu đề hội thoại của người nhận; chưa gửi tin');
}

async function assertSession(page) {
  if (page.isClosed?.()) throw new Error('Tab Facebook đã đóng trước khi quét bài viết; hãy mở lại tài khoản và bấm Thử lại AI');
  if (/\/(login|checkpoint|challenge|two_step_verification)(?:[/?]|$)/i.test(new URL(page.url()).pathname) || await page.locator('input[type="password"]').count()) throw new Error('Cần đăng nhập hoặc xử lý checkpoint trong Quản lý tài khoản');
}

// Runs inside the page, both while waiting and when collecting the snapshot.
function readProfileSnapshot(requireHeader = false) {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const excluded = '[role="article"], article, [role="feed"], [role="dialog"], [role="navigation"], nav';
  const sectionTitle = /^(Facebook|Thông tin cá nhân|Personal details|Intro|Giới thiệu|Công việc|Work|Posts|Bài viết|Photos|Ảnh|Friends|Bạn bè)$/i;
  // Read nested spans, explicit line breaks and Facebook's image-based emoji.
  const elementText = e => {
    if (!e.childNodes) return (e.innerText || '').trim();
    const read = node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || !visible(node)) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
      if (node.matches('svg, script, style, [aria-hidden="true"]')) return '';
      return [...node.childNodes].map(read).join('');
    };
    return [...e.childNodes].map(read).join('').trim();
  };
  const roots = [...new Set([...document.querySelectorAll('[role="main"], main, #content, #m_basic'), document.body].filter(Boolean))].filter(visible);
  let feedSnapshot = false;
  for (const main of roots) {
    const text = main.innerText || '';
    const blocked = /locked (?:their |this )?profile|đã khóa trang cá nhân|nội dung này hiện không|content isn't available/i.test(text) ? 'Hồ sơ bị khóa hoặc không xem được' : '';
    const tabs = [...main.querySelectorAll('[role="tab"], a')].filter(e => visible(e)
      && /^(All|About|Posts|Tất cả|Giới thiệu|Bài viết)$/i.test((e.innerText || '').trim()));
    const aboveTabs = e => e.getBoundingClientRect && tabs.some(tab => {
      const box = e.getBoundingClientRect(), tabBox = tab.getBoundingClientRect();
      return tabBox.top > box.bottom && tabBox.top - box.bottom < 650;
    });
    const headings = [...main.querySelectorAll('h1, h2, h3, [role="heading"]')]
      .filter(e => visible(e) && !e.closest(excluded) && !sectionTitle.test(e.innerText.trim()));
    let heading = headings.find(e => e.matches('h1, [aria-level="1"]') && e.innerText.trim())
      || headings.find(e => e.innerText.trim() && aboveTabs(e));
    const controls = [...main.querySelectorAll('[role="button"], button, a')].filter(visible)
      .map(e => (e.getAttribute('aria-label') || e.innerText || '').trim());
    const personalEvidence = controls.some(t => /^(Add friend|Friends|Cancel request|Thêm bạn bè|Bạn bè|Hủy lời mời)$/i.test(t));
    const pageEvidence = /Page transparency|Tính minh bạch của Trang|Độ minh bạch của Trang/i.test(text);
    // Some layouts render the large profile title as a span, without a heading
    // role. Require profile controls and tabs, and never use post/sidebar text.
    if (!heading && (personalEvidence || pageEvidence)) {
      const candidates = [...main.querySelectorAll('span[dir="auto"], div[dir="auto"]')].filter(e => {
        const value = (e.innerText || '').trim();
        return visible(e) && !e.closest(`${excluded}, [role="button"], button, [role="tab"]`)
          && value && value.length <= 150 && !value.includes('\n') && !sectionTitle.test(value)
          && aboveTabs(e) && parseFloat(getComputedStyle(e).fontSize) >= 24;
      }).sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize));
      heading = candidates[0];
    }
    const name = heading?.innerText.trim() || '';
    // A visible feed can be read even when Facebook omits the profile heading.
    // Never promote a feed/post heading to a person's name.
    const trustedName = name && (heading.matches('h1, [aria-level="1"]') || personalEvidence || pageEvidence) ? name : '';
    const feedReady = [...main.querySelectorAll('[role="feed"], [role="article"], article, [data-pagelet^="FeedUnit"], [data-ad-preview="message"], [data-ad-comet-preview="message"]')].some(visible);
    if (!blocked && !trustedName && !feedReady) continue;
    if (requireHeader && !blocked && !trustedName) continue;
    // Read the visible header below the name and above the profile tabs,
    // before scrolling can unmount it. Do not confuse post text with bio.
    let headerBio = '';
    if (trustedName && heading.getBoundingClientRect) {
      const titleBox = heading.getBoundingClientRect();
      const tabs = [...main.querySelectorAll('[role="tab"], a')].filter(e => visible(e)
        && /^(All|About|Posts|Tất cả|Giới thiệu|Bài viết)$/i.test((e.innerText || '').trim())
        && e.getBoundingClientRect().top >= titleBox.bottom);
      const bottom = tabs.length ? Math.min(...tabs.map(e => e.getBoundingClientRect().top)) : titleBox.bottom + 220;
      const metadataRows = [...main.querySelectorAll('svg')].map(icon => {
        let row = icon.parentElement;
        while (row && row !== main && !(row.innerText || '').trim()) row = row.parentElement;
        return row;
      }).filter(row => {
        if (!row || row === main) return false;
        const box = row.getBoundingClientRect();
        return box.top >= titleBox.bottom && box.bottom <= bottom && box.height <= 64;
      });
      const lines = [...main.querySelectorAll('span, div, a')].filter(e => visible(e)
        && !e.closest('[role="article"], article, [role="feed"], [role="button"], button, [role="tab"], [role="navigation"], nav')
        && !e.querySelector?.('svg, [role="list"], [role="listitem"]')
        && !metadataRows.some(row => row.contains(e))
        )
        .map(e => ({element: e, text: elementText(e), box:e.getBoundingClientRect()}))
        .filter(({text,box}) => text && box.top >= titleBox.bottom - 2 && box.bottom <= bottom
          && box.left >= titleBox.left - 24
          && !/followers|following|người theo dõi|đang theo dõi/i.test(text)
          && !/^(Message|Nhắn tin|Follow|Theo dõi|Add friend|Thêm bạn bè|Search|Tìm kiếm)$/i.test(text))
        .filter((line, _, all) => !all.some(other => other !== line && other.element.contains?.(line.element)))
        .sort((a,b) => a.box.top - b.box.top || a.box.left - b.box.left);
      headerBio = [...new Set(lines.map(line => line.text))].join('\n').slice(0,2000);
    }
    const result = {
      headerBio,
      bio: headerBio,
      name: trustedName, blocked, pageEvidence, personalEvidence, feedReady,
      posts: [...main.querySelectorAll('[role="article"], article')].filter(visible).slice(0,10).map(e => e.innerText.slice(0,6000)),
      messageLinks: [...main.querySelectorAll('a[href]')].filter(visible).filter(e => !e.closest(excluded) && aboveTabs(e) && /^(Message|Nhắn tin)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())).map(e => e.href),
    };
    // A feed-only main can precede a separate profile header in the DOM.
    if (trustedName || blocked) return result;
    if (!feedSnapshot) feedSnapshot = result;
  }
  return feedSnapshot;
}

// Read caption and image pixels before virtualized feed entries disappear.
async function readPostMedia(page, { cache = new Map(), report = () => {}, check = () => {}, expired = () => false, captionsOnly = false } = {}) {
  // Prefer complete post containers; fall back to caption blocks only when
  // Facebook omits article semantics. Never treat the whole feed as one post.
  const roots = ':is([role="main"], main, #content, #m_basic)';
  const containers = ':is([role="article"], article, [data-pagelet^="FeedUnit"], [role="feed"] > div)';
  const captions = ':is([data-ad-preview="message"], [data-ad-comet-preview="message"])';
  const articles = page.locator(`${roots} ${containers}:not(:has(${containers})):visible, ${roots} ${captions}:not(${containers} ${captions}):visible`);
  const records = [];
  for (let i = 0, count = await articles.count(), scanned = 0; i < count && scanned < 10; i++) {
    check();
    if (expired()) break;
    const article = articles.nth(i);
    if (!await article.isVisible()) continue;
    // :visible includes off-screen posts. Filter before limiting the batch so
    // a growing feed cannot keep us reading its first ten posts forever.
    const inViewport = await article.evaluate(e => {
      const r = e.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }, undefined, { timeout: 1500 });
    if (!inViewport) continue;
    scanned++;
    const more = article.getByRole('button', { name: /^(Xem thêm|See more)$/i });
    for (let j = 0, n = Math.min(await more.count(), 3); j < n; j++) {
      // DOM click avoids Playwright scrolling back up to an old off-screen post.
      try { await more.nth(0).evaluate(button => button.click(), undefined, { timeout: 1000 }); } catch {}
    }
    const caption = await article.evaluate(e => {
      const bodies = [...e.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')];
      // Album titles are outside the message block but belong to this post.
      const albums = [...e.querySelectorAll('a[href*="/media/set"], a[href*="/albums/"], a[href*="set=a."]')]
        .map(a => (a.innerText || '').trim()).filter(Boolean);
      return [...new Set([...albums, ...(bodies.length ? bodies.map(b => b.innerText || '') : [e.innerText || ''])])]
        .join('\n').trim().slice(0,6000);
    }, undefined, { timeout: 1500 });
    if (captionsOnly) { if (caption) records.push({ caption, images: [] }); continue; }
    const cached = caption && cache.get(caption);
    if (cached) { records.push(cached); continue; }
    report('post', `Đọc bài trong vùng xem: ${caption.length} ký tự; đang kiểm tra ảnh`);
    const images = [];
    const candidates = article.locator('img');
    for (let j = 0, n = Math.min(await candidates.count(), 12); j < n && images.length < 2; j++) {
      if (expired()) break;
      const img = candidates.nth(j);
      try {
        check();
        const usable = await img.evaluate(e => {
          const r = e.getBoundingClientRect();
          return e.complete && e.naturalWidth >= 150 && e.naturalHeight >= 150
            && r.width >= 120 && r.height >= 120 && r.top >= 0 && r.bottom <= innerHeight
            && r.left >= 0 && r.right <= innerWidth;
        }, undefined, { timeout: 1500 });
        if (!usable || !await img.isVisible()) continue;
        const bytes = await img.screenshot({ type: 'jpeg', quality: 65, timeout: 2500 });
        if (bytes.length <= 750000) images.push({ mimeType: 'image/jpeg', data: bytes.toString('base64') });
      } catch { check(); report('image_skipped', 'Ảnh không đọc được hoặc quá thời gian; giữ lại caption'); }
    }
    if (caption || images.length) {
      const record = { caption, images };
      // Retry absent/lazy images on later viewports, but never recapture photos.
      if (caption && images.length) cache.set(caption, record);
      records.push(record);
    }
  }
  return records;
}

// Runs in the page: Facebook can scroll a nested feed instead of the window.
function scrollProfileFeed() {
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const roots = [...document.querySelectorAll('[role="main"], main, #content, #m_basic')].filter(visible);
  const articles = roots.flatMap(root => [...root.querySelectorAll('[role="article"], article')]).filter(visible);
  const anchor = articles.at(-1) || roots[0];
  const candidates = [];
  for (let node = anchor; node; node = node.parentElement) candidates.push(node);
  for (const root of roots) candidates.push(root, ...root.querySelectorAll('*'));
  const scroller = candidates.find(e => visible(e)
    && /^(auto|scroll)$/.test(getComputedStyle(e).overflowY)
    && e.scrollHeight > e.clientHeight + 1
    && e.scrollTop + e.clientHeight < e.scrollHeight - 1)
    || document.scrollingElement;
  if (!scroller) return { moved: false };
  const before = scroller.scrollTop;
  // Do not jump to an off-screen article: advance one viewport to load the feed.
  scroller.scrollTop = before + Math.max(600, scroller.clientHeight * 0.8);
  return { moved: scroller.scrollTop > before };
}

// Collect across scrolls because Facebook may virtualize older feed entries.
async function collectProfilePosts(page, snapshot, { report = () => {}, check = () => {}, captionsOnly = false } = {}) {
  const posts = new Map();
  const cache = new Map(), seen = new Set(), started = Date.now();
  const expired = () => Date.now() - started >= 60000;
  let stopReason = 'Đã đạt giới hạn 12 lượt cuộn';
  let staleBatches = 0;
  for (let step = 0; step <= 12; step++) {
    check();
    if (expired()) { stopReason = 'Đã đạt giới hạn 60 giây đọc bài'; break; }
    await assertSession(page);
    report('reading', `Lượt ${step + 1}/13: ${captionsOnly ? "đọc caption, không đọc ảnh" : "đọc caption và ảnh"} trong vùng xem`);
    const batch = await readPostMedia(page, { cache, report, check, expired, captionsOnly });
    let discovered = 0;
    for (const post of batch) {
      const key = post.caption.replace(/\s+/g, ' ').trim() || post.images[0].data;
      if (!seen.has(key)) { discovered++; seen.add(key); }
      if (!posts.has(key) && posts.size >= 20 && isSalesPost(post.caption)) {
        const supplementary = [...posts].find(([, value]) => !isSalesPost(value.caption));
        if (supplementary) posts.delete(supplementary[0]);
      }
      if ((!posts.has(key) && posts.size < 20) || (posts.has(key) && posts.get(key).images.length < post.images.length)) posts.set(key, post);
    }
    staleBatches = discovered === 0 ? staleBatches + 1 : 0;
    const sales = [...posts.values()].filter(p => isSalesPost(p.caption)).length;
    report('batch', `Lượt ${step + 1}: ${batch.length} bài trong vùng xem, ${discovered} bài mới; giữ ${posts.size} bài, ${sales} bài có dấu hiệu bán hàng`);
    if (captionsOnly && posts.size >= 5) { stopReason = 'Đã đọc đủ 5 caption khác nhau'; break; }
    if (sales >= 5) { stopReason = 'Đã thu thập đủ 5 bài có dấu hiệu bán hàng'; break; }
    if (expired()) { stopReason = 'Đã đạt giới hạn 60 giây đọc bài'; break; }
    if (staleBatches >= 3) { stopReason = 'Không có bài mới sau 3 lượt liên tiếp'; break; }
    if (step === 12) break;
    check();
    const progress = await page.evaluate(scrollProfileFeed);
    report('scroll', `Cuộn tải bài tiếp theo: ${progress?.moved === false ? 'chưa di chuyển, chờ tải thêm' : 'đã yêu cầu cuộn'}`);
    if (progress && !progress.moved) {
      // Allow delayed feed content to mount before another attempt.
      await page.waitForTimeout(1500);
      await page.evaluate(scrollProfileFeed);
    }
    await page.waitForTimeout(1500);
  }
  const values = [...posts.values()];
  const selected = (captionsOnly ? values : values.sort((a,b) => Number(isSalesPost(b.caption)) - Number(isSalesPost(a.caption)))).slice(0,5);
  report('scan_complete', `${stopReason}; chọn ${selected.length} bài và ${selected.reduce((n, p) => n + p.images.length, 0)} ảnh để đánh giá`);
  return { ...snapshot, posts: selected.map(p => p.caption), postMedia: selected };
}

async function inspect(page, url, { onProgress = () => {}, cancelled = () => false, assessmentMode = 'ai' } = {}) {
  const started = Date.now();
  const report = (stage, message) => onProgress({ stage, message, elapsedMs: Date.now() - started, at: new Date().toISOString() });
  const check = () => { if (cancelled()) throw new Error('Đã dừng quét profile theo yêu cầu'); };
  check();
  report('navigation', 'Đang mở profile (tối đa 30 giây)');
  const target = profileUrl(url);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  let handle;
  let snapshot;
  try {
    check();
    report('header', 'Đang chờ tên và bio profile (tối đa 30 giây)');
    handle = await page.waitForFunction(readProfileSnapshot, true, { timeout: 30000 });
    snapshot = await handle.jsonValue();
  } catch (error) {
    // Preserve browser/navigation failures instead of masking them with locator.count.
    if (error.name !== 'TimeoutError') throw error;
    await assertSession(page);
    // Some profile layouts expose the feed without a supported name heading.
    // Preserve the header-first wait, but do not discard a readable feed.
    snapshot = await page.evaluate(readProfileSnapshot, false);
    report('header_fallback', 'Hết thời gian chờ tên; kiểm tra phần bài viết có thể đọc');
    if (!snapshot || (!snapshot.blocked && !snapshot.name && !snapshot.feedReady)) {
      throw new Error('Chưa đọc được tên Facebook sau 30 giây và chưa thấy bài viết để cuộn quét. Hãy kiểm tra hồ sơ đã tải xong rồi thử lại.');
    }
  } finally {
    if (handle) await handle.dispose();
  }
  if (!snapshot.blocked && !snapshot.name && !snapshot.feedReady) throw new Error('Chưa đọc được tên Facebook hoặc bài viết để cuộn quét. Hãy thử lại khi hồ sơ tải xong.');
  // Header text can mount after the name. Capture it before any feed scroll,
  // retaining the saved header if Facebook temporarily unmounts the DOM.
  for (let attempt = 0; !snapshot.blocked && !snapshot.headerBio && attempt < 4; attempt++) {
    check();
    await page.waitForTimeout(750);
    await assertSession(page);
    const header = await page.evaluate(readProfileSnapshot, true);
    if (header?.blocked) { snapshot = header; break; }
    if (header?.name && header.name !== snapshot.name) throw new Error('Tên Facebook thay đổi khi đọc bio; hãy kiểm tra lại hồ sơ.');
    if (header?.name) snapshot = { ...snapshot, ...header };
  }
  await assertSession(page);
  const actual = profileUrl(page.url());
  if (actual !== target) throw new Error('Link chuyển sang hồ sơ khác; hãy kiểm tra và nhập lại link chính xác');
  report('header_ready', `Tên: ${snapshot.name ? 'đã đọc' : 'chưa đọc được'}; bio: ${(snapshot.headerBio || '').length} ký tự${snapshot.blocked ? '; hồ sơ bị khóa/không xem được' : ''}`);
  report('uid', 'Đang đối chiếu UID với link hồ sơ');
  const identity = await resolveCurrentProfileUid(page, target, snapshot);
  report('uid', identity.recipientId ? `Đã xác định UID: ${identity.recipientId}` : identity.uidReason);
  if (!snapshot.blocked) snapshot = await collectProfilePosts(page, snapshot, { report, check, captionsOnly: assessmentMode === 'keywords' });
  if (profileUrl(page.url()) !== target) throw new Error('Link chuyển sang hồ sơ khác khi đọc bài viết');
  check();
  report('assessment', assessmentMode === 'keywords' ? 'Đang đối chiếu từ khóa caption trên máy, không gọi AI' : 'Đang đánh giá dữ liệu bằng AI');
  const assessment = assessmentMode === 'keywords'
    ? require('./caption-review').evaluateCaptions(snapshot)
    : await evaluateProfile({ ...snapshot, url: target }, undefined, { report, check });
  check();
  if (!snapshot.blocked && !snapshot.name) {
    assessment.eligible = false;
    assessment.gateReason = 'Đã đọc bài viết nhưng chưa xác minh được tên Facebook. Hãy kiểm tra hồ sơ và Thử lại AI trước khi gửi.';
  }
  report('complete', `Đánh giá xong: ${assessment.salesPostCount || 0}/3 bài có dấu hiệu bán hàng; ${assessment.eligible ? 'đạt điều kiện' : 'cần kiểm tra'}`);
  report('gender', 'Đang đọc mục Giới tính tự khai trong phần Giới thiệu');
  const selfDeclaredGender = snapshot.blocked ? { status: 'unknown', value: null, sourceUrl: target, checkedAt: new Date().toISOString(), reason: 'Hồ sơ không xem được.' } : await readSelfDeclaredGender(page, target, { check, assertSession });
  check();
  report('gender', selfDeclaredGender.status === 'self_declared' ? 'Đã đọc mục Giới tính tự khai' : 'Giới tính tự khai: chưa xác định');
  return { selfDeclaredGender, url: target, actualUrl: actual, name: snapshot.name, bio: snapshot.headerBio || '', checkedAt: new Date().toISOString(), ...assessment, ...identity };
}

async function resolveUid(page, url, { cancelled = () => false } = {}) {
  const check = () => { if (cancelled()) throw new Error('Đã dừng tìm UID'); };
  check();
  const target = profileUrl(url);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  let handle;
  try {
    check();
    handle = await page.waitForFunction(readProfileSnapshot, true, { timeout: 30000 });
    const snapshot = await handle.jsonValue();
    await assertSession(page);
    check();
    const identity = await resolveCurrentProfileUid(page, target, snapshot);
    check();
    return { ...identity, uidCheckedAt: new Date().toISOString() };
  } finally { if (handle) await handle.dispose(); }
}

// Wait for the user to unlock Messenger; never read or fill credentials.
async function waitForMessageComposer(page, box, cancelled, timeoutMs = 300000, allowChatDialog = false) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (cancelled()) throw new Error('Đã dừng trước khi gửi');
    if (page.isClosed()) throw new Error('Tab gửi tin Facebook đã đóng; chưa gửi tin');
    const authPage = /\/(login|checkpoint|challenge|two_step_verification)(?:[/?]|$)/i.test(new URL(page.url()).pathname);
    const blockers = page.locator('input[type="password"]:visible, [role="dialog"]:visible, [aria-modal="true"]:visible');
    const blocked = authPage || (allowChatDialog
      ? await blockers.evaluateAll(elements => elements.some(e => e.matches('input') || !e.querySelector('[contenteditable="true"][role="textbox"]')))
      : await blockers.count() > 0);
    if (!blocked && await box.count() === 1 && await box.isVisible()) {
      const before = await box.getAttribute('aria-label');
      await page.waitForTimeout(600);
      if (cancelled()) throw new Error('Đã dừng trước khi gửi');
      if (await box.count() === 1 && await box.isVisible() && await box.isEditable()
        && await box.getAttribute('aria-label') === before) return;
    }
    if (Date.now() >= deadline) throw new Error('Đã chờ 5 phút nhưng Messenger chưa sẵn sàng. Hãy hoàn tất mật khẩu/PIN hoặc xác minh trong tab Facebook đang được giữ mở. Chưa gửi tin.');
    await page.waitForTimeout(1000);
  }
}

// Run in the profile DOM. Never select Message actions from posts or other chats.
function profileMessageButton() {
  const excluded = '[role="article"], article, [role="feed"], [role="dialog"], [role="navigation"], nav, [role="complementary"]';
  const buttons = [...document.querySelectorAll('[role="main"] [role="button"], [role="main"] button, [role="main"] a')].filter(e =>
    e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest(excluded)
    && /^(Message|Send message|Nhắn tin|Gửi tin nhắn)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())
    && e.getAttribute('aria-disabled') !== 'true' && !e.disabled);
  return buttons.length === 1 ? buttons[0] : false;
}

async function prepareImages(page, conversation, images, verify, box) {
  const payloads = imagePayloads(images);
  if (!payloads.length) return;
  const removeSelector = '[role="button"][aria-label="Remove attachment"], [role="button"][aria-label="Remove photo"], [role="button"][aria-label="Remove image"], [role="button"][aria-label="Xóa ảnh"], button[aria-label="Remove attachment"], button[aria-label="Remove photo"]';
  if (await conversation.locator(removeSelector).count()) throw new Error('Hội thoại có ảnh đang soạn; cần xử lý thủ công');
  const input = conversation.locator('input[type="file"][accept*="image"]');
  const inputCount = await input.count();
  if (inputCount > 1) throw new Error('Không xác định được duy nhất ô đính kèm ảnh trong hội thoại');
  const confirmedImages = () => conversation.locator('[role="row"]').evaluateAll(rows => {
    const photos = new Set();
    for (const row of rows) {
      const receipt = [...row.querySelectorAll('[aria-label]')].some(e => /^(Sent|Delivered|Đã gửi|Đã chuyển|Đã nhận)$/i.test(e.getAttribute('aria-label') || ''));
      if (!receipt) continue;
      for (const img of row.querySelectorAll('img')) {
        const r = img.getBoundingClientRect();
        if (img.complete && img.naturalWidth > 0 && r.width >= 80 && r.height >= 80) photos.add(img.currentSrc || img.src);
      }
    }
    return photos.size;
  });
  const before = await confirmedImages();
  const previewCount = () => conversation.evaluate(root => [...root.querySelectorAll('img')].filter(img => {
    const r = img.getBoundingClientRect();
    return !img.closest('[role="row"], [role="log"], a[href], [role="banner"], h1, h2, [role="heading"]')
      && img.complete && img.naturalWidth > 0 && r.width >= 40 && r.height >= 40;
  }).length);
  if (await previewCount()) throw new Error('Hội thoại có ảnh đang soạn; cần xử lý thủ công');
  await verify();
  if (inputCount === 1) {
    await input.setInputFiles(payloads);
  } else {
    const attach = conversation.getByRole('button', { name: /^(Attach a photo or video|Attach photos and videos|Add photos and videos|Đính kèm ảnh hoặc video|Thêm ảnh và video)$/i });
    if (await attach.count() > 1) throw new Error('Có nhiều nút đính kèm trong hội thoại; chưa gửi tin');
    if (await attach.count() === 1) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await verify();
      await attach.click();
      const chooser = await chooserPromise;
      if (!chooser) throw new Error('Không mở được bộ chọn ảnh; chưa gửi tin nhắn');
      await verify();
      await chooser.setFiles(payloads);
    } else {
      // A trusted paste for Messenger layouts that expose no file input/button.
      // Lock write+paste because browser contexts share the system clipboard.
      for (let i = 0; i < images.length; i++) await withClipboard(async () => {
        await verify();
        await page.bringToFront();
        await box.focus();
        await page.evaluate(async dataUrl => {
          const source = await (await fetch(dataUrl)).blob();
          const bitmap = await createImageBitmap(source);
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
          const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!png) throw new Error('Không chuyển được ảnh để dán');
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        }, images[i].dataUrl);
        await verify();
        await box.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
        let pasted = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          await verify();
          if (await previewCount() === i + 1) { pasted = true; break; }
          await page.waitForTimeout(200);
        }
        if (!pasted) throw new Error('Messenger chưa hiển thị ảnh vừa dán; chưa gửi tin nhắn');
      });
    }
  }
  // Wait for loaded composer thumbnails, outside message history.
  const composerReady = async () => await previewCount() === payloads.length;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await verify();
    ready = await composerReady();
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  if (!ready) throw new Error('Ảnh chưa tải xong trong ô soạn; chưa gửi ảnh hoặc tin nhắn');
  await verify();
  return { confirmedImages, composerReady, before, count: payloads.length };
}

async function send(page, lead, message, beforeSubmit, cancelled = () => false, images = []) {
  // Validate before opening a browser or changing a conversation draft.
  imagePayloads(images);
  if (!/^\d+$/.test(lead.recipientId || '')) throw new Error('Không xác minh được ID người nhận; cần kiểm tra thủ công');
  const id = lead.recipientId;
  const target = profileUrl(lead.actualUrl || lead.url);
  const check = () => { if (cancelled()) throw new Error('Đã dừng trước khi gửi'); };
  check();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  if (profileUrl(page.url()) !== target && recipientId(page.url()) !== id) throw new Error('Facebook chuyển sang hồ sơ khác; đã dừng');
  let button;
  try {
    button = await page.waitForFunction(profileMessageButton, null, { timeout: 30000 });
    check();
    if (profileUrl(page.url()) !== target && recipientId(page.url()) !== id) throw new Error('Facebook chuyển sang hồ sơ khác; đã dừng');
    await button.asElement().click({ timeout: 10000 });
  } finally { if (button) await button.dispose(); }
  const conversation = await selectRecipientConversation(page, id, target, cancelled);
  const box = conversation.locator(COMPOSER);
  await waitForMessageComposer(page, box, cancelled, 300000, true);
  if (await box.count() !== 1) throw new Error('Không xác định được duy nhất ô soạn của hội thoại');
  const verify = async () => {
    check();
    const u = new URL(page.url());
    if (u.hostname !== 'www.facebook.com') throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    if (u.pathname.startsWith('/messages/')) {
      if (u.pathname.replace(/\/$/,'') !== `/messages/t/${id}`) throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    } else if (profileUrl(page.url()) !== target && recipientId(page.url()) !== id) throw new Error('Facebook chuyển sang hồ sơ khác; đã dừng');
    if (await box.count() !== 1 || await conversation.count() !== 1) throw new Error('Không xác định được duy nhất hội thoại');
    // Require a profile link in the conversation header, excluding message history.
    const links = await conversation.evaluate(conversationHeaderLinks);
    if (!links.some(link => matchesRecipient(link, id, target))) throw new Error('Không xác minh được hồ sơ ở tiêu đề hội thoại; đã dừng');
  };
  await verify();
  if ((await box.innerText()).trim()) throw new Error('Hội thoại có bản nháp đang soạn; cần xử lý thủ công');
  let media;
  if (images.length) {
    media = await prepareImages(page, conversation, images, verify, box);
    await waitForMessageComposer(page, box, cancelled, 300000, true);
    await verify();
    if ((await box.innerText()).trim()) throw new Error('Ô soạn có bản nháp sau đính kèm ảnh; chưa gửi tin nhắn');
  }
  await box.fill(message);
  if ((await box.innerText()).trim() !== message.trim()) throw new Error('Nội dung trong ô soạn không khớp mẫu');
  await verify();
  const confirmedCount = () => conversation.locator('[role="row"]').evaluateAll((rows, text) => rows.filter(row => {
    const exact = [...row.querySelectorAll('[dir="auto"]')].some(e => e.textContent.trim() === text);
    const receipt = [...row.querySelectorAll('[aria-label]')].some(e => /^(Sent|Delivered|Đã gửi|Đã chuyển|Đã nhận)$/i.test(e.getAttribute('aria-label') || ''));
    return exact && receipt;
  }).length, message.trim());
  const beforeCount = await confirmedCount();
  if (cancelled()) { await box.fill(''); throw new Error('Đã dừng trước khi gửi'); }
  await verify();
  // Durable reservation BEFORE Enter. Never automatically retry an ambiguous send.
  if (media && !await media.composerReady()) throw new Error('Ảnh trong ô soạn đã thay đổi hoặc chưa sẵn sàng; chưa gửi tin nhắn');
  beforeSubmit();
  await box.press('Enter');
  for (let i = 0; i < (media ? 45 : 15); i++) {
    if (cancelled()) return { state: 'unconfirmed', reason: 'Đã dừng sau thao tác gửi; cần kiểm tra Messenger. Không tự gửi lại.' };
    await page.waitForTimeout(1000);
    if (media) await verify();
    const textSent = await confirmedCount() > beforeCount;
    const imagesSent = !media || await media.confirmedImages() >= media.before + media.count;
    if (textSent && imagesSent) return { state: 'sent', reason: media ? 'Messenger xác nhận ảnh và nội dung tin nhắn đã gửi/đã chuyển' : 'Messenger hiển thị trạng thái đã gửi/đã chuyển cho tin nhắn mới' };
  }
  // DOM receipts differ across Messenger variants: uncertainty must remain explicit.
  return { state: 'unconfirmed', reason: media ? 'Đã thao tác gửi ảnh kèm nội dung nhưng chưa xác nhận đầy đủ. Kiểm tra Messenger; không tự gửi lại.' : 'Đã thao tác gửi; cần kiểm tra Messenger để xác nhận. Không tự gửi lại.' };
}

function createBrowserAdapter(playwright = require('../playwright/post')) {
  const inspectionPages = new Map();
  const sendingPages = new Map();
  const inspectionContexts = new Map();
  return {
    async withPage(profile, callback, { keepOpen = false, keepOnError = false } = {}) {
      if (!validProfileKey(profile) || !playwright.profileExists(profile)) throw new Error('Tài khoản Facebook không tồn tại');
      const browser = await playwright.getBrowser(profile);
      // Retain the context even if newPage fails, so batch cleanup can close it.
      if (keepOpen) inspectionContexts.set(profile, browser);
      const pages = keepOpen ? inspectionPages : sendingPages;
      let page = (keepOpen || keepOnError) ? pages.get(profile) : null;
      if (!page || page.isClosed() || page.context() !== browser) {
        page = await browser.newPage();
        if (keepOpen || keepOnError) pages.set(profile, page);
      }
      let failed = false;
      try { return await callback(page); } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (!keepOpen && !(keepOnError && failed)) {
          pages.delete(profile);
          await page.close().catch(() => {});
        }
      }
    },
    async closeInspection(profile) {
      const context = inspectionContexts.get(profile);
      if (!context) return;
      await context.close();
      inspectionContexts.delete(profile);
      inspectionPages.delete(profile);
    },
    inspect, send, resolveUid,
  };
}
module.exports = { profileMessageButton, waitForMessageComposer, createBrowserAdapter, inspect, send, resolveUid, readProfileSnapshot, collectProfilePosts, readPostMedia, scrollProfileFeed };



