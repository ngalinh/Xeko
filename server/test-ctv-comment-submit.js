const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./src/playwright/post'), 'utf8');
const fn = source.slice(source.indexOf('async function postComment('), source.indexOf('\nmodule.exports', source.indexOf('async function postComment(')));
function setup({ paste = true, submit = true, hiddenFirst = false } = {}) {
  let draft = '', opened = !hiddenFirst, closed = false;
  const keys = [];
  const box = { isVisible: async () => true, scrollIntoViewIfNeeded: async () => {}, click: async () => {},
    innerText: async () => draft, textContent: async () => draft,
    press: async key => { keys.push(key); if (submit) draft = ''; } };
  const page = { goto: async () => {}, close: async () => { closed = true; }, mouse: { wheel: async () => {} },
    $$: async selector => selector.includes('contenteditable') ? (opened ? [box] : []) : [
      { isVisible: async () => false, click: async () => { throw Error('hidden trigger clicked'); } },
      { isVisible: async () => true, click: async () => { opened = true; } },
    ] };
  const run = vm.runInNewContext(fn + '\npostComment', {
    logger: { info() {}, error() {}, warn() {} }, setProfile() {},
    getBrowser: async () => ({ newPage: async () => page }), randomDelay: async () => {},
    pasteText: async (_, text) => { if (paste) draft = text; },
  });
  return { run: () => run({ profile: 'test', postUrl: 'https://www.facebook.com/123', message: 'Check tin nhắn' }), keys, closed: () => closed };
}
test('comment finds visible trigger after hidden match and submits to the selected composer', async () => {
  const s = setup({ hiddenFirst: true });
  assert.equal((await s.run()).success, true);
  assert.deepEqual(s.keys, ['Control+Enter']);
  assert.equal(s.closed(), true);
});
test('failed paste cannot be reported as a successful comment', async () => {
  const s = setup({ paste: false });
  const result = await s.run();
  assert.equal(result.success, false);
  assert.match(result.error, /chưa vào đúng ô/);
  assert.deepEqual(s.keys, []);
});
test('unsent draft after both submit attempts reports failure', async () => {
  const s = setup({ submit: false });
  const result = await s.run();
  assert.equal(result.success, false);
  assert.match(result.error, /vẫn còn trong ô soạn/);
  assert.deepEqual(s.keys, ['Control+Enter', 'Enter']);
  assert.equal(s.closed(), true);
});
