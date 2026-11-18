const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateImageUrl, createProductDraft } = require('./src/ai/product-draft');
const url = 'https://slimages.macysassets.com/is/image/MCY/products/1/optimized/41107501_fpx.tif?wid=2000&fmt=jpg';
const response = () => new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
test('rejects arbitrary hosts, credentials, ports and non-product paths', () => {
  for (const value of ['http://localhost/image', 'https://example.com/image', url.replace('https://', 'https://user@'), url.replace('.com/', '.com:444/'), url.replace('/products/', '/other/')]) {
    assert.throws(() => validateImageUrl(value));
  }
  assert.equal(validateImageUrl(url), url);
});
test('downloads all selected images, generates from max five, persists a passive draft and cleans temp files', async () => {
  let files;
  const result = await createProductDraft({ title: 'Advent Calendar', images: Array.from({length: 6}, (_, i) => url + '&n=' + i), price: '$99' }, {
    fetchFn: async (_, options) => { assert.equal(options.redirect, 'error'); return response(); },
    suggestContent: async (paths, guide) => { assert.equal(paths.length, 5); assert.match(guide, /\$99/); return ['Bài nháp']; },
    persistImages: async paths => { files = [...paths]; assert.ok(paths.every(p => fs.existsSync(p))); return paths.map((_, i) => '/api/image/test/' + i + '.jpg'); },
    create: item => { assert.deepEqual(item.profiles, []); assert.equal(item.images.length, 6); assert.equal(item.body, 'Bài nháp'); return { id: 12, ...item }; },
  });
  assert.equal(result.id, 12);
  assert.ok(files.every(p => !fs.existsSync(p)));
});
test('download failure or empty AI output never creates content', async () => {
  for (const failDownload of [true, false]) {
    let created = false;
    await assert.rejects(createProductDraft({ title: 'Product', images: [url] }, {
      fetchFn: async () => failDownload ? new Response('no', { status: 403 }) : response(),
      suggestContent: async () => [],
      persistImages: async () => { throw new Error('Must not persist'); },
      create: () => { created = true; },
    }));
    assert.equal(created, false);
  }
});
test('partial image persistence does not create a draft', async () => {
  await assert.rejects(createProductDraft({ title: 'Product', images: [url] }, {
    fetchFn: async () => response(), suggestContent: async () => ['Text'],
    persistImages: async () => [], create: () => assert.fail('Must not create'),
  }), /Chưa lưu đủ ảnh/);
});
