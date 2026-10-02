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

test('snapshot reads detached blob previews without dynamic Function evaluation', async () => {
  const c = harness();
  c.Function = () => { throw new Error('CSP blocks unsafe-eval'); };
  const img = { tagName: 'IMG', src: 'blob:preview', getBoundingClientRect: () => ({width: 100, height: 100}) };
  const root = { querySelector: () => ({}), contains: () => false };
  const ta = { parentElement: root, getBoundingClientRect: () => ({width: 100, height: 45}) };
  c.document = { querySelector: () => ({ contains: el => el === img }),
    querySelectorAll: sel => sel.startsWith('textarea') ? [ta] : [img] };
  const state = await c._imageThreadState({ evaluate: async fn => fn() });
  assert.equal(state.threadSources[0], 'blob:preview');
  assert.equal(state.composerPresent, true);
  assert.equal(state.composerSources.length, 0);
});

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
    const run = c.sendMessage(page, '', ['photo.jpg'], null, async () => {});
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
  await assert.rejects(c.sendMessage(page, 'caption', ['photo.jpg'], null, async () => {}), /Chưa xác nhận đủ ảnh/);
});

test('ambiguous click never falls back to another send button', async () => {
  const c = harness();
  let clicks = 0;
  const page = { locator: () => ({ first: () => ({
    count: async () => 1,
    click: async () => { clicks++; throw new Error('timeout after dispatch'); },
  }) }) };
  await assert.rejects(c.clickSend(page, async () => {}), e => e.deliveryUnknown === true);
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

// A cleared draft alone must never allow a caption. Only a complete new album does.
for (const scenario of ['detached-previews', 'virtualized-image', 'draft-cleared', 'unchanged', 'draft-remains', 'missing-composer', 'complete-album', 'partial-album']) {
  test('image-to-caption transition: ' + scenario, async () => {
    const c = harness();
    const events = [];
    const base = { http: 83, threadBlob: 0, composerBlob: 0,
      threadSources: ['https://cdn/old'], composerSources: [], composerPresent: true };
    const pending = Array.from({length: 7}, (_, i) => 'blob:pending-' + i);
    const attached = { ...base, threadBlob: 7, threadSources: [...base.threadSources, ...pending] };
    let after = { ...base };
    if (scenario === 'virtualized-image') {
      attached.threadSources = ['https://cdn/old'];
      after.threadSources = ['https://cdn/new'];
    }
    if (scenario === 'draft-cleared') {
      attached.threadSources = base.threadSources;
      attached.composerSources = pending;
    }
    if (scenario === 'unchanged') after = attached;
    if (scenario === 'draft-remains') after.composerSources = pending;
    if (scenario === 'missing-composer') after.composerPresent = false;
    if (scenario === 'complete-album' || scenario === 'partial-album') {
      after.threadSources = Array.from({length: scenario === 'complete-album' ? 7 : 6}, (_, i) => 'https://cdn/new-' + i);
    }
    let snapshots = 0;
    c._imageThreadState = async () => ++snapshots === 1 ? attached : after;
    c.attachImages = async () => { events.push('attach'); return true; };
    c.clickSend = async () => { events.push('send'); return true; };
    const field = { waitFor: async () => {}, click: async () => {},
      fill: async () => events.push('caption'), evaluate: async () => {} };
    const page = { locator: () => ({ first: () => field }),
      waitForFunction: async () => {}, waitForLoadState: async () => {} };
    const run = c.sendMessage(page, 'caption', Array(7).fill('photo.jpg'), null, async () => {});
    if (scenario !== 'complete-album') {
      await assert.rejects(run, e => e.deliveryUnknown === true);
      assert.deepEqual(events, ['attach', 'send']);
    } else {
      await run;
      assert.deepEqual(events, ['attach', 'send', 'caption', 'send']);
    }
  });
}

test('second post in same group cannot reuse the first album as image confirmation', () => {
  const c = harness();
  const oldAlbum = ['https://cdn/first-1', 'https://cdn/first-2'];
  const before = { threadSources: oldAlbum, composerSources: ['blob:second-1', 'blob:second-2'] };
  const after = { composerPresent: true, composerSources: [], threadSources: oldAlbum };
  assert.equal(c._imageDeliveryReady(before, after, 2), false);
  after.threadSources = [...oldAlbum, 'https://cdn/second-1'];
  assert.equal(c._imageDeliveryReady(before, after, 2), false);
  after.threadSources.push('https://cdn/second-1'); // duplicate DOM nodes aren't two photos
  assert.equal(c._imageDeliveryReady(before, after, 2), false);
  after.threadSources.push('blob:second-2'); // local preview isn't a remote image
  assert.equal(c._imageDeliveryReady(before, after, 2), false);
  after.threadSources.push('https://cdn/second-2');
  assert.equal(c._imageDeliveryReady(before, after, 2), true);
});

test('unfinished upload stops before sending the album or caption', async () => {
  const c = harness();
  let sends = 0;
  c.clickSend = async () => { sends++; return true; };
  const page = {
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    $$: async () => [{ setInputFiles: async () => {} }],
    evaluate: async () => ({ local: 0, scoped: 0 }),
    waitForFunction: async () => {},
    waitForLoadState: async () => { throw Error('upload still pending'); },
  };
  await assert.rejects(c.sendMessage(page, 'caption', ['photo.jpg'], null, async () => {}), /tải ảnh hoàn tất/);
  assert.equal(sends, 0);
});
