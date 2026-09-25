const { validProfileKey, profileUrl, recipientId } = require('./rules');
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
    return {
      name, blocked, pageEvidence, personalEvidence,
      posts: [...main.querySelectorAll('[role="article"]')].filter(visible).slice(0,10).map(e => e.innerText.slice(0,6000)),
      messageLinks: [...main.querySelectorAll('a[href]')].filter(visible).filter(e => /^(Message|Nhắn tin)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())).map(e => e.href),
    };
  }
  return false;
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

function createBrowserAdapter() {
  const playwright = require('../playwright/post');
  return {
    async withPage(profile, callback) {
      if (!validProfileKey(profile) || !playwright.profileExists(profile)) throw new Error('Tài khoản Facebook không tồn tại');
      const browser = await playwright.getBrowser(profile);
      const page = await browser.newPage();
      try { return await callback(page); } finally { await page.close().catch(() => {}); }
    },
    inspect, send,
  };
}
module.exports = { createBrowserAdapter, inspect, send, readProfileSnapshot };
