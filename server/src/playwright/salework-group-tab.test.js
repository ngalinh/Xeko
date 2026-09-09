const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, 'salework.js'), 'utf8');
const context = vm.createContext({ screenshot: async () => {}, sleep: async () => {}, logger: { info() {} } });
vm.runInContext(source.slice(source.indexOf('async function clickFilterTab('), source.indexOf('// Bấm nút Gửi')), context);
function button(label, active = false, works = true) {
  return {
    active, clicks: 0,
    count: async () => 1, waitFor: async () => {}, hover: async () => {}, scrollIntoViewIfNeeded: async () => {},
    evaluate: async function(fn) { return String(fn).includes('classList') ? this.active : label; },
    click: async function() { this.clicks++; if (works) this.active = !this.active; },
    first() { return this; }
  };
}
function pageFor(buttons, fallback) {
  const missing = { count: async () => 0, waitFor: async () => { throw Error('missing'); }, first() { return this; } };
  return { locator: sel => sel === '.filter-bar .filter-btn'
    ? { count: async () => buttons.length, nth: i => buttons[i] || missing }
    : fallback || missing };
}
test('selects Groups before touching search and does not toggle it off on retry', async () => {
  const group = button('nhóm');
  const page = pageFor([button('thư'), button('chưa đọc'), button('cá nhân'), group]);
  let searches = 0;
  page.$ = async () => { assert.equal(group.active, true); searches++; throw Error('search reached'); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(context.searchAndClickGroup(page, 'Test'), /search reached/);
  }
  assert.equal(searches, 2);
  assert.equal(group.clicks, 1);
});
test('already active Groups is not clicked', async () => {
  const group = button('nhóm', true);
  assert.equal(await context.clickFilterTab(pageFor([button(''), button(''), button(''), group]), 'nhóm', 3), true);
  assert.equal(group.clicks, 0);
});
test('tooltip fallback selects the matching button', async () => {
  const group = button('nhóm');
  assert.equal(await context.clickFilterTab(pageFor([group]), 'nhóm', 3), true);
  assert.equal(group.clicks, 1);
});
test('selector fallback preserves active state', async () => {
  const group = button('nhóm', true);
  assert.equal(await context.clickFilterTab(pageFor([], group), 'nhóm', 3, ['[title="Nhóm"]']), true);
  assert.equal(group.clicks, 0);
});
test('selector fallback requires active state after click', async () => {
  assert.equal(await context.clickFilterTab(pageFor([], button('nhóm', false, false)), 'nhóm', 3, ['[title="Nhóm"]']), false);
});
test('missing Groups stops before searching', async () => {
  const page = pageFor([]);
  page.$ = async () => { throw Error('search must not run'); };
  await assert.rejects(context.searchAndClickGroup(page, 'Test'), /Không chọn được tab Nhóm/);
});
