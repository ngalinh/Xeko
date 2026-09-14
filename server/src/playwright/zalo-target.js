const normalize = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

// DOM selectors verified against ZaloCRM's ConversationList and MessageThread.
function findExactGroupRow(groupName) {
  const norm = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('.chat-panel-left .conv-list-scroll .conv-row')]
    .filter(row => row.getBoundingClientRect().width > 0 &&
      norm(row.querySelector('.conv-name')?.textContent) === norm(groupName));
  document.querySelectorAll('[data-xeko-group-target]').forEach(el => el.removeAttribute('data-xeko-group-target'));
  if (rows.length === 1) rows[0].setAttribute('data-xeko-group-target', 'true');
  return { count: rows.length };
}

function readConversationTarget({ groupName, accountName }) {
  const norm = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const headers = [...document.querySelectorAll('.thread-header')].filter(visible);
  const selected = [...document.querySelectorAll('.chat-panel-left .conv-row.conversation-active')].filter(visible);
  const composer = [...document.querySelectorAll('textarea.msg-textarea')].some(visible);
  const loading = [...document.querySelectorAll('.chat-messages-area .v-progress-linear')].some(visible);
  return !loading && composer && headers.length === 1 && selected.length === 1 &&
    norm(selected[0].querySelector('.conv-name')?.textContent) === norm(groupName) &&
    norm(headers[0].querySelector('.thread-name')?.textContent) === norm(groupName) &&
    norm(headers[0].querySelector('.thread-sub')?.textContent) === norm(accountName);
}

async function selectGroupFilter(page) {
  const bar = page.locator('.chat-panel-left .filter-bar');
  await bar.waitFor({ state: 'visible', timeout: 8000 });
  const clear = bar.locator('button.filter-clear');
  if (await clear.isEnabled()) await clear.click();
  // ConversationList defines these four tabs: unread, unreplied, user, group.
  const group = bar.locator('button.filter-btn').nth(3);
  await group.hover();
  await page.getByRole('tooltip').filter({ hasText: /^Nhóm$/ }).waitFor({ state: 'visible', timeout: 4000 });
  if (!(await group.evaluate(el => el.classList.contains('filter-active')))) await group.click();
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('.chat-panel-left .filter-bar button.filter-btn')];
    return buttons[3]?.classList.contains('filter-active') &&
      buttons.filter(el => el.classList.contains('filter-active')).length === 1;
  }, null, { timeout: 5000 });
}

function isGroupSearchResponse(response, groupName) {
  const url = new URL(response.url());
  const params = url.searchParams;
  return response.request().method() === 'GET' && /\/conversations$/.test(url.pathname) &&
    normalize(params.get('search')) === normalize(groupName) && params.get('tab') === 'group' &&
    !!params.get('accountId') && !params.get('accountId').includes(',');
}

function verifySearchResults(data, accountId, target) {
  const matches = (data.conversations || []).filter(conv => conv.threadType === 'group' &&
    normalize(conv.contact?.fullName) === normalize(target.groupName) &&
    String(conv.zaloAccount?.id) === accountId &&
    normalize(conv.zaloAccount?.displayName) === normalize(target.accountName));
  if (matches.length !== 1) throw new Error(`Không có đúng một nhóm "${target.groupName}" của "${target.accountName}" trong kết quả tìm kiếm. Đã dừng.`);
  return matches[0].id;
}

async function assertConversationTarget(page, target) {
  if (!(await page.evaluate(readConversationTarget, target))) {
    const error = new Error(`Không xác minh được hội thoại "${target.groupName}" của "${target.accountName}". Đã dừng để tránh gửi nhầm.`);
    error.targetMismatch = true;
    throw error;
  }
}

module.exports = { findExactGroupRow, readConversationTarget, assertConversationTarget,
  selectGroupFilter, isGroupSearchResponse, verifySearchResults };

