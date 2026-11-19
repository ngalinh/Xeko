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

// Regression: color/variant swatch buttons sharing the same broad gallery-root
// wrapper as the real thumbnails must not be collected or marked clickable —
// otherwise auto-clicking them swaps in OTHER colors' photos instead of more
// angles of the color actually shown on the page.
const swatchDom = new JSDOM(`
  <meta property="og:title" content="${name} - Macy's">
  <h1>25-Days of Beauty Advent Calendar Set</h1>
  <div class="product-images-container">
    <div class="product-gallery">
      <button id="front">${picture('front_angle')}</button>
      <button id="back">${picture('back_angle')}</button>
    </div>
    <div class="ColorSwatches">
      <button id="swatch-white"><img src="${asset('swatch_white')}"></button>
      <button id="swatch-gray"><img src="${asset('swatch_gray')}"></button>
    </div>
  </div>
`, { url: 'https://www.macys.com/shop/product/calendar?ID=123' });
global.document = swatchDom.window.document;
const swatchUrls = collectProductImages({ markThumbnails: true });
assert.deepEqual(swatchUrls.map(url => new URL(url).pathname).sort(),
  ['front_angle', 'back_angle'].map(id => new URL(asset(id)).pathname).sort(),
  'Color swatch images must be excluded from the gallery');
assert.deepEqual(
  [...document.querySelectorAll('[data-xeko-product-thumbnail]')].map(el => el.id).sort(),
  ['back', 'front'],
  'Color swatch buttons must not be marked as clickable thumbnails');
delete global.document;
swatchDom.window.close();

// Regression: this storefront's real gallery uses a "alt-img" carousel of
// <li class="image-wrapper"> slides (not the usual product-gallery/button
// markup), and a Stylitics "shop similar" widget injects an unrelated styled
// item under the SAME product name/alt text elsewhere on the page. The real
// slides must be collected and marked clickable (so more lazy slides can be
// revealed); the Stylitics image must not be collected at all.
const altImgDom = new JSDOM(`
  <meta property="og:title" content="${name} - Macy's">
  <h1>25-Days of Beauty Advent Calendar Set</h1>
  <div class="alt-img">
    <li class="image-wrapper active" id="slide1">${picture('angle1')}</li>
    <li class="image-wrapper" id="slide2">${picture('angle2')}</li>
  </div>
  <div class="product-image-wrapper-top-level">
    <li class="cell small-12 slideshow-item active">
      <img class="picture-image loaded stylitics-shop-similar" alt="${name}" data-src="${asset('similar_item')}" src="${asset('similar_item')}?wid=1500">
    </li>
  </div>
`, { url: 'https://www.macys.com/shop/product/calendar?ID=123' });
global.document = altImgDom.window.document;
const altImgUrls = collectProductImages({ markThumbnails: true });
assert.deepEqual(altImgUrls.map(url => new URL(url).pathname).sort(),
  ['angle1', 'angle2'].map(id => new URL(asset(id)).pathname).sort(),
  'alt-img carousel slides must be collected; the Stylitics shop-similar image must not');
assert.deepEqual(
  [...document.querySelectorAll('[data-xeko-product-thumbnail]')].map(el => el.id).sort(),
  ['slide1', 'slide2'],
  'alt-img carousel slides must be marked as clickable thumbnails so lazy slides can be revealed');
delete global.document;
altImgDom.window.close();

// Regression: gallery image alt text appends the color name after the product
// name (e.g. "...Sweater Dark Night Navy"), which broke matchesName's
// suffix-only checks and rejected the real same-color photos — the DOM scan
// then came up empty and fell through to JSON-LD, which listed one photo per
// color under a single Product entry. Both must be fixed together: the color-
// suffixed alt must be accepted, and once accepted, JSON-LD must be ignored.
const colorSuffixName = "Tommy Hilfiger Women's Cable-Knit V-Neck Long-Sleeve Sweater";
const colorAsset = id => `https://slimages.macysassets.com/is/image/MCY/products/2/optimized/${id}_fpx.tif`;
const colorSuffixDom = new JSDOM(`
  <meta property="og:title" content="${colorSuffixName} - Macy's">
  <h1>${colorSuffixName}</h1>
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: colorSuffixName,
    image: [colorAsset('jsonld_black'), colorAsset('jsonld_gray')],
  })}</script>
  <div class="alt-img">
    <li class="image-wrapper active" id="navy1"><img class="picture-image loaded" alt="${colorSuffixName} Dark Night Navy" data-src="${colorAsset('navy_angle1')}" src="${colorAsset('navy_angle1')}?wid=1500"></li>
    <li class="image-wrapper" id="navy2"><img class="picture-image loaded" alt="${colorSuffixName} Dark Night Navy" data-src="${colorAsset('navy_angle2')}" src="${colorAsset('navy_angle2')}?wid=1500"></li>
  </div>
`, { url: 'https://www.macys.com/shop/product/sweater?ID=27422020' });
global.document = colorSuffixDom.window.document;
const colorSuffixUrls = collectProductImages({ markThumbnails: true });
assert.deepEqual(colorSuffixUrls.map(url => new URL(url).pathname).sort(),
  ['navy_angle1', 'navy_angle2'].map(id => new URL(colorAsset(id)).pathname).sort(),
  'Color-suffixed alt text must still match the product name, and JSON-LD (other colors) must be ignored once the DOM gallery found real images');
delete global.document;
colorSuffixDom.window.close();

console.log('Product gallery DOM regression checks passed');
