const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { inspect, readProfileSnapshot } = require('./src/ctv/browser');

function snapshot({level = 1, hidden = false, friend = true, text = '', article = false} = {}) {
  const element = (innerText, extra = {}) => ({innerText, getClientRects: () => [1], getAttribute: () => null, ...extra});
  const heading = element('Linh Thảo', {
    getClientRects: () => hidden ? [] : [1], closest: () => article ? {} : null,
    matches: () => level === 1,
  });
  const root = element(text, {querySelectorAll(selector) {
    if (selector.startsWith('h1')) return [heading];
    if (selector.includes('button')) return friend ? [element('Thêm bạn bè')] : [];
    return [];
  }});
  return vm.runInNewContext(`(${readProfileSnapshot.toString()})()`, {
    document: {querySelectorAll: () => [root]}, getComputedStyle: () => ({visibility: 'visible'}),
  });
}

test('reads primary and alternative profile headings', () => {
  assert.equal(snapshot().name, 'Linh Thảo');
  assert.equal(snapshot({level: 2}).name, 'Linh Thảo');
  assert.equal(snapshot({level: 2}).personalEvidence, true);
});
test('ignores hidden headings, post headings and unverified secondary headings', () => {
  assert.equal(snapshot({hidden: true}), false);
  assert.equal(snapshot({article: true}), false);
  assert.equal(snapshot({level: 2, friend: false}), false);
});
test('recognizes unavailable profiles without waiting for a name', () => {
  assert.match(snapshot({hidden: true, text: "This content isn't available"}).blocked, /không xem được/);
});
function pageMock({checkpoint = false, timeout = true, actual = 'https://www.facebook.com/123'} = {}) {
  let checks = 0;
  return {
    goto: async () => {}, url: () => actual,
    locator: () => ({count: async () => checkpoint && ++checks > 1 ? 1 : 0}),
    waitForFunction: async () => {
      if (timeout) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      return {jsonValue: async () => ({name: '', blocked: 'Hồ sơ bị khóa hoặc không xem được', messageLinks: []}), dispose: async () => {}};
    },
  };
}
test('timeout explains unreadable profile and rechecks delayed login prompts', async () => {
  await assert.rejects(inspect(pageMock(), 'https://facebook.com/123'), /Không đọc được tên hồ sơ Facebook sau 30 giây/);
  await assert.rejects(inspect(pageMock({checkpoint: true}), 'https://facebook.com/123'), /Cần đăng nhập/);
});
test('blocked profile remains ineligible and redirects remain rejected', async () => {
  const result = await inspect(pageMock({timeout: false}), 'https://facebook.com/123');
  assert.equal(result.eligible, false);
  await assert.rejects(inspect(pageMock({timeout: false, actual: 'https://www.facebook.com/456'}), 'https://facebook.com/123'), /hồ sơ khác/);
});
