'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { readImageState, waitForImages } = require('./src/playwright/fb-image-guard');
const ready = { count: 2, rejected: false, busy: false, readyButton: true };

function scenario(states, options = {}) {
  let tick = 0, calls = 0;
  return {
    run: () => waitForImages({ evaluate: async () => states[Math.min(calls++, states.length - 1)] }, 2, [],
      { timeoutMs: 3000, stableMs: 600, now: () => tick, pause: async ms => { tick += ms; }, ...options }),
    calls: () => calls,
  };
}
test('waits through slow uploads before accepting stable complete previews', async () => {
  const s = scenario([{ ...ready, count: 0 }, { ...ready, count: 1 }, { ...ready, busy: true }, ready]);
  assert.equal(await s.run(), true);
  assert.ok(s.calls() >= 6);
});
test('missing, partial, extra, busy, or disabled previews cannot pass', async t => {
  for (const state of [{ ...ready, count: 0 }, { ...ready, count: 1 }, { ...ready, count: 3 },
    { ...ready, busy: true }, { ...ready, readyButton: false }]) {
    await t.test(JSON.stringify(state), async () => {
      await assert.rejects(scenario([state]).run(), /đã dừng để tránh đăng thiếu hình/);
    });
  }
});
test('explicit upload rejection fails immediately even with enough previews', async () => {
  const s = scenario([{ ...ready, rejected: true }]);
  await assert.rejects(s.run(), /Facebook từ chối/);
  assert.equal(s.calls(), 1);
});
test('readiness must remain stable after a preview disappears', async () => {
  const s = scenario([ready, { ...ready, count: 1 }, ready]);
  assert.equal(await s.run(), true);
  assert.equal(s.calls(), 5);
});
test('detached composer errors propagate instead of allowing submit', async () => {
  await assert.rejects(waitForImages({ evaluate: async () => { throw new Error('detached'); } }, 1, []), /detached/);
});
test('snapshot excludes baseline avatars, broken and hidden images; accepts remote previews', () => {
  const old = global.getComputedStyle;
  global.getComputedStyle = () => ({ visibility: 'visible' });
  const img = (src, extra = {}) => ({ currentSrc: src, complete: true, naturalWidth: 200, naturalHeight: 200,
    getClientRects: () => [1], getAttribute: () => null, ...extra });
  const images = [img('avatar'), img('blob:one'), img('https://scontent.example/two'),
    img('blob:broken', { naturalWidth: 0 }), img('blob:hidden', { getClientRects: () => [] })];
  const button = { getClientRects: () => [1], getAttribute: k => k === 'aria-label' ? 'Tiếp' : null };
  try {
    const state = readImageState({ textContent: '', querySelectorAll: selector =>
      selector === 'img' ? images : selector.includes('progressbar') ? [] : [button] }, ['avatar']);
    assert.deepEqual(state, ready);
  } finally { global.getComputedStyle = old; }
});

function loadProxy(files) {
  let requests = 0;
  class FormData {
    append() {}
    getHeaders() { return {}; }
  }
  const context = {
    module: { exports: {} }, exports: {}, console, process: { env: { PLAYWRIGHT_LOCAL_URL: 'https://worker.invalid', LOCAL_API_KEY: 'test' } },
    require: name => {
      if (name === 'form-data') return FormData;
      if (name === './src/utils/api-key') return { assertConfigured() {} };
      if (name === 'fs') return {
        existsSync: file => Object.hasOwn(files, file),
        statSync: file => ({ isFile: () => files[file] !== 'directory', size: files[file] }),
        createReadStream: () => { throw new Error('should validate whole batch first'); },
      };
      return require(name);
    },
    fetch: async () => { requests++; throw new Error('unexpected network'); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'playwright-proxy.js'), 'utf8'), context);
  return { proxy: context.module.exports, requests: () => requests };
}
test('proxy rejects missing, empty and directory paths before sending caption', async t => {
  for (const files of [{ 'good.jpg': 100 }, { 'good.jpg': 100, 'bad.jpg': 0 },
    { 'good.jpg': 100, 'bad.jpg': 'directory' }]) {
    await t.test(JSON.stringify(files), async () => {
      const s = loadProxy(files);
      await assert.rejects(s.proxy.postToPersonal('caption', ['good.jpg', 'bad.jpg']), /Ảnh không tồn tại hoặc rỗng/);
      assert.equal(s.requests(), 0);
    });
  }
});

test('attachment stage can precede caption, but submit stage requires enabled button', async () => {
  const state = { ...ready, readyButton: false };
  assert.equal(await scenario([state], { requireReadyButton: false }).run(), true);
  await assert.rejects(scenario([state]).run(), /đã dừng/);
});

function loadAttachmentFlow(wait) {
  const source = fs.readFileSync(path.join(__dirname, 'src/playwright/post.js'), 'utf8');
  const start = source.indexOf('const pendingImageChecks = new WeakMap();');
  const end = source.indexOf('// Nhận diện URL permalink', start);
  const context = {
    require: () => ({ waitForImages: wait }),
    logger: { info() {} },
    saveDebugShot: async () => 'test.png',
    module: { exports: {} },
  };
  vm.runInNewContext(source.slice(start, end) +
    '\nmodule.exports = { attach: _attachImagesImpl, verify: verifyImagesBeforeSubmit };', context);
  return context.module.exports;
}
function fakeComposer(inputs) {
  const composer = {
    locator: sel => sel === 'img' ? { evaluateAll: async () => ['avatar'] }
      : sel === 'input[type="file"]' ? { elementHandles: async () => inputs }
      : { first: () => ({ click: async () => { throw new Error('no photo button'); } }) },
  };
  const page = {
    locator: () => ({ filter: () => ({ count: async () => 1, first: () => composer }) }),
    waitForEvent: async () => null,
  };
  return { page, composer };
}
test('upload selection stays scoped and prefers image-first multiple input', async () => {
  const chosen = [];
  const input = (accept, multiple) => ({
    getAttribute: async name => name === 'accept' ? accept : multiple ? '' : null,
    setInputFiles: async files => chosen.push({ accept, files }),
  });
  const { page } = fakeComposer([input('video/*', true), input('image/*', true)]);
  let readyChecks = 0;
  const flow = loadAttachmentFlow(async () => { readyChecks++; return true; });
  assert.equal(await flow.attach(page, ['one.jpg', 'two.jpg']), true);
  assert.equal(readyChecks, 0, 'caption must not wait on the upload guard');
  await flow.verify(page);
  assert.deepEqual(chosen, [{ accept: 'image/*', files: ['one.jpg', 'two.jpg'] }]);
  assert.equal(readyChecks, 1);
});
test('video-only input cannot be used as successful image attachment', async () => {
  let selections = 0;
  const { page } = fakeComposer([{
    getAttribute: async name => name === 'accept' ? 'video/*' : '',
    setInputFiles: async () => { selections++; },
  }]);
  const flow = loadAttachmentFlow(async () => { throw new Error('must not reach readiness'); });
  await assert.rejects(flow.attach(page, ['one.jpg']), /no photo button/);
  assert.equal(selections, 0);
});
test('lost images after caption stop submit; text-only posts bypass image checks', async () => {
  const { page } = fakeComposer([{
    getAttribute: async name => name === 'accept' ? 'image/*' : '',
    setInputFiles: async () => {},
  }]);
  const flow = loadAttachmentFlow(async () => {
    throw new Error('missing preview');
  });
  await flow.verify({});
  await flow.attach(page, ['one.jpg']);
  await assert.rejects(flow.verify(page), /missing preview/);
});

test('quick-post reaches caption before a failed image guard can stop submit', async () => {
  const { page } = fakeComposer([{
    getAttribute: async name => name === 'accept' ? 'image/*' : '',
    setInputFiles: async () => {},
  }]);
  const events = [];
  const flow = loadAttachmentFlow(async () => {
    events.push('verify-images');
    throw new Error('missing preview');
  });
  const source = fs.readFileSync(path.join(__dirname, 'src/playwright/post.js'), 'utf8');
  const start = source.indexOf('async function qpStep2FillContent(');
  const end = source.indexOf('async function qpStep3ClickNext(', start);
  const context = {
    attachImages: flow.attach,
    typeMessage: async () => { events.push('caption'); return true; },
    randomDelay: async () => {},
    _qpLog: async () => {},
    _qpScreenshot: async () => 'test.png',
    module: { exports: {} },
  };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = qpStep2FillContent;', context);
  assert.equal(await context.module.exports(page, [], 'caption', ['one.jpg']), true);
  assert.deepEqual(events, ['caption']);
  await assert.rejects(flow.verify(page), /missing preview/);
  assert.deepEqual(events, ['caption', 'verify-images']);
});
