const { readSelfDeclaredGender } = require('./gender');
const { validProfileKey, profileUrl, recipientId, isSalesPost } = require('./rules');
const { evaluateProfile } = require('./ai');
const { resolveCurrentProfileUid } = require('./uid');
const { imagePayloads } = require('./attachments');
const { randomUUID } = require('crypto');
const { withClipboard } = require('../utils/clipboard-queue');
const { fillComposerCaption, normalizeCaption } = require('../playwright/fb-caption');
const { normalized } = require('./caption-review');
// Messenger's Lexical composer label varies with recipient and language
// (e.g. "Write to Linh Thảo US"). This selector is used only inside a verified chat.
const COMPOSER = '[contenteditable="true"][role="textbox"]:visible';
const CHAT_ROOT = '[role="dialog"], [role="main"], [role="complementary"], [data-xeko-chat-root]';

// Facebook renders a thread's URL as /messages/t/<id> normally, but switches to
// /messages/e2ee/t/<id> once the end-to-end-encryption consent gate ("Tiếp tục")
// has been accepted for that thread. Both refer to the same conversation.
function isThreadPath(pathname, id) {
  return pathname.replace(/\/$/, '') === `/messages/t/${id}` || pathname.replace(/\/$/, '') === `/messages/e2ee/t/${id}`;
}

// Discover role-less Messenger popups without accepting a page-wide ancestor.
// Mark only the smallest container with one composer, one history and chat controls.
function discoverRecipientPopups() {
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composer = '[contenteditable="true"][role="textbox"]';
  for (const box of document.querySelectorAll(composer)) {
    if (!visible(box) || box.closest('[role="dialog"], [role="complementary"]')) continue;
    for (let root = box.parentElement; root && root !== document.body; root = root.parentElement) {
      if (root.matches('main, [role="main"]')) break;
      if ([...root.querySelectorAll(composer)].filter(visible).length !== 1) break;
      const logs = [...root.querySelectorAll('[role="log"]')].filter(visible);
      const close = [...root.querySelectorAll('[aria-label="Đóng đoạn chat"], [aria-label="Close chat"]')].some(visible);
      const heading = [...root.querySelectorAll('h2, [role="heading"]')].some(e => visible(e) && !e.closest('[role="log"], [role="region"]'));
      if (logs.length === 1 && close && heading) {
        root.setAttribute('data-xeko-chat-root', '');
        break;
      }
    }
  }
}

// Only the header of the composer's nearest chat container can identify it.
function conversationHeaderLinks(root) {
  const boxes = [...root.querySelectorAll('[contenteditable="true"][role="textbox"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
      && e.closest('[role="dialog"], [role="main"], [role="complementary"], [data-xeko-chat-root]') === root);
  if (boxes.length !== 1) return [];
  const floating = root.getAttribute('role') !== 'main';
  const roleless = root.hasAttribute('data-xeko-chat-root');
  const logs = roleless ? [...root.querySelectorAll('[role="log"]')] : [];
  if (roleless && logs.length !== 1) return [];
  return [...root.querySelectorAll(floating ? 'a[href]' : '[role="banner"] a[href], h1 a[href], h2 a[href], [role="heading"] a[href]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
      && !e.closest('[role="log"], [role="row"], [role="grid"], [role="article"], article')
      && (!roleless || (!e.closest('[role="region"]')
        && !!(e.compareDocumentPosition(logs[0]) & Node.DOCUMENT_POSITION_FOLLOWING)))
      && e.closest('[role="dialog"], [role="main"], [role="complementary"], [data-xeko-chat-root]') === root)
    .map(e => e.href);
}
function matchesRecipient(link, id, target) {
  try { const uid = recipientId(link); return uid ? uid === id : profileUrl(link) === target; } catch { return false; }
}
// Runs in the page: only used to describe a timed-out match for diagnostics (never
// for the pass/fail decision itself), so a future failure's "Chi tiết kỹ thuật" shows
// what Facebook actually rendered instead of just "no match found".
function conversationHeaderDebug(root) {
  const boxes = [...root.querySelectorAll('[contenteditable="true"][role="textbox"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
      && e.closest('[role="dialog"], [role="main"], [role="complementary"], [data-xeko-chat-root]') === root);
  const allLinks = [...root.querySelectorAll('a[href]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map(e => e.href);
  return { role: root.getAttribute('role'), composerCount: boxes.length, allLinkCount: allLinks.length, sampleLinks: allLinks.slice(0, 3) };
}
// Runs in the page: Facebook shows this preview instead of a normal chat window
// when the sending account has never been in a conversation with this person.
// Confirmed via live DOM inspection that this preview sits outside every
// [role="dialog"/"main"/"complementary"] container. There is no profile link to
// verify against here, so the caller falls back to matching the displayed name —
// weaker than the usual UID-link check; only used when the operator accepts that.
function pageNotFriendsPreview(token) {
  const notice = [...document.querySelectorAll('*')].find(e =>
    e.children.length === 0 && /không phải là bạn bè trên Facebook|aren.t friends on Facebook/i.test(e.textContent || ''));
  if (!notice) return null;
  // Walk up only until the container encloses exactly one composer box, so later
  // lookups (attach input, attach button) stay scoped to this popup instead of
  // the whole page, which can have other hidden file inputs (feed composer, etc).
  let container = notice;
  for (let i = 0; i < 20 && container.parentElement; i++) {
    container = container.parentElement;
    if (container.querySelectorAll('[contenteditable="true"][role="textbox"]').length === 1) break;
  }
  if (token) container.setAttribute('data-xeko-recipient-chat', token);
  return (container.innerText || '').trim().slice(0, 2000);
}
// Runs in the page: two distinct Facebook screens render a composer with no
// profile link anywhere in the header — confirmed via live diagnostics in both
// (composerCount:1, allLinkCount:0 inside role="main"): (1) the "new message"
// compose screen (reached by going straight to /messages/t/<id> for someone with
// no existing thread) shows a "Đến:"/"To:" recipient chip; (2) a freshly opened
// thread with zero messages shows a centered intro header (avatar + name as a
// heading) instead. Neither has a profile link to verify against, so match by
// whichever name text is available, same trust level as pageNotFriendsPreview.
// Never clicks the chip/heading — only reads text; the composer box is located
// and clicked separately by the normal send flow.
function pageComposeRecipientPreview({ token, expectedName }) {
  if (!expectedName) return null;
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composers = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  if (composers.length !== 1) return null;
  const main = composers[0].closest('[role="main"]');
  if (!main || main.querySelector('a[href]')) return null;
  const label = [...main.querySelectorAll('*')].find(e => visible(e) && e.children.length === 0
    && /^(Đến|To)\s*:?$/i.test((e.textContent || '').trim()));
  const heading = !label && [...main.querySelectorAll('h1, h2, [role="heading"]')]
    .find(e => visible(e) && !e.closest('[role="log"], [role="row"]') && (e.innerText || '').trim());
  const anchor = label || heading;
  if (!anchor) return null;
  let container = anchor;
  for (let i = 0; i < 10 && container.parentElement && container !== main; i++) {
    container = container.parentElement;
    if (container.querySelectorAll('[contenteditable="true"][role="textbox"]').length === 1) break;
  }
  if (token) container.setAttribute('data-xeko-recipient-chat', token);
  return (container.innerText || '').trim().slice(0, 500);
}
// Runs in the page: a brand-new thread (first message to someone not yet a
// friend) shows its receipt as plain visible text ("Đã gửi 8 phút trước"),
// not inside a [role="row"] history item with a clean aria-label like an
// established conversation. Confirmed via live DOM inspection.
function newThreadSentReceipt() {
  return [...document.querySelectorAll('span, div')].some(e =>
    e.children.length === 0 && /^(Sent|Delivered|Đã gửi|Đã chuyển|Đã nhận)\b/i.test((e.textContent || '').trim()));
}
function nameMatchesPreview(previewText, expectedName) {
  return !!expectedName && previewText !== null
    && normalized(previewText).value.includes(normalized(expectedName).value);
}
async function selectRecipientConversation(page, id, target, cancelled, report = () => {}, expectedName = '') {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (cancelled()) throw new Error('Đã dừng trước khi gửi');
    if (attempt > 0 && attempt % 5 === 0) report('conversation_waiting', `Vẫn đang tìm đúng khung chat của khách… (${attempt}s)`);
    await page.evaluate(discoverRecipientPopups);
    const previewToken = randomUUID();
    const previewText = await page.evaluate(pageNotFriendsPreview, previewToken);
    if (previewText !== null) {
      if (!nameMatchesPreview(previewText, expectedName)) {
        throw new Error('Tài khoản gửi chưa là bạn bè/chưa từng nhắn tin với khách trên Facebook, và tên hiển thị trong bản xem trước không khớp tên hồ sơ đã quét; dừng để tránh gửi nhầm người. Hãy kiểm tra thủ công hoặc đổi sang tài khoản đã quen biết khách.');
      }
      report('not_friends_name_matched', `Chưa là bạn bè nhưng tên hiển thị khớp "${expectedName}"; tiếp tục gửi (xác minh theo tên, không có link hồ sơ để đối chiếu).`);
      return { conversation: page.locator(`[data-xeko-recipient-chat="${previewToken}"]`), nameMatchMode: true };
    }
    const composeToken = randomUUID();
    const composeText = await page.evaluate(pageComposeRecipientPreview, { token: composeToken, expectedName });
    if (composeText !== null) {
      if (!nameMatchesPreview(composeText, expectedName)) {
        throw new Error('Không có link hồ sơ để xác minh (màn "Soạn tin mới" hoặc hội thoại mới chưa có tin nhắn) và tên hiển thị không khớp tên hồ sơ đã quét; dừng để tránh gửi nhầm người. Hãy kiểm tra thủ công.');
      }
      report('no_link_name_matched', `Không có link hồ sơ để xác minh nhưng tên hiển thị khớp "${expectedName}"; tiếp tục gửi (xác minh theo tên).`);
      return { conversation: page.locator(`[data-xeko-recipient-chat="${composeToken}"]`), nameMatchMode: true };
    }
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
      return { conversation: page.locator(`[data-xeko-recipient-chat="${token}"]`), nameMatchMode: false };
    }
    await page.waitForTimeout(1000);
  }
  let debugSummary = '';
  try {
    const roots = page.locator(CHAT_ROOT), details = [];
    for (let i = 0, n = await roots.count(); i < n; i++) {
      const root = roots.nth(i);
      if (!await root.isVisible()) continue;
      const info = await root.evaluate(conversationHeaderDebug);
      if (info && typeof info === 'object') details.push(info);
    }
    if (details.length) debugSummary = ` [Chẩn đoán: ${JSON.stringify(details.slice(0, 3))}]`;
  } catch { /* chỉ phục vụ chẩn đoán; lỗi ở đây không được che mất lỗi chính */ }
  const message = 'Không xác minh được hồ sơ ở tiêu đề hội thoại của người nhận; chưa gửi tin. Có thể khách đang ở mục "Tin nhắn chờ" vì tài khoản gửi chưa từng nhắn/kết bạn với khách — mở Messenger, chấp nhận hoặc bắt đầu hội thoại thủ công trước rồi thử gửi lại.' + debugSummary;
  report('conversation_header_debug', debugSummary || '(không lấy được chẩn đoán khung chat)');
  throw new Error(message);
}

async function assertSession(page) {
  if (page.isClosed?.()) { const e = new Error('Tab Facebook đã đóng trước khi quét bài viết; hãy mở lại tài khoản và bấm Thử lại AI'); e.fatal = true; throw e; }
  if (/\/(login|checkpoint|challenge|two_step_verification)(?:[/?]|$)/i.test(new URL(page.url()).pathname) || await page.locator('input[type="password"]').count()) { const e = new Error('Cần đăng nhập hoặc xử lý checkpoint trong Quản lý tài khoản'); e.fatal = true; throw e; }
}

// Runs in the page: Facebook's new end-to-end-encryption consent gate shows a lone
// "Continue"/"Tiếp tục" button (both observed live) and blocks the composer from
// appearing until accepted. Scoped to role=button/button so it can never match the
// composer's own Send control.
function e2eeContinueButton() {
  const buttons = [...document.querySelectorAll('[role="button"], button')].filter(e =>
    e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
    && /^(Continue|Tiếp tục)$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim())
    && e.getAttribute('aria-disabled') !== 'true' && !e.disabled);
  // Facebook can render more than one match (a11y duplicate, fade-in clone); take
  // the first rather than bailing out, so a harmless duplicate never blocks the click.
  return buttons[0] || false;
}
// Runs in the page: many threads (e.g. the "not friends" preview, which has no
// E2EE gate at all) never show the "Tiếp tục" button; once the composer is
// already visible and not stuck behind an unrelated dialog, there's nothing
// left to wait for inside the E2EE-gate loop below.
function composerUnblocked() {
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const boxes = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  if (boxes.length !== 1) return false;
  const blockers = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
  return blockers.every(b => b.querySelector('[contenteditable="true"][role="textbox"]'));
}

// Fallback for when the profile "Nhắn tin" popup path fails (e.g. the composer never
// appears behind Facebook's E2EE consent gate): open the conversation straight from
// its Messenger thread URL instead, accept the gate if shown, then hand off to the
// same selectRecipientConversation used by the popup path so identity verification
// (profile link, or name-match for a not-yet-a-friend preview) stays identical.
async function openThreadDirect(page, id, target, cancelled, report, expectedName) {
  if (cancelled()) throw new Error('Đã dừng trước khi gửi');
  report('open_direct', 'Không mở được khung chat từ hồ sơ; đang thử mở trực tiếp hội thoại Messenger');
  await page.goto(`https://www.facebook.com/messages/t/${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertSession(page);
  if (!isThreadPath(new URL(page.url()).pathname, id)) throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
  // Facebook's SPA can take several seconds after navigation to render the E2EE
  // gate (if it shows at all); checking only a few times right away missed it,
  // leaving the composer permanently blocked. Keep polling for up to ~60s, same
  // order of magnitude as the composer wait below, so a late-rendering gate is
  // still caught.
  for (let i = 0; i < 60; i++) {
    if (cancelled()) throw new Error('Đã dừng trước khi gửi');
    const handle = await page.evaluateHandle(e2eeContinueButton);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      if (await page.evaluate(composerUnblocked)) break;
      if (i > 0 && i % 10 === 0) report('e2ee_waiting', `Đang chờ màn xác nhận mã hóa đầu cuối hoặc ô soạn tin… (${i}s)`);
      await page.waitForTimeout(1000);
      continue;
    }
    report('e2ee_continue', 'Đang bấm "Tiếp tục" để xác nhận mã hóa đầu cuối');
    try {
      await el.click({ timeout: 10000 });
    } catch (clickError) {
      // An overlay layer (Facebook's ripple/ink div) can sit on top and intercept
      // the click; force bypasses that actionability check instead of silently
      // giving up, which previously left this stuck with no diagnostic trail.
      try { await el.click({ timeout: 10000, force: true }); }
      catch (forceError) {
        report('e2ee_continue_failed', `Không bấm được nút "Tiếp tục": ${forceError.message}`);
        await handle.dispose();
        break;
      }
    }
    await handle.dispose();
    await page.waitForTimeout(500);
    // Đừng coi một lần bấm là chắc chắn thành công: nếu nút vẫn còn (click bị
    // nuốt bởi overlay, hoặc Facebook cần xác nhận lần nữa) thì vòng lặp phải
    // phát hiện ở lượt kế tiếp và bấm lại, thay vì thoát ngay rồi để
    // waitForMessageComposer âm thầm chờ 5 phút không có ô soạn tin nào xuất hiện.
  }
  return selectRecipientConversation(page, id, target, cancelled, report, expectedName);
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

// Runs in the profile DOM. Only dismiss Facebook's link information dialog.
function closeContentInfoDialog() {
  const roots = '[role="dialog"], [aria-modal="true"]';
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const title = /^(Giới thiệu về nội dung này|About this content)$/i;
  for (const dialog of document.querySelectorAll(roots)) {
    if (!visible(dialog)) continue;
    const headings = [...dialog.querySelectorAll('h1, h2, h3, [role="heading"]')];
    const labelled = (dialog.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)).filter(e => e && dialog.contains(e));
    if (!title.test((dialog.getAttribute('aria-label') || '').trim())
      && ![...headings, ...labelled].some(e => visible(e) && e.closest(roots) === dialog && title.test((e.innerText || '').trim()))) continue;
    const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(e =>
      visible(e) && e.closest(roots) === dialog && !e.closest('a[href]')
      && !e.disabled && e.getAttribute('aria-disabled') !== 'true'
      && /^(Đóng|Close)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()));
    if (buttons.length !== 1) continue;
    buttons[0].click();
    return true;
  }
  return false;
}

async function dismissContentInfoDialog(page, { check = () => {}, report = () => {} } = {}) {
  check();
  if (await page.evaluate(closeContentInfoDialog) === true) {
    report('popup_closed', 'Đã bấm đóng popup Giới thiệu về nội dung này; tiếp tục quét profile');
  }
  check();
}

// Runs in the page: a pinned post repeats across every batch at the top of the
// feed, so it must never count as one of the 5 captions we select.
function isPostPinned(e) {
  const captionEls = [...e.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')];
  const inCaption = node => captionEls.some(c => c.contains(node));
  return [...e.querySelectorAll('span, strong, a')]
    .filter(el => el.children.length === 0 && !inCaption(el))
    .some(el => /^(Được ghim|Đã ghim|Pinned( [Pp]ost)?)$/.test((el.innerText || '').trim()));
}

// Read caption and image pixels before virtualized feed entries disappear.
async function readPostMedia(page, { cache = new Map(), report = () => {}, check = () => {}, expired = () => false, captionsOnly = false } = {}) {
  // Prefer complete post containers; fall back to caption blocks only when
  // Facebook omits article semantics. Never treat the whole feed as one post.
  const roots = ':is([role="main"], main, #content, #m_basic)';
  const containers = ':is([role="article"], article, [data-pagelet^="FeedUnit"], [role="feed"] > div)';
  const captions = ':is([data-ad-preview="message"], [data-ad-comet-preview="message"])';
  const articles = page.locator(`${roots} ${containers}:not(:has(${containers})):visible, ${roots} ${captions}:not(${containers} ${captions}):visible`);
  await dismissContentInfoDialog(page, { check, report });
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
    if (await article.evaluate(isPostPinned, undefined, { timeout: 1500 })) {
      report('pinned_skipped', 'Bỏ qua bài đã ghim');
      continue;
    }
    scanned++;
    const more = article.getByRole('button', { name: /^(Xem thêm|See more)$/i });
    for (let j = 0, n = Math.min(await more.count(), 3); j < n; j++) {
      // DOM click avoids Playwright scrolling back up to an old off-screen post.
      // Only expand the caption itself; never click a same-named "See more" that
      // belongs to an unrelated link-preview card or Intro section in the article.
      try { await more.nth(0).evaluate(button => {
        if (button.closest('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) button.click();
      }, undefined, { timeout: 1000 }); } catch {}
    }
    await dismissContentInfoDialog(page, { check, report });
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

async function inspect(page, url, { onProgress = () => {}, cancelled = () => false, assessmentMode = 'ai', customBrands = [], owner, myjoyBackend } = {}) {
  const started = Date.now();
  const report = (stage, message, metadata = {}) => onProgress({ ...metadata, stage, message, elapsedMs: Date.now() - started, at: new Date().toISOString() });
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
    await dismissContentInfoDialog(page, { check, report });
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
  // Mode 'none' never reads bio/content, so skip this retry entirely.
  for (let attempt = 0; assessmentMode !== 'none' && !snapshot.blocked && !snapshot.headerBio && attempt < 4; attempt++) {
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
  if (!snapshot.blocked && assessmentMode !== 'none') snapshot = await collectProfilePosts(page, snapshot, { report, check, captionsOnly: ['keywords','myjoy'].includes(assessmentMode) });
  if (profileUrl(page.url()) !== target) throw new Error('Link chuyển sang hồ sơ khác khi đọc bài viết');
  check();
  report('assessment', assessmentMode === 'none' ? 'Không quét nội dung; chỉ lấy ID người nhận' : assessmentMode === 'keywords' ? 'Đang đối chiếu từ khóa caption trên máy, không gọi AI' : 'Đang đánh giá dữ liệu bằng AI');
  const assessment = assessmentMode === 'none'
    ? { eligible: true, provider: 'none' }
    : assessmentMode === 'keywords'
    ? require('./caption-review').evaluateCaptions(snapshot, customBrands)
    : assessmentMode === 'myjoy'
    ? await require('./myjoy').evaluateMyJoy(snapshot, { owner, backendId: myjoyBackend, report, check })
    : await evaluateProfile({ ...snapshot, url: target }, undefined, { report, check });
  check();
  if (!snapshot.blocked && !snapshot.name) {
    assessment.eligible = false;
    assessment.gateReason = 'Đã đọc bài viết nhưng chưa xác minh được tên Facebook. Hãy kiểm tra hồ sơ và Thử lại AI trước khi gửi.';
  }
  report('complete', assessmentMode === 'none' ? 'Đã lấy ID người nhận; không đọc thêm nội dung nào khác' : `Đánh giá xong: ${assessment.salesPostCount || 0}/3 bài có dấu hiệu bán hàng; ${assessment.eligible ? 'đạt điều kiện' : 'cần kiểm tra'}`);
  let selfDeclaredGender = { status: 'unknown', value: null, sourceUrl: target, checkedAt: new Date().toISOString(), reason: 'Chế độ Chỉ gửi, không quét: không đọc mục Giới thiệu.' };
  if (assessmentMode !== 'none') {
    report('gender', 'Đang đọc mục Giới tính tự khai trong phần Giới thiệu');
    selfDeclaredGender = snapshot.blocked ? { status: 'unknown', value: null, sourceUrl: target, checkedAt: new Date().toISOString(), reason: 'Hồ sơ không xem được.' } : await readSelfDeclaredGender(page, target, { check, assertSession });
    check();
    report('gender', selfDeclaredGender.status === 'self_declared' ? 'Đã đọc mục Giới tính tự khai' : 'Giới tính tự khai: chưa xác định');
  }
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
    if (page.isClosed()) { const e = new Error('Tab gửi tin Facebook đã đóng; chưa gửi tin'); e.fatal = true; throw e; }
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
    if (Date.now() >= deadline) { const e = new Error('Đã chờ 5 phút nhưng Messenger chưa sẵn sàng. Hãy hoàn tất mật khẩu/PIN hoặc xác minh trong tab Facebook đang được giữ mở. Chưa gửi tin.'); e.fatal = true; throw e; }
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

async function prepareImages(page, conversation, images, verify, box, report = () => {}) {
  const payloads = imagePayloads(images);
  if (!payloads.length) return;
  report('attach_start', `Đang đính kèm ${payloads.length} ảnh`);
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
          // Facebook's CSP can block fetch() of data: URLs (connect-src), even
          // though the same data: URL works fine as an <img src>. Decode by hand
          // instead of fetching it, so the clipboard paste path never depends on
          // a CSP exception that may not be granted.
          const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
          if (!match) throw new Error('Không đọc được dữ liệu ảnh để dán');
          const binary = atob(match[2]);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const source = new Blob([bytes], { type: match[1] || 'image/png' });
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
    if (i > 0 && i % 5 === 0) report('attach_waiting', `Vẫn đang chờ ảnh tải xong trong ô soạn… (${i}s)`);
    await page.waitForTimeout(1000);
  }
  if (!ready) throw new Error('Ảnh chưa tải xong trong ô soạn; chưa gửi ảnh hoặc tin nhắn');
  await verify();
  report('attach_done', 'Ảnh đã sẵn sàng trong ô soạn');
  return { confirmedImages, composerReady, before, count: payloads.length };
}

async function send(page, lead, message, beforeSubmit, cancelled = () => false, images = [], onProgress = () => {}) {
  // Validate before opening a browser or changing a conversation draft.
  imagePayloads(images);
  if (!/^\d+$/.test(lead.recipientId || '')) throw new Error('Không xác minh được ID người nhận; cần kiểm tra thủ công');
  const started = Date.now();
  const report = (stage, message, metadata = {}) => onProgress({ ...metadata, stage, message, elapsedMs: Date.now() - started, at: new Date().toISOString() });
  const id = lead.recipientId;
  const target = profileUrl(lead.actualUrl || lead.url);
  const check = () => { if (cancelled()) throw new Error('Đã dừng trước khi gửi'); };
  check();
  const expectedName = (lead.name || '').trim();
  // TẠM NGƯNG flow popup từ trang cá nhân (vào hồ sơ → bấm "Nhắn tin") để test
  // trực tiếp flow mở thẳng facebook.com/messages/t/<id>. Bật lại bằng cách khôi
  // phục khối try/catch cũ (xem git history) khi đã xác nhận ổn.
  const { conversation, nameMatchMode } = await openThreadDirect(page, id, target, cancelled, report, expectedName);
  const box = conversation.locator(COMPOSER);
  report('composer', 'Đang chờ ô soạn tin sẵn sàng');
  await waitForMessageComposer(page, box, cancelled, 300000, true);
  if (await box.count() !== 1) throw new Error('Không xác định được duy nhất ô soạn của hội thoại');
  const verify = async () => {
    check();
    const u = new URL(page.url());
    if (u.hostname !== 'www.facebook.com') throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    if (nameMatchMode) {
      // No profile link exists for any name-matched state (not-friends preview,
      // "Soạn tin mới" compose chip, or empty-thread heading), and each can sit on
      // a different URL shape (/messages/t/<id>, /messages/e2ee/t/<id>, or even
      // /messages/new?... for the compose screen) — confirmed live. The identity
      // check below (re-reading the matched name) is what actually guards this.
      if (!u.pathname.startsWith('/messages/')) throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    } else if (u.pathname.startsWith('/messages/')) {
      if (!isThreadPath(u.pathname, id)) throw new Error('Facebook chuyển sang hội thoại khác; đã dừng');
    } else if (profileUrl(page.url()) !== target && recipientId(page.url()) !== id) throw new Error('Facebook chuyển sang hồ sơ khác; đã dừng');
    if (await box.count() !== 1 || await conversation.count() !== 1) throw new Error('Không xác định được duy nhất hội thoại');
    if (nameMatchMode) {
      // Re-check whichever name-matched state is currently showing; the two
      // preview readers are mutually exclusive (not-friends text vs. compose
      // chip/heading), so try the first and fall back to the second.
      let previewText = await page.evaluate(pageNotFriendsPreview);
      if (previewText === null) previewText = await page.evaluate(pageComposeRecipientPreview, { expectedName });
      if (!nameMatchesPreview(previewText, expectedName)) throw new Error('Không còn xác minh được đúng khách qua tên hiển thị trong bản xem trước; đã dừng');
    } else {
      // Require a profile link in the conversation header, excluding message history.
      const links = await conversation.evaluate(conversationHeaderLinks);
      if (!links.some(link => matchesRecipient(link, id, target))) throw new Error('Không xác minh được hồ sơ ở tiêu đề hội thoại; đã dừng');
    }
  };
  await verify();
  if ((await box.innerText()).trim()) throw new Error('Hội thoại có bản nháp đang soạn; cần xử lý thủ công');
  // Real clipboard paste (select-all then paste, like a human) survives Messenger's
  // Lexical editor better than a synthetic fill; falls back to fill() only if it fails.
  // Must run before attaching images: select-all here would also select an already
  // attached image chip, and the paste would wipe it instead of just replacing text.
  report('typing', 'Đang nhập nội dung tin nhắn');
  if (!await fillComposerCaption(page, box, message)) throw new Error('Nội dung trong ô soạn không khớp mẫu');
  await verify();
  let media;
  if (images.length) {
    media = await prepareImages(page, conversation, images, verify, box, report);
    await waitForMessageComposer(page, box, cancelled, 300000, true);
    await verify();
    if (normalizeCaption(await box.innerText()) !== normalizeCaption(message)) throw new Error('Nội dung trong ô soạn đã thay đổi sau khi đính kèm ảnh; chưa gửi tin nhắn');
  }
  const confirmedCount = () => conversation.locator('[role="row"]').evaluateAll((rows, text) => rows.filter(row => {
    const exact = [...row.querySelectorAll('[dir="auto"]')].some(e => e.textContent.trim() === text);
    const pattern = /^(Sent|Delivered|Đã gửi|Đã chuyển|Đã nhận)\b/i;
    const receipt = [...row.querySelectorAll('[aria-label]')].some(e => pattern.test(e.getAttribute('aria-label') || ''))
      || [...row.querySelectorAll('span, div')].some(e => e.children.length === 0 && pattern.test((e.textContent || '').trim()));
    return exact && receipt;
  }).length, message.trim());
  const beforeCount = await confirmedCount();
  if (cancelled()) { await box.fill(''); throw new Error('Đã dừng trước khi gửi'); }
  await verify();
  // Durable reservation BEFORE Enter. Never automatically retry an ambiguous send.
  if (media && !await media.composerReady()) throw new Error('Ảnh trong ô soạn đã thay đổi hoặc chưa sẵn sàng; chưa gửi tin nhắn');
  report('sending', 'Đang bấm gửi tin nhắn');
  beforeSubmit();
  await box.press('Enter');
  report('confirming', `Đang chờ Messenger xác nhận đã gửi (tối đa ${media ? 45 : 15} giây)`);
  for (let i = 0; i < (media ? 45 : 15); i++) {
    if (cancelled()) return { state: 'unconfirmed', reason: 'Đã dừng sau thao tác gửi; cần kiểm tra Messenger. Không tự gửi lại.' };
    await page.waitForTimeout(1000);
    // The message was already sent before this loop starts; a benign DOM change
    // (e.g. a "not friends" preview turning into a real thread right after the
    // first message) must not abort confirmation — just skip re-verifying this tick.
    if (media) { try { await verify(); } catch {} }
    // A brand-new thread has no [role="row"] history to count receipts from;
    // fall back to the plain-text "Đã gửi…"/"Sent…" caption shown under the bubble
    // for the TEXT part only. This caption appears as soon as Messenger submits the
    // message client-side — it says nothing about whether a clipboard-pasted image
    // finished uploading to Facebook's servers, so it must never stand in for image
    // confirmation (that previously let a campaign report "sent" with an image that
    // then vanished on reload because the upload hadn't actually completed).
    const bundleSent = nameMatchMode ? await page.evaluate(newThreadSentReceipt) : null;
    const textSent = bundleSent !== null ? bundleSent : await confirmedCount() > beforeCount;
    const imagesSent = !media || await media.confirmedImages() >= media.before + media.count;
    if (textSent && imagesSent) { report('sent', 'Messenger đã xác nhận gửi'); return { state: 'sent', reason: media ? 'Messenger xác nhận ảnh và nội dung tin nhắn đã gửi/đã chuyển' : 'Messenger hiển thị trạng thái đã gửi/đã chuyển cho tin nhắn mới' }; }
    if (i > 0 && i % 5 === 0) report('confirm_waiting', `Vẫn đang chờ Messenger xác nhận… (${i}s)`);
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
          // launchPersistentContext always starts with one "about:blank" tab that
          // nothing here ever opens or reuses; once the working tab above closes,
          // it's the only thing left on screen and looks like the browser never
          // closed after sending. Clean up stray blank tabs, but never the tab an
          // open inspection session for this profile is still using.
          try {
            const kept = inspectionPages.get(profile);
            for (const p of browser.pages()) {
              if (p !== kept && !p.isClosed() && p.url() === 'about:blank') await p.close().catch(() => {});
            }
          } catch { /* context may already be closed; nothing to clean up */ }
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
    comment: (profile, postUrl, message) => playwright.postComment({ postUrl, message, profile }),
  };
}
module.exports = { closeContentInfoDialog, dismissContentInfoDialog, profileMessageButton, waitForMessageComposer, createBrowserAdapter, inspect, send, resolveUid, readProfileSnapshot, collectProfilePosts, readPostMedia, scrollProfileFeed };



