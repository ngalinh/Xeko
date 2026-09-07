const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = readFileSync(__dirname + '/src/playwright/salework.js', 'utf8');
const sendSource = source.slice(source.indexOf('async function sendMessage('), source.indexOf('// Đếm ảnh liên quan'));
function setup({ image = true, texts = [true], states = [], clickError = false } = {}) {
  const calls = [];
  const ta = { first() { return this; }, waitFor: async () => {}, fill: async () => calls.push('fill') };
  const page = { locator: () => ta, waitForLoadState: async () => {} };
  const context = {
    logger: { info() {} }, fs: { existsSync: () => true, statSync: () => ({ size: 1 }) },
    path: { basename: x => x }, sleep: async () => {},
    attachImages: async () => { calls.push('attach'); return true; },
    _imageThreadState: async () => ({}),
    clickSend: async () => { calls.push('click'); if (clickError) throw Error('ambiguous'); return true; },
    waitImageSent: async () => { calls.push('imageVerified'); return image; },
    textThreadState: async () => states.shift() || ({ matches: 0, draft: 'hello', canSend: true }),
    waitTextSent: async () => { calls.push('textVerified'); return texts.shift(); },
  };
  vm.createContext(context);
  vm.runInContext(sendSource, context);
  return { calls, run: () => context.sendMessage(page, 'hello', ['a.jpg']) };
}
test('unconfirmed images never resend or send text', async () => {
  const s = setup({ image: false });
  await assert.rejects(s.run(), /Chưa xác nhận được ảnh/);
  assert.deepEqual(s.calls, ['attach', 'click', 'imageVerified']);
});
test('confirmed images precede text', async () => {
  const s = setup(); await s.run();
  assert.deepEqual(s.calls, ['attach', 'click', 'imageVerified', 'fill', 'click', 'textVerified']);
});
test('text retained in composer retries once without reattaching images or refilling', async () => {
  const s = setup({ texts: [false, true] }); await s.run();
  assert.equal(s.calls.filter(x => x === 'attach').length, 1);
  assert.equal(s.calls.filter(x => x === 'fill').length, 1);
  assert.equal(s.calls.filter(x => x === 'click').length, 3);
});
test('cleared composer without visible text is ambiguous and does not retry', async () => {
  const s = setup({ texts: [false], states: [{ matches: 0 }, { matches: 0, draft: '', canSend: true }] });
  await assert.rejects(s.run(), /Chưa xác nhận được text/);
  assert.equal(s.calls.filter(x => x === 'click').length, 2);
});
test('late text appearance prevents retry', async () => {
  const s = setup({ texts: [false], states: [{ matches: 1 }, { matches: 2, draft: '', canSend: false }] });
  await s.run();
  assert.equal(s.calls.filter(x => x === 'click').length, 2);
});
test('text retries stop after second failure', async () => {
  const s = setup({ texts: [false, false] });
  await assert.rejects(s.run(), /2 lần thử/);
  assert.equal(s.calls.filter(x => x === 'click').length, 3);
});
test('ambiguous image click never replays', async () => {
  const s = setup({ clickError: true });
  await assert.rejects(s.run(), /ambiguous/);
  assert.deepEqual(s.calls, ['attach', 'click']);
});
test('mixed CDN and blob images are confirmed together, excluding HTTP previews', async () => {
  const context = { logger: { info() {}, warn() {} }, sleep: async () => {} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function _imageThreadState('), source.indexOf('// Compare exact visible text')), context);
  const img = (src, composer = false) => ({
    tagName: 'IMG', currentSrc: src, composer,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  });
  const images = [
    ...Array.from({ length: 10 }, (_, i) => img('https://cdn/' + i)),
    ...Array.from({ length: 9 }, (_, i) => img('blob:' + i)),
    img('https://cdn/preview', true),
  ];
  const root = {
    querySelector: () => ({}), contains: el => el.composer,
    querySelectorAll: () => images.filter(el => el.composer),
  };
  context.document = {
    querySelector: () => ({ parentElement: root }),
    querySelectorAll: () => images,
  };
  const page = {
    evaluate: async (fn, arg) => fn(arg),
    waitForFunction: async (fn, arg) => { assert.equal(fn(arg), true); },
    waitForLoadState: async () => {},
  };
  const state = await context._imageThreadState(page);
  assert.equal(state.http, 10);
  assert.equal(state.threadBlob, 9);
  assert.equal(await context.waitImageSent(page, 19, { http: 0, threadBlob: 0 }), true);
});

