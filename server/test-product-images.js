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
    if (selector === 'h1') return [{ textContent: 'Test product' }];
    if (selector === 'script[type="application/ld+json"]') return [{ textContent: JSON.stringify({
      '@type': 'Product', name: 'Test product', image: [first, first + '?fmt=webp&wid=100&hei=100&dpr=2', signed, other],
    }) }, { textContent: JSON.stringify({ '@type': 'Product', name: 'Recommended item', image: 'https://example.com/unrelated.jpg' }) }];
    if (selector.includes('source')) return [{ closest: () => null, getAttribute: name => name === 'alt' ? 'Test product' : attributes[name] || null }];
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
// Regression: the supplied Macy's picture element has no known gallery parent.
const pictureAsset = 'https://slimages.macysassets.com/is/image/MCY/products/5/optimized/39320745_fpx.tif';
let includeThumbnail = true;
let pictureAttributes = { 'data-src': pictureAsset, src: pictureAsset + '?wid=1500' };
global.document = {
  baseURI: 'https://www.macys.com/shop/product/test',
  querySelectorAll(selector) {
    if (selector === 'h1') return [{ textContent: '5-Piece Self Care Saviors Set' }];
    if (!selector.split(',').includes('img.picture-image')) return [];
    return [
      { closest: () => null, getAttribute: name => name === 'alt' ? 'Unrelated recommended product' : name === 'src' ? other : null },
      { closest: () => ({}), getAttribute: name => name === 'alt' ? '5-Piece Self Care Saviors Set' : name === 'src' ? other : null },
      { closest: () => null, getAttribute: name => name === 'alt' ? "Created For Macy's - 5-Piece Self Care Saviors Set" : pictureAttributes[name] || null },
      ...(includeThumbnail ? [{ closest: () => null, getAttribute: name => name === 'alt' ? '5-Piece Self Care Saviors Set' : name === 'src' ? pictureAsset + '?wid=100' : null }] : []),
    ];
  },
};
let pictures = collectProductImages();
assert.equal(pictures.length, 1, 'Keep current product pictures, excluding unrelated and recommendation images');
assert.equal(new URL(pictures[0]).pathname, new URL(pictureAsset).pathname);
assert.equal(new URL(pictures[0]).searchParams.get('wid'), '2000');
assert.equal(new URL(pictures[0]).searchParams.get('fmt'), 'jpg');
includeThumbnail = false;
pictureAttributes = { 'data-src': pictureAsset };
assert.deepEqual(collectProductImages(), pictures, 'Collect lazy images before src loads');
pictureAttributes = { src: pictureAsset + '?wid=1500' };
assert.deepEqual(collectProductImages(), pictures, 'Fall back to src without data-src');
global.document.baseURI = 'https://example.com/product';
assert.deepEqual(collectProductImages(), [], 'Do not collect generic picture classes on other sites');
// Regression: gallery images/source elements need not repeat the product name.
const galleryAsset = base + '39320750_fpx.tif';
const recommendedAsset = 'https://example.com/recommendation.jpg';
let headingText = "Created For Macy’s - 5-Piece Self Care Saviors Set";
const galleryNode = (attrs, recommended = false) => ({
  closest: selector => selector.includes('recommend') ? (recommended ? {} : null) : {},
  getAttribute: name => attrs[name] || null,
});
global.document = {
  baseURI: 'https://www.macys.com/shop/product/test',
  querySelectorAll(selector) {
    if (selector === 'h1') return [{ textContent: headingText }];
    if (!selector.includes('img.picture-image')) return [];
    return [
      galleryNode({ 'data-src': pictureAsset }),
      galleryNode({ srcset: galleryAsset + '?wid=1500 1500w' }),
      galleryNode({ src: recommendedAsset }, true),
      { closest: () => null, getAttribute: name => ({ alt: '5-Piece Self Care Saviors Set', src: first })[name] || null },
      { closest: () => null, getAttribute: name => name === 'src' ? other : null },
    ];
  },
};
const galleryImages = collectProductImages();
assert.equal(galleryImages.length, 3, 'Keep unlabelled gallery images and sources, plus matching standalone product image');
assert.ok(galleryImages.some(src => src.startsWith(galleryAsset)));
assert.ok(!galleryImages.includes(recommendedAsset), 'Exclude recommendations even inside a gallery');
assert.ok(!galleryImages.includes(other), 'Reject unlabelled standalone images');
headingText = '';
assert.equal(collectProductImages().length, 2, 'Gallery still works without a heading; standalone images require identity');
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
