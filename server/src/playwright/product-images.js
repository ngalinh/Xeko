// Runs inside the product page; only collect product metadata/gallery images.
function collectProductImages() {
  const images = new Set();
  function add(value) {
    if (Array.isArray(value)) return value.forEach(add);
    if (value && typeof value === 'object') return add(value.contentUrl || value.url || value['@id']);
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      url.hash = '';
      images.add(url.href);
    } catch { /* Ignore malformed image metadata. */ }
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const types = [].concat(value['@type'] || []);
    if (types.some(type => /(^|[/#])Product$/.test(type))) add(value.image);
    Object.values(value).forEach(visit);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Other metadata may be invalid. */ }
  }
  const selectors = [
    '[itemprop="image"]',
    '[data-testid*="product-image"] img',
    '[data-auto*="product-image"] img',
    '[class*="product-gallery"] img',
    '[class*="product-images"] img',
    '[id*="productImages"] img',
    '[class*="image-grid"] img',
    '[class*="imageGrid"] img',
  ];
  for (const img of document.querySelectorAll(selectors.join(','))) {
    add(img.getAttribute('data-zoom-image') || img.getAttribute('data-src') ||
      img.getAttribute('content') || img.currentSrc || img.getAttribute('src') || img.getAttribute('href'));
  }
  if (!images.size) {
    for (const meta of document.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"]')) add(meta.content);
  }
  return [...images];
}

// Only image thumbnail buttons inside a product gallery; never click arbitrary
// links, variant selectors, recommendations, or purchase controls.
const THUMBNAILS = [
  '[class*="product-gallery"]', '[class*="product-images"]',
  '[id*="productImages"]', '[data-testid*="product-gallery"]',
  '[class*="image-grid"]', '[class*="imageGrid"]',
].flatMap(root => [
  `${root} button:has(img)`,
  `${root} [role="tab"]:has(img)`,
  `${root} [class*="thumbnail"]:has(img):not(a)`,
]).join(',');

async function collectGalleryImages(page, { maxClicks = 20, budgetMs = 15000 } = {}) {
  const images = new Set(await page.evaluate(collectProductImages));
  const started = Date.now();
  let clicked = 0;
  let failed = 0;
  const thumbnails = page.locator(THUMBNAILS);
  const count = Math.min(await thumbnails.count(), maxClicks);
  for (let i = 0; i < count && Date.now() - started < budgetMs; i++) {
    const thumb = thumbnails.nth(i);
    try {
      if (!await thumb.isVisible()) continue;
      // A thumbnail wrapper may contain a link. Do not navigate away.
      const unsafe = await thumb.evaluate(el => !!el.closest('a') ||
        !!el.querySelector('a') || /video|play|360/i.test(el.getAttribute('aria-label') || ''));
      if (unsafe) continue;
      await thumb.click({ timeout: Math.min(1500, Math.max(1, budgetMs - (Date.now() - started))), noWaitAfter: true });
      clicked++;
      await page.waitForTimeout(500);
      for (const src of await page.evaluate(collectProductImages)) images.add(src);
    } catch {
      failed++;
    }
  }
  return { images: [...images], gallery: { found: await thumbnails.count(), clicked, failed,
    imageCount: images.size, limited: count < await thumbnails.count() || Date.now() - started >= budgetMs } };
}

module.exports = { collectProductImages, collectGalleryImages };
