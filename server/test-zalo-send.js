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
  c.document = { querySelectorAll: sel => sel.startsWith('textarea') ? [ta] : [img] };
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
  await assert.rejects(c.sendMessage(page, 'caption', ['photo.jpg'], null, async () => {}));
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

// Draft disappearance alone must not allow captions or report success.
for (const scenario of ['detached-previews', 'virtualized-image', 'draft-cleared', 'unchanged', 'draft-remains', 'missing-composer', 'full-album', 'partial-album']) {
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
    if (scenario === 'full-album') after.threadSources = pending.map((_, i) => 'https://cdn/new-' + i);
    if (scenario === 'partial-album') after.threadSources = ['https://cdn/new-0'];
    let snapshots = 0;
    c._imageThreadState = async () => ++snapshots === 1 ? base : snapshots === 2 ? attached : after;
    c.attachImages = async () => { events.push('attach'); return true; };
    c.clickSend = async () => { events.push('send'); return true; };
    const field = { waitFor: async () => {}, click: async () => {},
      fill: async () => events.push('caption'), evaluate: async () => {} };
    const page = { locator: () => ({ first: () => field }),
      waitForFunction: async () => {}, waitForLoadState: async () => {} };
    const run = c.sendMessage(page, 'caption', Array(7).fill('photo.jpg'), null, async () => {});
    if (scenario !== 'full-album') {
      await assert.rejects(run, e => e.deliveryUnknown === true);
      assert.deepEqual(events, ['attach', 'send']);
    } else {
      await run;
      assert.deepEqual(events, ['attach', 'send', 'caption', 'send']);
    }
  });
}

for (const expected of [4, 6]) {
  test(`delivery requires all ${expected} remote images, deduplicated`, () => {
    const c = harness();
    const before = { threadSources: ['https://cdn/old'], composerSources: ['blob:preview'] };
    const after = { composerPresent: true, composerSources: [], threadSources: [] };
    assert.equal(c._imageDeliveryReady(before, after, expected), false);
    after.threadSources = Array(expected).fill('https://cdn/one');
    assert.equal(c._imageDeliveryReady(before, after, expected), false);
    after.threadSources = Array.from({length: expected - 1}, (_, i) => 'https://cdn/new-' + i);
    assert.equal(c._imageDeliveryReady(before, after, expected), false);
    after.threadSources.push('blob:last-preview');
    assert.equal(c._imageDeliveryReady(before, after, expected), false);
    after.threadSources[expected - 1] = 'https://cdn/last';
    assert.equal(c._imageDeliveryReady(before, after, expected), true);
  });
}

test('draft evidence deduplicates nested image nodes and excludes historical images', () => {
  const c = harness();
  const before = { threadSources: ['https://cdn/old', 'blob:old'], composerSources: [] };
  const after = { threadSources: ['https://cdn/old', 'https://cdn/lazy-history', 'blob:old', 'blob:new'],
    composerSources: ['blob:new', 'blob:new', 'https://cdn/draft'] };
  assert.deepEqual(Array.from(c._newDraftImageSources(before, after)), ['blob:new', 'https://cdn/draft']);
});

test('nested preview wrappers cannot make two attached images look like six', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.ZALO_TEST_BROWSER_CHANNEL ? {channel: process.env.ZALO_TEST_BROWSER_CHANNEL} : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>img,.preview,.thumb{width:100px;height:100px;display:block}</style>
      <img src="https://cdn/history"><section><textarea class="msg-textarea"></textarea>
      <div id="draft"></div><button class="send-btn">Send</button></section>`);
    const c = harness();
    await page.locator('#draft').evaluate(el => {
      for (let i = 0; i < 2; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'preview';
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        const img = document.createElement('img');
        img.src = 'blob:preview-' + i;
        thumb.append(img); wrap.append(thumb); el.append(wrap);
      }
    });
    const previewHtml = await page.locator('#draft').innerHTML();
    await page.locator('#draft').evaluate(el => { el.innerHTML = ''; });
    const originalEvaluate = page.evaluate.bind(page);
    let sets = 0;
    const fakePage = {
      evaluate: originalEvaluate,
      waitForFunction: page.waitForFunction.bind(page),
      waitForLoadState: async () => {},
      $$: async () => [{ setInputFiles: async () => { sets++; await page.locator('#draft').evaluate((el, html) => { el.innerHTML = html; }, previewHtml); } }],
      locator: () => assert.fail('must not append again'),
    };
    assert.equal(await c.attachImages(fakePage, Array(6).fill('photo.jpg')), false);
    assert.equal(sets, 1);
  } finally { await browser.close(); }
});
