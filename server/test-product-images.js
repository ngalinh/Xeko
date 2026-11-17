const assert = require('node:assert/strict');
const { collectProductImages, collectGalleryImages } = require('./src/playwright/product-images');
const base = 'https://slimages.macysassets.com/is/image/MCY/products/8/optimized/';
const first = base + '39320748_fpx.tif';
const second = base + '39320749_fpx.tif';
const signed = first + '?wid=100&token=unchanged';
const other = 'https://example.com/image.jpg?wid=80';
const attributes = { srcset: second + '?wid=100 100w, ' + second + '?wid=1500&fmt=webp 1500w' };
global.document = {
  baseURI: 'https://www.macys.com/shop/product/test',
  querySelectorAll(selector) {
    if (selector === 'script[type="application/ld+json"]') return [{ textContent: JSON.stringify({
      '@type': 'Product', image: [first, first + '?fmt=webp&wid=100&hei=100&dpr=2', signed, other],
    }) }];
    if (selector.includes('source')) return [{ getAttribute: name => attributes[name] || null }];
    return [];
  },
};
const images = collectProductImages();
assert.equal(images.length, 4, 'Same asset at thumbnail sizes must deduplicate');
for (const asset of [first, second]) {
  const url = new URL(images.find(src => src.startsWith(asset) && !src.includes('token=')));
  assert.equal(url.searchParams.get('wid'), '2000');
  assert.equal(url.searchParams.get('fmt'), 'jpg');
  assert.equal(url.searchParams.get('qlt'), '90');
  assert.equal(url.searchParams.has('hei'), false);
  assert.equal(url.searchParams.has('dpr'), false);
}
assert.ok(images.includes(signed), 'Preserve signed URLs');
assert.ok(images.includes(other), 'Do not rewrite other CDNs');
delete global.document;

(async () => {
  let current = 0;
  const page = {
    evaluate: async () => current ? [images[0], images[3]] : [images[0]],
    waitForTimeout: async () => {},
    locator: () => ({
      count: async () => 2,
      nth: i => ({ isVisible: async () => true, evaluate: async () => i === 1,
        click: async () => { current++; } }),
    }),
  };
  const result = await collectGalleryImages(page);
  assert.equal(result.images.length, 2, 'Collect additional images after clicking');
  assert.equal(result.gallery.clicked, 1, 'Skip unsafe thumbnail');
  assert.equal(result.gallery.failed, 0);
  console.log('Product image extraction and gallery checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
