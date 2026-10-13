const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { closeContentInfoDialog, dismissContentInfoDialog, readPostMedia } = require('./src/ctv/browser');

function fixture({ title = 'Giới thiệu về nội dung này', label = 'Đóng', hidden = false, disabled = false, duplicate = false, linked = false, nested = false, labelled = false } = {}) {
  let clicks = 0;
  const element = attrs => ({ getClientRects: () => [1], getAttribute: key => attrs[key] || null });
  const dialog = element(labelled ? { 'aria-labelledby': 'title' } : {});
  dialog.getClientRects = () => hidden ? [] : [1];
  const heading = { ...element({}), innerText: title, closest: () => dialog };
  const button = { ...element({ 'aria-label': label }), disabled,
    closest: selector => selector === 'a[href]' ? (linked ? {} : null) : nested ? {} : dialog,
    click: () => { clicks++; } };
  dialog.contains = e => e === heading;
  dialog.querySelectorAll = selector => selector.includes('heading') ? (labelled ? [] : [heading]) : duplicate ? [button, button] : [button];
  const run = () => vm.runInNewContext(`(${closeContentInfoDialog.toString()})()`, {
    document: { querySelectorAll: () => [dialog], getElementById: id => id === 'title' ? heading : null },
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
  return { run, clicks: () => clicks };
}

test('closes the Vietnamese and English content info dialogs, including labelled titles', () => {
  for (const options of [{}, { title: 'About this content', label: 'Close' }, { labelled: true }]) {
    const f = fixture(options);
    assert.equal(f.run(), true);
    assert.equal(f.clicks(), 1);
  }
});

test('does not click unrelated, hidden, disabled, ambiguous, linked or nested controls', () => {
  for (const options of [{ title: 'Đăng nhập' }, { title: 'Xác minh tài khoản' }, { title: 'Messenger' }, { hidden: true }, { disabled: true }, { duplicate: true }, { linked: true }, { nested: true }, { label: 'Xem thêm' }]) {
    const f = fixture(options);
    assert.equal(f.run(), false, JSON.stringify(options));
    assert.equal(f.clicks(), 0);
  }
});

test('dismissal reports only an actual click and respects cancellation', async () => {
  const logs = [];
  let evaluated = 0;
  const page = { evaluate: async fn => { assert.equal(fn, closeContentInfoDialog); evaluated++; return evaluated === 1; } };
  const report = (...args) => logs.push(args);
  await dismissContentInfoDialog(page, { report });
  await dismissContentInfoDialog(page, { report });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'popup_closed');
  await assert.rejects(dismissContentInfoDialog(page, { check: () => { throw Error('Đã dừng'); } }), /Đã dừng/);
  assert.equal(evaluated, 2);
});

test('caption reading dismisses a popup before scanning and after expanding See more', async () => {
  const events = [];
  const article = {
    isVisible: async () => true,
    evaluate: async fn => fn.name === 'isPostPinned' ? false
      : fn.toString().includes('getBoundingClientRect') ? true : 'Caption bán hàng',
    getByRole: () => ({ count: async () => 1, nth: () => ({ evaluate: async () => events.push('expand') }) }),
  };
  const page = {
    evaluate: async fn => { assert.equal(fn, closeContentInfoDialog); events.push('dismiss'); return false; },
    locator: () => ({ count: async () => 1, nth: () => article }),
  };
  const records = await readPostMedia(page, { captionsOnly: true });
  assert.deepEqual(events, ['dismiss', 'expand', 'dismiss']);
  assert.equal(records[0].caption, 'Caption bán hàng');
});
