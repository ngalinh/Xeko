const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const noop = async () => {};
  const context = vm.createContext({
    require(name) {
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true, statSync: () => ({ size: 10 }) };
      if (name.endsWith('/logger')) return { info() {}, warn() {}, error() {} };
      if (name.endsWith('/delay')) return { randomDelay: noop, sleep: noop };
      return {};
    },
    module: { exports: {} }, __dirname, process: { env: {} },
    setTimeout: fn => { fn(); return 0; }, clearTimeout, Buffer,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/playwright/salework.js'), 'utf8'), context);
  vm.runInContext('screenshot = async () => {};', context);
  return context;
}

for (const outcome of ['timeout', 'exception', 'success']) {
  test('album submits once on verification ' + outcome, async () => {
    const c = harness();
    let attachments = 0, sends = 0;
    c.attachImages = async () => { attachments++; return true; };
    c._imageThreadState = async () => ({ http: 0, threadBlob: 0, composerBlob: 8 });
    c.clickSend = async () => { sends++; return true; };
    c.waitImageSent = async () => {
      if (outcome === 'exception') throw new Error('DOM detached');
      return outcome === 'success';
    };
    const page = {
      locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
      waitForLoadState: async () => {},
    };
    const run = c.sendMessage(page, '', ['photo.jpg']);
    if (outcome === 'success') await run;
    else await assert.rejects(run, e => e.deliveryUnknown === true);
    assert.equal(attachments, 1);
    assert.equal(sends, 1);
  });
}

test('unconfirmed attachment never sends', async () => {
  const c = harness();
  c.attachImages = async () => false;
  c.clickSend = async () => assert.fail('must not send');
  const page = { locator: () => ({ first: () => ({ waitFor: async () => {} }) }) };
  await assert.rejects(c.sendMessage(page, 'caption', ['photo.jpg']));
});

test('ambiguous click never falls back to another send button', async () => {
  const c = harness();
  let clicks = 0;
  const page = { locator: () => ({ first: () => ({
    count: async () => 1,
    click: async () => { clicks++; throw new Error('timeout after dispatch'); },
  }) }) };
  await assert.rejects(c.clickSend(page), e => e.deliveryUnknown === true);
  assert.equal(clicks, 1);
});

for (const failsDuringSet of [false, true]) {
  test('attachment uncertainty does not append files or paste again: set error=' + failsDuringSet, async () => {
    const c = harness();
    let sets = 0;
    const input = { setInputFiles: async () => {
      sets++;
      if (failsDuringSet) throw new Error('detached after change');
    } };
    const page = {
      $$: async () => [input, input],
      evaluate: async () => ({ local: 0, scoped: 0 }),
      waitForFunction: async () => { throw new Error('preview timeout'); },
      locator: () => assert.fail('must not fall back to menu or paste'),
    };
    assert.equal(await c.attachImages(page, ['photo.jpg']), false);
    assert.equal(sets, 1);
  });
}

test('mixed CDN and blob images confirm a complete album, excluding composer HTTP previews', async () => {
  const c = harness();
  const images = [
    ...Array.from({ length: 4 }, () => ({ tagName: 'IMG', src: 'https://cdn/photo', composer: false })),
    ...Array.from({ length: 4 }, () => ({ tagName: 'IMG', src: 'blob:photo', composer: false })),
    { tagName: 'IMG', src: 'https://cdn/preview', composer: true },
  ].map(img => ({ ...img, getBoundingClientRect: () => ({ width: 100, height: 100 }) }));
  const root = { querySelector: () => ({}), contains: el => el.composer, querySelectorAll: () => [] };
  const textarea = { parentElement: root };
  c.document = { querySelector: () => textarea, querySelectorAll: () => images };
  const page = {
    evaluate: async (fn, args) => fn(args),
    waitForFunction: async (fn, args) => assert.equal(fn(args), true),
    waitForLoadState: async () => {},
  };
  const before = { http: 0, threadBlob: 0, composerBlob: 8 };
  assert.equal(await c.waitImageSent(page, 8, before), true);
  const state = await c._imageThreadState(page);
  assert.equal(state.http, 4);
  assert.equal(state.threadBlob, 4);
});
