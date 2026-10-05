const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const filename = path.join(__dirname, 'src/playwright/salework.js');
const sandbox = {
  module: { exports: {} }, __dirname: path.dirname(filename), Buffer,
  require: id => {
    if (id === 'fs' || id === 'path') return require(id);
    if (id.endsWith('/logger')) return { info() {}, warn() {}, error() {} };
    return {};
  },
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8') +
  '\nmodule.exports.normalizeImagesForZalo = normalizeImagesForZalo;', sandbox);
const { normalizeImagesForZalo } = sandbox.module.exports;

test('Zalo image conversion preserves the chat tab, DOM, draft and focus', async () => {
  const browser = await chromium.launch({ headless: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeko-zalo-images-'));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://zalo.test/chat', route => route.fulfill({
      contentType: 'text/html',
      body: '<div id="group">Target group</div><textarea id="draft">Unsent text</textarea>',
    }));
    await page.goto('https://zalo.test/chat');
    await page.locator('#draft').focus();
    const before = await page.content();
    let newPages = 0;
    context.on('page', () => { newPages++; });
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 4096; canvas.height = 2048;
      // Transparent PNG: normalization must composite against white.
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const source = path.join(dir, 'large.png');
    fs.writeFileSync(source, Buffer.from(png, 'base64'));
    const result = await normalizeImagesForZalo(page, [source]);
    assert.equal(result.length, 1);
    assert.notEqual(result[0], source);
    const jpeg = fs.readFileSync(result[0]);
    assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
    const dimensions = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: img.naturalWidth, height: img.naturalHeight,
        pixel: [...ctx.getImageData(0, 0, 1, 1).data] };
    }, jpeg.toString('base64'));
    assert.deepEqual(dimensions, { width: 2048, height: 1024, pixel: [255, 255, 255, 255] });
    assert.equal(newPages, 0);
    assert.equal(context.pages().length, 1);
    assert.equal(page.isClosed(), false);
    assert.equal(page.url(), 'https://zalo.test/chat');
    assert.equal(await page.content(), before);
    assert.equal(await page.locator('#draft').inputValue(), 'Unsent text');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');

    const invalid = path.join(dir, 'invalid.png');
    fs.writeFileSync(invalid, 'not an image');
    assert.equal((await normalizeImagesForZalo(page, [invalid]))[0], invalid);
    assert.equal(newPages, 0);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty input skips browser work; evaluation failure preserves original image', async () => {
  const empty = [];
  assert.equal(await normalizeImagesForZalo(null, empty), empty);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeko-zalo-fallback-'));
  try {
    const source = path.join(dir, 'image.png');
    fs.writeFileSync(source, 'fixture');
    const page = { evaluate: async () => { throw new Error('Page closed'); } };
    assert.equal((await normalizeImagesForZalo(page, [source]))[0], source);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
