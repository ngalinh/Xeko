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

module.exports = { collectProductImages };
