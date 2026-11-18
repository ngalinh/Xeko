const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
for (const file of ['index.html', 'get-deal-test.html']) {
  test(file + ': extracts images, saves selected images and opens the draft', async () => {
    const dom = new JSDOM(read(file), { url: 'https://example.com/b/member/' + file, runScripts: 'outside-only' });
    const w = dom.window;
    const root = w.document.querySelector('[data-deal-app]');
    const get = id => root.querySelector('[data-deal-id="' + id + '"]');
    const calls = [];
    const images = ['https://example.com/1.jpg', 'https://example.com/2.jpg'];
    w.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => url.endsWith('/api/get-deal')
        ? { price: '$99', images, debug: { pageTitle: 'Product' }, screenshotFile: 'shot.png' }
        : { item: { id: 42, body: 'Nội dung nháp', images: [images[0]] } } };
    };
    const opened = [];
    w.switchPage = async page => opened.push(page);
    w.openContentModal = async id => opened.push(id);
    w.eval(read('product-deal.js'));
    get('url').value = 'https://www.macys.com/shop/product/test';
    get('go').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0].url, 'https://example.com/b/member/api/get-deal'.replace('https://example.com', ''));
    assert.equal(root.querySelectorAll('.draft-image').length, 2);
    assert.equal(get('draft-panel').hidden, false);
    root.querySelectorAll('.draft-image')[1].checked = false;
    get('create-draft').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls[1].body.images, [images[0]]);
    assert.equal(get('draft-preview').textContent, 'Nội dung nháp');
    assert.equal(get('draft-library').hidden, false);
    get('draft-library').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, ['drafts', 42]);
    assert.equal(calls.length, 2, 'does not request posting or scheduling');
    dom.window.close();
  });
}
test('failed extraction shows feedback and re-enables retry', async () => {
  const dom = new JSDOM(read('get-deal-test.html'), { url:'https://example.com/get-deal-test.html', runScripts:'outside-only' });
  const w = dom.window;
  w.fetch = async () => ({ ok:false, json:async () => ({ error:'Không lấy được sản phẩm' }) });
  w.eval(read('product-deal.js'));
  w.document.querySelector('[data-deal-id=url]').value = 'https://example.com/item';
  const button = w.document.querySelector('[data-deal-id=go]');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.match(w.document.querySelector('[data-deal-id=error]').textContent, /Không lấy được/);
  assert.equal(w.document.querySelector('[data-deal-id=draft-panel]').hidden, true);
  dom.window.close();
});
