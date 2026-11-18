const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { collectProductImages } = require('./src/playwright/product-images');
const name = "Created For Macy's - 25-Days of Beauty Advent Calendar Set";
const asset = id => `https://slimages.macysassets.com/is/image/MCY/products/1/optimized/${id}_fpx.tif`;
const picture = (id, alt = name) => `<img class="picture-image loaded" alt="${alt}" data-src="${asset(id)}" src="${asset(id)}?wid=1500">`;
const dom = new JSDOM(`
  <meta property="og:title" content="${name} - Macy's">
  <h1>25-Days of Beauty Advent Calendar Set</h1>
  <div class="unknown-media-layout">
    <button id="first">${picture('39320751')}</button>
    <div role="tab" id="second">${picture('41107501')}</div>
    <a href="/other">${picture('39320751')}</a>
  </div>
  <div class="product-gallery">
    <button id="detail"><picture><source srcset="${asset('detail')}?wid=1500 1500w"><img src="${asset('detail')}" alt="Detail"></picture></button>
    <button id="wrong">${picture('wrong', 'Different Beauty Gift Set')}</button>
  </div>
  <section class="Recommendations"><button>${picture('recommendation')}</button></section>
  <section aria-label="Sponsored products"><button>${picture('advertisement')}</button></section>
  <div>${picture('unrelated', 'Another Product')}</div>
`, { url: 'https://www.macys.com/shop/product/calendar?ID=123' });
global.document = dom.window.document;
let urls = collectProductImages({ markThumbnails: true });
assert.deepEqual(urls.map(url => new URL(url).pathname).sort(),
  ['39320751', '41107501', 'detail'].map(id => new URL(asset(id)).pathname).sort());
assert.deepEqual([...document.querySelectorAll('[data-xeko-product-thumbnail]')].map(el => el.id), ['first', 'second', 'detail']);
assert.ok(urls.every(url => new URL(url).searchParams.get('wid') === '2000'));
// Metadata remains usable if the storefront renders a separate/non-product h1.
document.querySelector('h1').textContent = 'Shop beauty';
assert.deepEqual(collectProductImages(), urls);
// A rerender must clear stale click targets that now belong to recommendations.
document.querySelector('#second').className = 'recommended';
urls = collectProductImages({ markThumbnails: true });
assert.equal(urls.length, 2);
assert.equal(document.querySelector('#second').hasAttribute('data-xeko-product-thumbnail'), false);
delete global.document;
dom.window.close();
console.log('Product gallery DOM regression checks passed');
