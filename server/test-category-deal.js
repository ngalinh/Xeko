const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { extractCategoryProducts } = require('./src/playwright/category-products');
const { validateCategoryUrl } = require('./src/playwright/get-category');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const image = 'https://slimages.macysassets.com/is/image/MCY/products/1.jpg';
const product = id => ({ id, url: 'https://www.macys.com/shop/product/dress?ID=' + id, thumbnail: image, title: 'Dress ' + id, price: '$20' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('category URL accepts Macy’s category and rejects products, credentials and other hosts', () => {
  assert.equal(validateCategoryUrl('https://www.macys.com/shop/sale?id=80422'), 'https://www.macys.com/shop/sale?id=80422');
  for (const url of ['http://www.macys.com/shop/sale', 'https://www.macys.com.evil.test/shop/sale', 'https://localhost/shop/sale', 'https://user@www.macys.com/shop/sale', 'https://www.macys.com:999/shop/sale', product('1').url, 'oops']) assert.throws(() => validateCategoryUrl(url));
});

test('extracts lazy thumbnail and price, deduplicates links, finds pagination', () => {
  const dom = new JSDOM(`<ul><li data-product-id="1"><a href="/shop/product/dress?ID=1&tracking=x"><img src="data:image/gif;base64,x" data-src="${image}" alt="Dress"></a><a href="/shop/product/dress?ID=1">Dress</a><div class="prices">Sale $20</div></li><li><a href="https://evil.test/shop/product/x"><img src="${image}"></a></li></ul><a rel="next" href="/shop/sale/Pageindex/2?id=80422">Next</a>`, { url: 'https://www.macys.com/shop/sale?id=80422', runScripts: 'outside-only' });
  const data = dom.window.eval('(' + extractCategoryProducts.toString() + ')()');
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].thumbnail, image);
  assert.equal(data.products[0].price, 'Sale $20');
  assert.equal(data.products[0].url, product('1').url);
  assert.match(data.nextUrl, /Pageindex\/2/);
  dom.window.close();
});

test('splits mashed title/price text from Macy\u2019s product-description blob', () => {
  const title = "Created For Macy's 5-Piece Eye Candy Makeup Icons SetDealCurrent price $15.00; 50% off;$15.00 (50% off)Previous price $30.00;$30.00$70.00 valuefree gift with purchase (8)";
  const dom = new JSDOM(`<ul><li data-product-id=\"1\"><a href=\"/shop/product/dress?ID=1\"><img src=\"${image}\"></a><div class=\"product-description\">${title}</div></li></ul>`, { url: 'https://www.macys.com/shop/sale', runScripts: 'outside-only' });
  const data = dom.window.eval('(' + extractCategoryProducts.toString() + ')()');
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].title, "Created For Macy's 5-Piece Eye Candy Makeup Icons SetDeal");
  assert.equal(data.products[0].price, '$15.00 (-50%) \u00b7 Gi\u00e1 g\u1ed1c $30.00');
  dom.window.close();
});

test('prefers the active slideshow image over the hidden first slide (Macy\u2019s carousel tiles)', () => {
  const dom = new JSDOM(`<ul><li data-product-id=\"1\">
    <a href=\"/shop/product/dress?ID=1\">
      <ul class=\"v-slideshow\">
        <li class=\"cell small-12 slideshow-item\" aria-hidden=\"true\"><img src=\"https://slimages.macysassets.com/is/image/MCY/products/2/back.jpg\"></li>
        <li class=\"cell small-12 slideshow-item active\"><img src=\"https://slimages.macysassets.com/is/image/MCY/products/3/front.jpg\"></li>
      </ul>
    </a>
    <div class=\"product-description\">Dress</div>
  </li></ul>`, { url: 'https://www.macys.com/shop/sale', runScripts: 'outside-only' });
  const data = dom.window.eval('(' + extractCategoryProducts.toString() + ')()');
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].thumbnail, 'https://slimages.macysassets.com/is/image/MCY/products/3/front.jpg');
  dom.window.close();
});

test('JSON-LD fallback handles ItemList, malformed scripts and unsafe images', () => {
  const dom = new JSDOM(`<script type="application/ld+json">broken</script><script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [{ item: { '@type': 'Product', name: 'Dress', url: product('2').url, image: [image], offers: { priceCurrency: 'USD', price: 20 } } }, { item: { '@type': 'Product', url: product('3').url, image: 'javascript:alert(1)' } }] })}</script>`, { url: 'https://www.macys.com/shop/sale', runScripts: 'outside-only' });
  const data = dom.window.eval('(' + extractCategoryProducts.toString() + ')()');
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].price, 'USD 20');
  dom.window.close();
});

function setup(responses) {
  const dom = new JSDOM(read('index.html'), { url: 'https://example.com/b/member/index.html', runScripts: 'outside-only' });
  const w = dom.window, calls = [];
  w.fetch = async (url, opts) => {
    if (url.includes('/api/deal-history')) return { ok: true, json: async () => [] };
    calls.push({ url, body: JSON.parse(opts.body) });
    const response = responses.shift();
    return { ok: response.ok !== false, json: async () => response };
  };
  w.eval(read('product-deal.js')); w.eval(read('category-deal.js'));
  return { dom, w, calls, get: key => w.document.querySelector('[data-category="' + key + '"]') };
}

test('category selects, appends without duplicates, preserves tab state and opens product flow', async () => {
  const next = 'https://www.macys.com/shop/sale/Pageindex/2';
  const { dom, w, calls, get } = setup([{ products: [product('1')], nextUrl: next }, { products: [product('1'), product('2')], nextUrl: next }, { price: '$20', images: [image], debug: { pageTitle: 'Dress' } }]);
  const category = w.document.querySelector('[data-deal-tab="category"]'); category.click();
  get('url').value = 'https://www.macys.com/shop/sale';
  get('form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls[0].url, '/b/member/api/get-category');
  assert.equal(calls[0].body.engine, 'firefox');
  assert.equal(get('grid').children.length, 1);
  get('all').click(); assert.equal(get('download').disabled, true);
  w.document.querySelector('[data-deal-tab="product"]').click(); category.click();
  assert.match(get('count').textContent, /0\/1/);
  get('more').click(); await tick();
  assert.equal(get('grid').children.length, 2);
  assert.match(get('count').textContent, /1\/2/);
  assert.equal(get('more').hidden, true);
  get('grid').querySelector('button').click(); await tick();
  assert.equal(calls[2].url, '/b/member/api/get-deal');
  assert.equal(calls[2].body.url, product('1').url);
  assert.equal(w.document.querySelector('[data-deal-panel="category"]').hidden, true);
  dom.window.close();
});

test('failed pagination preserves results, shows error and permits retry', async () => {
  const { dom, w, get } = setup([{ products: [product('1')], nextUrl: 'https://www.macys.com/shop/sale/Pageindex/2' }, { ok: false, error: 'Access Denied' }]);
  get('url').value = 'https://www.macys.com/shop/sale';
  get('form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  get('more').click(); await tick();
  assert.equal(get('grid').children.length, 1);
  assert.match(get('error').textContent, /Access Denied/);
  assert.equal(get('go').disabled, false);
  assert.equal(get('more').disabled, false);
  dom.window.close();
});

test('untrusted URLs are not rendered and product titles render as text', async () => {
  const { dom, w, get } = setup([{ products: [{ ...product('1'), title: '<img onerror="alert(1)">' }, { ...product('2'), thumbnail: 'javascript:alert(1)' }] }]);
  get('url').value = 'https://www.macys.com/shop/sale';
  get('form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  assert.equal(get('grid').children.length, 1);
  assert.equal(get('grid').querySelector('.category-title').children.length, 0);
  dom.window.close();
});

test('downloads only selected thumbnails and reports CDN failure', async () => {
  const { dom, w, get } = setup([{ products: [product('1'), product('2')] }]);
  get('url').value = 'https://www.macys.com/shop/sale';
  get('form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  get('grid').querySelector('input').click();
  let downloads = 0;
  w.fetch = async url => { assert.equal(url, image); downloads++; return { ok: false }; };
  get('download').click(); await tick();
  assert.equal(downloads, 1);
  assert.match(get('status').textContent, /0\/1/);
  assert.match(get('error').textContent, /lưu thủ công/);
  assert.equal(get('download').disabled, false);
  dom.window.close();
});
