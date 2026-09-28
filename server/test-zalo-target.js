const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { findExactGroupRow, readConversationTarget, assertConversationTarget,
  selectGroupFilter, isGroupSearchResponse, verifySearchResults } = require('./src/playwright/zalo-target');

test('exact account and group selection in a browser', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const target = { groupName: 'SALE US', accountName: 'Linh Duong Us' };
    await page.setContent(`<style>
      input {position:absolute;left:40px;top:20px;width:240px;height:30px}
      #list {position:absolute;left:40px;top:90px;width:290px}
      .row {height:60px;width:290px} .name {display:inline-block}
      #header {position:absolute;left:360px;top:10px;width:700px;height:70px}
      #history {position:absolute;left:360px;top:200px}
      textarea {position:absolute;left:360px;top:600px;width:700px;height:50px}
    </style><div class="chat-panel-left"><input placeholder="Search"><div id="list" class="conv-list-scroll">
      <div class="row conv-row"><span class="conv-name">SALE US VIP</span></div>
      <div class="row conv-row conversation-active" id="correct"><span class="conv-name">SALE US</span></div>
    </div></div><div id="header" class="thread-header"><div class="thread-name">SALE US</div><small id="account" class="thread-sub">Linh Duong Us</small></div>
    <div id="history"><div>SALE US</div><small>Linh Duong Us</small></div>
    <textarea class="msg-textarea"></textarea>`);
    assert.deepEqual(await page.evaluate(findExactGroupRow, 'SALE US'), { count: 1 });
    assert.equal(await page.locator('[data-xeko-group-target]').getAttribute('id'), 'correct');
    assert.deepEqual(await page.evaluate(findExactGroupRow, 'SALE'), { count: 0 });
    await page.evaluate(() => document.querySelector('#list').append(document.querySelector('#correct').cloneNode(true)));
    assert.deepEqual(await page.evaluate(findExactGroupRow, 'SALE US'), { count: 2 });
    assert.equal(await page.locator('[data-xeko-group-target]').count(), 0);
    await page.locator('#list .conv-row').last().evaluate(el => el.remove());
    assert.equal(await page.evaluate(readConversationTarget, target), true);
    await assertConversationTarget(page, target);
    await page.locator('#account').evaluate(el => { el.textContent = ' Linh  Duong US '; });
    assert.equal(await page.evaluate(readConversationTarget, target), true);
    await page.locator('#account').evaluate(el => { el.textContent = 'Linh Thao Us Authentic'; });
    await assert.rejects(assertConversationTarget(page, target), error => error.targetMismatch === true);
    await page.locator('#account').evaluate(el => { el.textContent = 'Linh Duong Us'; });
    await page.locator('#header > div').evaluate(el => { el.textContent = 'SALE US VIP'; });
    assert.equal(await page.evaluate(readConversationTarget, target), false);
    await page.locator('#header').evaluate(el => { el.style.display = 'none'; });
    assert.equal(await page.evaluate(readConversationTarget, target), false);
  } finally {
    await browser.close();
  }
});

test('search must finish for one account, group type, and exact query', () => {
  const response = params => ({ url: () => 'https://zalo.basso.vn/api/conversations?' + new URLSearchParams(params), request: () => ({ method: () => 'GET' }) });
  assert.equal(isGroupSearchResponse(response({ search: 'SALE US', tab: 'group', accountId: 'a' }), 'SALE US'), true);
  for (const params of [
    { search: 'SALE US', tab: 'user', accountId: 'a' },
    { search: 'SALE US', tab: 'group', accountId: 'a,b' },
    { search: 'SALE US', tab: 'group' },
    { search: 'OLD QUERY', tab: 'group', accountId: 'a' },
  ]) assert.equal(isGroupSearchResponse(response(params), 'SALE US'), false);
  const target = { groupName: 'SALE US', accountName: 'Linh Duong Us' };
  const conv = { id: 'group-1', threadType: 'group', contact: { fullName: 'SALE US' }, zaloAccount: { id: 'a', displayName: 'Linh Duong Us' } };
  assert.equal(verifySearchResults({ conversations: [conv] }, 'a', target), 'group-1');
  for (const conversations of [[], [conv, conv], [{ ...conv, threadType: 'user' }],
    [{ ...conv, zaloAccount: { id: 'b', displayName: 'Linh Thao' } }]]) {
    assert.throws(() => verifySearchResults({ conversations }, 'a', target));
  }
});

test('group filter clears old filters before selecting group', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="chat-panel-left"><div class="filter-bar">
      <button class="filter-btn filter-active">Unread</button>
      <button class="filter-btn">Unreplied</button><button class="filter-btn">User</button>
      <button class="filter-btn" id="group" onmouseenter="document.querySelector('[role=tooltip]').hidden=false" onclick="this.classList.add('filter-active')">Group</button>
      <button class="filter-btn filter-clear" onclick="document.querySelectorAll('.filter-active').forEach(el=>el.classList.remove('filter-active'))">Clear</button>
    </div></div><div role="tooltip" hidden>Nhóm</div>`);
    await selectGroupFilter(page);
    assert.equal(await page.locator('.filter-active').count(), 1);
    assert.equal(await page.locator('.filter-active').getAttribute('id'), 'group');
    await selectGroupFilter(page);
    assert.equal(await page.locator('.filter-active').count(), 1);
  } finally { await browser.close(); }
});

test('every send checks target again, and a mismatch never clicks', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const filename = path.join(__dirname, 'src/playwright/salework.js');
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    require: id => {
      if (id === 'path' || id === 'fs') return require(id);
      if (id === './zalo-target') return require('./src/playwright/zalo-target');
      if (id.endsWith('/zalo-profile-lifecycle')) return require('./src/utils/zalo-profile-lifecycle');
      if (id.endsWith('/logger')) return { info() {}, warn() {}, error() {} };
      if (id.endsWith('/delay')) return { randomDelay: async () => {}, sleep: async () => {} };
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.clickSend = clickSend;', sandbox);
  let clicks = 0;
  let checks = 0;
  const page = { locator: () => ({ first: () => ({ count: async () => 1, click: async () => { clicks++; } }) }) };
  await sandbox.module.exports.clickSend(page, async () => { checks++; });
  const mismatch = Object.assign(new Error('wrong account'), { targetMismatch: true });
  await assert.rejects(sandbox.module.exports.clickSend(page, async () => { checks++; throw mismatch; }), /wrong account/);
  assert.equal(checks, 2);
  assert.equal(clicks, 1);
});

