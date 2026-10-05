const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { normalizeMutualFriendTarget, readMutualFriendEvidence } = require('./src/ctv/mutual-friends');

test('optional target validates direct profiles and never defaults to a fixed account', () => {
  for (const value of [undefined, null, '', '  ']) assert.equal(normalizeMutualFriendTarget(value), '');
  assert.equal(normalizeMutualFriendTarget(' https://m.facebook.com/Other.Account/?ref=x '), 'https://www.facebook.com/other.account');
  assert.equal(normalizeMutualFriendTarget('https://facebook.com/profile.php?id=123&ref=x'), 'https://www.facebook.com/profile.php?id=123');
  for (const value of [{}, 'javascript:alert(1)', 'https://facebook.com.evil.test/user', 'https://facebook.com/groups/123', 'https://facebook.com/user/posts/123', 'x'.repeat(2001)]) {
    assert.throws(() => normalizeMutualFriendTarget(value));
  }
});

test('mutual friends evidence in Chromium', async t => {
  const browser = await chromium.launch({headless:true, ...(process.env.CTV_TEST_BROWSER_CHANNEL ? {channel:process.env.CTV_TEST_BROWSER_CHANNEL} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://www.facebook.com/**', route => route.fulfill({contentType:'text/html', body:'<html></html>'}));
  await page.goto('https://www.facebook.com/customer');
  const targetUrl = 'https://www.facebook.com/other.account';
  const avatar = (url = targetUrl, attrs = '') => `<a href="${url}" ${attrs}><img alt="Avatar" width="32" height="32"></a>`;
  const row = (content = avatar(), label = '<a href="/customer?sk=friends_mutual">2 bạn chung</a>') => `<div class="row">${content}${label}</div>`;
  const fixture = content => `<style>body{font-family:Arial}main{margin:40px}h1{margin:0}.row{display:flex;align-items:center;height:40px}.tabs{margin-top:30px}</style><main><h1>Khách hàng</h1><div>Bio bán hàng</div>${content}<div class="tabs"><a role="tab">Tất cả</a></div></main>`;
  const read = async (content, target = targetUrl) => {
    await page.setContent(fixture(content));
    return page.evaluate(readMutualFriendEvidence, {targetUrl:target,profileName:'Khách hàng'});
  };
  await t.test('confirms an arbitrary target and retains evidence', async () => {
    const result = await read(row());
    assert.equal(result.status, 'confirmed');
    assert.equal(result.evidence[0].profileUrl, targetUrl);
  });
  await t.test('supports accessible labels and tracking parameters', async () => {
    assert.equal((await read(row(avatar('https://m.facebook.com/OTHER.ACCOUNT/?ref=x'), '<span aria-label="2 mutual friends">2</span>'))).status, 'confirmed');
  });
  await t.test('numeric profile forms match the same ID', async () => {
    assert.equal((await read(row(avatar('https://facebook.com/123')), 'https://www.facebook.com/profile.php?id=123')).status, 'confirmed');
  });
  await t.test('different targets are never mixed', async () => {
    assert.notEqual((await read(row(), 'https://www.facebook.com/second.account')).status, 'confirmed');
  });
  await t.test('avatar-only row and bio link need review, not confirmation', async () => {
    assert.equal((await read(row(avatar(), ''))).status, 'needs_review');
    assert.equal((await read(`<p><a href="${targetUrl}">Đối tác bán hàng</a></p>`)).status, 'needs_review');
  });
  await t.test('wrong host, hidden avatar, same display name and post mentions cannot confirm', async () => {
    for (const content of [row(avatar('https://facebook.com.evil.test/other.account')), row(avatar(targetUrl, 'style="display:none"')), row('<a href="https://facebook.com/different">Linh Dương</a>'), `<article>${row()}</article>`, `<nav>${row()}</nav>`]) {
      assert.notEqual((await read(content)).status, 'confirmed');
    }
  });
  await t.test('missing and self-profile evidence stay unknown', async () => {
    assert.equal((await read('<button>Thêm bạn bè</button>')).status, 'unknown');
    assert.equal((await read(row(), 'https://www.facebook.com/customer')).status, 'unknown');
    const result = await read(row());
    await page.setContent(fixture(row()).replace('<h1>Khách hàng</h1>', ''));
    assert.equal((await page.evaluate(readMutualFriendEvidence, {targetUrl,profileName:'Khách hàng'})).status, 'unknown');
    assert.equal(result.status, 'confirmed');
  });
  await t.test('unrelated lower friends section cannot confirm', async () => {
    await page.setContent(fixture('') + row());
    assert.equal((await page.evaluate(readMutualFriendEvidence, {targetUrl,profileName:'Khách hàng'})).status, 'unknown');
  });
  await t.test('a separate bio avatar above a mutual count is not part of its row', async () => {
    assert.notEqual((await read(`<div><p>${avatar()}</p>${row('', '<span>2 bạn chung</span>')}</div>`)).status, 'confirmed');
    assert.notEqual((await read(row(avatar(), '<span>Tìm bạn chung để bán hàng</span>'))).status, 'confirmed');
  });
});
