// Offline regression tests: no Facebook access or browser dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'src/playwright/post.js'), 'utf8');
const normalization = source.slice(source.indexOf('async function normalizeImagesForFb('), source.indexOf('// setInputFiles/preview'));
const attachment = source.slice(source.indexOf('async function attachImages('), source.indexOf('async function _attachImagesImpl('));
function fixture({ closed = false, failure = false } = {}) {
  const files = new Map([['/images/a.webp', Buffer.from('webp')], ['/images/a.png', Buffer.from('png')], ['/images/a.fb.jpg', Buffer.from('original')]]);
  const page = new EventEmitter();
  page.isClosed = () => closed;
  page.context = () => ({ newPage: async () => ({ goto: async () => {}, close: async () => {}, evaluate: async () => Buffer.from('jpeg').toString('base64') }) });
  const context = {
    path, Buffer, randomUUID, FB_IMG_MAX_EDGE: 2048, FB_IMG_JPEG_QUALITY: 0.9,
    logger: { info() {}, warn() {} }, _fbImageIsRisky: () => true,
    fs: {
      existsSync: name => files.has(name),
      statSync: name => ({ isFile: () => files.has(name), size: files.get(name)?.length || 0 }),
      readFileSync: name => files.get(name),
      writeFileSync: (name, data) => files.set(name, data),
      unlinkSync: name => files.delete(name),
    },
    _attachImagesImpl: async (_page, paths) => {
      for (const name of paths) assert.ok(files.has(name));
      if (failure) throw new Error('partial upload');
      return true;
    },
  };
  vm.createContext(context);
  vm.runInContext(normalization + attachment, context);
  return { files, page, context };
}
for (const failure of [false, true]) {
  test(`converted files survive attachment ${failure ? 'failure' : 'success'} until page close`, async () => {
    const { files, page, context } = fixture({ failure });
    const pending = context.attachImages(page, ['/images/a.webp', '/images/a.png']);
    if (failure) await assert.rejects(pending, /partial upload/);
    else assert.equal(await pending, true);
    assert.equal(files.size, 5, 'both converted files remain available for delayed browser reads');
    assert.equal(files.get('/images/a.fb.jpg').toString(), 'original');
    page.emit('close');
    assert.equal(files.size, 3, 'cleanup preserves all original files');
  });
}
test('concurrent conversions of the same sources have distinct paths', async () => {
  const { context, page, files } = fixture();
  const batches = await Promise.all([context.normalizeImagesForFb(page, ['/images/a.webp', '/images/a.png']), context.normalizeImagesForFb(page, ['/images/a.webp', '/images/a.png'])]);
  const paths = batches.flatMap(batch => Array.from(batch.paths));
  assert.equal(new Set(paths).size, 4);
  assert.equal(files.size, 7);
});
test('page closed during normalization cleans converted files without attaching', async () => {
  const { context, page, files } = fixture({ closed: true });
  context._attachImagesImpl = async () => assert.fail('must not attach to closed page');
  await assert.rejects(context.attachImages(page, ['/images/a.webp']), /đã đóng/);
  assert.equal(files.size, 3);
});
test('empty attachment creates no files or close listeners', async () => {
  const { context, page, files } = fixture();
  assert.equal(await context.attachImages(page, []), true);
  assert.equal(files.size, 3);
  assert.equal(page.listenerCount('close'), 0);
});
