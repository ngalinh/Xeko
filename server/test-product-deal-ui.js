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
    const historyCalls = [];
    const images = ['https://example.com/1.jpg', 'https://example.com/2.jpg'];
    w.fetch = async (url, opts) => {
      if (url.includes('/api/deal-history')) { historyCalls.push(url); return { ok: true, json: async () => [] }; }
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

    // Lịch sử lấy deal: tải lúc khởi tạo trang và tải lại sau khi lấy deal thành công.
    assert.ok(historyCalls.length >= 2, 'phải gọi /api/deal-history lúc khởi tạo và sau khi lấy deal xong');
    assert.match(get('history-body').textContent, /Chưa có lịch sử lấy deal/);

    // Giá sản phẩm là 1 mục riêng, hiện sau khi lấy deal.
    assert.equal(get('price-section').hidden, false);
    assert.equal(get('price-section').classList.contains('no-price'), false);
    assert.equal(get('price').textContent, '$99');

    // Hình ảnh sản phẩm là 1 mục riêng, có thanh công cụ Chọn tất cả / Bỏ chọn tất cả / Tải tất cả ảnh + đếm số đã chọn.
    assert.equal(get('images-section').hidden, false);
    assert.equal(get('images-toolbar').hidden, false);
    assert.equal(get('images-selected-count').textContent, 'Đã chọn 2/2 ảnh');
    get('images-select-all').click();
    assert.deepEqual([...root.querySelectorAll('.draft-image')].map(cb => cb.checked), [false, false]);
    assert.equal(get('images-selected-count').textContent, 'Đã chọn 0/2 ảnh');
    get('images-select-all').click();
    assert.deepEqual([...root.querySelectorAll('.draft-image')].map(cb => cb.checked), [true, true]);
    assert.equal(get('images-selected-count').textContent, 'Đã chọn 2/2 ảnh');

    // Link ảnh N (không phải "Mở ảnh lớn N") và nút tải chỉ còn icon.
    const firstLink = root.querySelectorAll('.deal-image a')[0];
    assert.equal(firstLink.textContent, '');
    assert.equal(firstLink.target, '_blank');
    assert.equal(firstLink.href, images[0]);
    assert.ok(firstLink.querySelector('img'));
    assert.doesNotMatch(root.querySelector('.deal-image').textContent, /Dùng ảnh|Link ảnh/);
    assert.equal(get('images-select-all').type, 'checkbox');
    assert.equal(get('images-select-none'), null);
    assert.equal(get('images-download-all').textContent.trim(), 'Download all');
    assert.ok(get('images-download-all').querySelector('svg'));
    const secondChoice = root.querySelectorAll('.draft-image')[1];
    secondChoice.click();
    assert.equal(get('images-select-all').indeterminate, true);
    assert.equal(get('images-select-all').checked, false);
    get('images-select-all').click();
    assert.equal(get('images-select-all').indeterminate, false);
    assert.equal(secondChoice.checked, true);
    const firstDownloadBtn = root.querySelectorAll('.deal-image .dl-icon-btn')[0];
    assert.equal(firstDownloadBtn.textContent.trim(), '');
    assert.ok(firstDownloadBtn.querySelector('svg'));

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

for (const file of ['index.html', 'get-deal-test.html']) {
  test(file + ': groups exact color URLs and selects only one group', async () => {
    const dom = new JSDOM(read(file), { url: 'https://example.com/', runScripts: 'outside-only' });
    const w = dom.window;
    const root = w.document.querySelector('[data-deal-app]');
    const get = id => root.querySelector('[data-deal-id="' + id + '"]');
    const images = ['https://example.com/navy.jpg', 'https://example.com/red.jpg', 'https://example.com/back.jpg'];
    w.fetch = async url => ({ ok: true, json: async () => url.includes('deal-history') ? [] : {
      images, debug: { colors: [
        { label: null, images: [images[0], images[2]] },
        { label: 'Color: Red <b>test</b>', images: [images[1], images[0], 'javascript:alert(1)'] },
      ] },
    } });
    w.eval(read('product-deal.js'));
    get('url').value = 'https://www.macys.com/shop/product/test?swatchColor=Dark+Night+Navy';
    get('go').click();
    await new Promise(resolve => setImmediate(resolve));
    const groups = root.querySelectorAll('.deal-color-group');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelector('h3').textContent, 'Dark Night Navy · 2 ảnh');
    assert.equal(groups[1].querySelector('h3').textContent, 'Red <b>test</b> · 1 ảnh');
    assert.equal(groups[1].querySelector('h3 b'), null);
    assert.deepEqual([...groups[0].querySelectorAll('.draft-image')].map(cb => cb.value), [images[0], images[2]]);
    assert.equal(root.querySelectorAll('.draft-image').length, 3);
    get('images-select-all').click();
    groups[1].querySelector('button').click();
    assert.deepEqual([...root.querySelectorAll('.draft-image:checked')].map(cb => cb.value), [images[1]]);
    assert.equal(get('images-selected-count').textContent, 'Đã chọn 1/3 ảnh');
    groups[1].querySelectorAll('button')[1].click();
    assert.equal(root.querySelectorAll('.draft-image:checked').length, 0);
    dom.window.close();
  });
}

test('product summary separates prices and sends exchange rate with content', async () => {
  const dom = new JSDOM(read('get-deal-test.html'), { url: 'https://example.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const get = id => w.document.querySelector('[data-deal-id="' + id + '"]');
  let submitted;
  w.fetch = async (url, opts) => ({ ok:true, json:async () => {
    if (url.includes('deal-history')) return [];
    if (url.includes('product-drafts')) {
      submitted = JSON.parse(opts.body);
      return { item: { id:1, body:'Content', images:submitted.images } };
    }
    return { price:'Sale $39.75 Orig. $79.50 50% off', images:['https://example.com/1.jpg'], debug:{ pageTitle:'Page', jsonLdProducts:[{ name:'Sweater' }] } };
  } });
  w.eval(read('product-deal.js'));
  get('url').value = 'https://example.com/product';
  get('go').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('draft-title').value, 'Sweater');
  assert.equal(get('price').textContent, '$39.75');
  assert.equal(get('original-price').textContent, '$79.50');
  assert.equal(get('discount').textContent, '50%');
  assert.equal(get('product-info').hidden, false);
  get('exchange-rate').value = '1 USD = 25.500 VND';
  get('exchange-rate').dispatchEvent(new w.Event('input'));
  assert.equal(get('price-vnd').textContent, '1.013.625 VNĐ');
  get('draft-description').value = 'Viết bằng tiếng Việt';
  get('create-draft').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted.description, 'Viết bằng tiếng Việt\nTỷ giá: 1 USD = 25.500 VND');
  dom.window.close();
});
