// Runs inside the product page; only collect product metadata/gallery images.
function collectProductImages({ markThumbnails = false } = {}) {
  const images = new Set();
  const isMacys = /(^|\.)macys\.com$/.test(new URL(document.baseURI).hostname);
  const normalizeName = value => String(value || '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Macy's may split brand/name across heading children or use a different
  // heading while the canonical product title remains in Open Graph metadata.
  const productNames = [...document.querySelectorAll('h1')].map(el => el.textContent);
  for (const meta of document.querySelectorAll('meta[property="og:title"]')) {
    productNames.push((meta.content || '').replace(/\s*[-|–]\s*Macy['’]s\s*$/i, ''));
  }
  const names = productNames.map(normalizeName).filter(Boolean);
  const matchesName = value => {
    const name = normalizeName(value);
    return !!name && names.some(productName => name === productName ||
      (Math.min(name.length, productName.length) >= 16 &&
        (name.endsWith(' ' + productName) || productName.endsWith(' ' + name))));
  };
  // Color/variant swatch pickers often live inside the same broad gallery-root
  // wrapper as the real thumbnail strip (e.g. a shared "product-images"
  // container). Their small swatch <img> usually has no alt text, so without
  // this exclusion they pass the alt-text filter below and get collected and
  // auto-clicked as if they were gallery thumbnails — each click swaps the
  // main photo to a DIFFERENT color variant instead of another angle of the
  // color the shopper is actually viewing.
  const excluded = '[class*="recommend" i], [id*="recommend" i], [aria-label*="recommend" i], ' +
    '[class*="recently" i], [id*="recently" i], [class*="sponsored" i], [class*="similar" i], ' +
    '[class*="related" i], [id*="related" i], [aria-label*="sponsored" i], [data-ad], iframe, ' +
    '[class*="swatch" i], [class*="colorway" i], [class*="colorpicker" i], [class*="color-picker" i], ' +
    '[aria-label*="swatch" i], [aria-label*="color" i], [data-testid*="swatch" i], [data-testid*="color" i]';
  if (markThumbnails) {
    for (const el of document.querySelectorAll('[data-xeko-product-thumbnail]')) {
      el.removeAttribute('data-xeko-product-thumbnail');
    }
  }
  const galleryRoots = [
    '[class*="product-gallery"]', '[class*="product-images"]',
    '[id*="productImages"]', '[data-testid*="product-gallery"]',
    '[class*="image-grid"]', '[class*="imageGrid"]',
  ].join(',');
  function add(value) {
    if (Array.isArray(value)) return value.forEach(add);
    if (value && typeof value === 'object') return add(value.contentUrl || value.url || value['@id']);
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      url.hash = '';
      // Macy's Scene7 image service: replace thumbnail sizing, preserve crop/color.
      // Do not rewrite other hosts or signed URLs.
      if (/^(slimages\.macysassets\.com|slimages\.macys\.com)$/.test(url.hostname) &&
          url.pathname.startsWith('/is/image/') &&
          ![...url.searchParams.keys()].some(key => /sign|token|auth/i.test(key))) {
        const width = Math.max(2000, Number(url.searchParams.get('wid')) || 0);
        url.searchParams.set('wid', String(width));
        url.searchParams.delete('hei');
        url.searchParams.set('qlt', '90');
        url.searchParams.set('fmt', 'jpg');
        url.searchParams.set('op_sharpen', '1');
        url.searchParams.set('fit', 'fit,1');
        url.searchParams.delete('dpr');
        url.searchParams.sort();
      }
      images.add(url.href);
    } catch { /* Ignore malformed image metadata. */ }
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const types = [].concat(value['@type'] || []);
    if (types.some(type => /(^|[/#])Product$/.test(type)) &&
        (!isMacys || matchesName(value.name))) add(value.image);
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
    '[data-testid*="product-gallery"] img',
    '[class*="product-gallery"] source',
    '[class*="product-images"] source',
    '[id*="productImages"] source',
    '[class*="image-grid"] source',
    '[class*="imageGrid"] source',
  ];
  // Macy's picture component can sit outside the named gallery containers.
  // Scope this fallback to Macy's; the class is generic on other storefronts.
  if (isMacys) {
    selectors.push('img.picture-image');
  }
  for (const img of document.querySelectorAll(selectors.join(','))) {
    // Gallery thumbnails and picture sources often have no alt. Their gallery
    // supplies context; standalone picture components still need product identity.
    if (isMacys) {
      if (img.closest(excluded)) continue;
      const alt = img.getAttribute('alt');
      // An explicit different product name must not be accepted just because a
      // recommendation widget shares a generic image-grid ancestor.
      if (alt && !matchesName(alt) && !/^(?:image|view|thumbnail|front|back|side|detail|alternate)(?:\s*\d+)?$/i.test(alt.trim())) continue;
      if (!img.closest(galleryRoots) && !matchesName(alt)) continue;
    }
    if (markThumbnails) {
      const control = img.closest('button, [role="tab"], [role="button"], [class*="thumbnail" i]');
      if (control && !control.closest(excluded) && !control.closest('a') &&
          !control.querySelector('a') && !/video|play|360/i.test(control.getAttribute('aria-label') || '')) {
        control.setAttribute('data-xeko-product-thumbnail', '');
      }
    }
    const zoom = img.getAttribute('data-zoom-image') || img.getAttribute('data-large-image') ||
      img.getAttribute('data-full-image');
    // Choose the largest declared responsive candidate, not the viewport thumbnail.
    const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset') || '';
    const candidates = srcset.split(',').map(part => {
      const match = part.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/);
      return match ? { url: match[1], size: Number(match[2]), unit: match[3] } : null;
    }).filter(Boolean);
    const widths = candidates.filter(item => item.unit === 'w');
    const largest = (widths.length ? widths : candidates).sort((a, b) => b.size - a.size)[0];
    add(zoom || (largest && largest.url) || img.getAttribute('content') ||
      img.getAttribute('data-src') || img.currentSrc || img.getAttribute('src') || img.getAttribute('href'));
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
  const images = new Set(await page.evaluate(collectProductImages, { markThumbnails: true }));
  const started = Date.now();
  let clicked = 0;
  let failed = 0;
  const thumbnails = page.locator(`${THUMBNAILS}, [data-xeko-product-thumbnail]`);
  const count = Math.min(await thumbnails.count(), maxClicks);
  for (let i = 0; i < count && Date.now() - started < budgetMs; i++) {
    const thumb = thumbnails.nth(i);
    try {
      if (!await thumb.isVisible()) continue;
      // A thumbnail wrapper may contain a link. Do not navigate away.
      const unsafe = await thumb.evaluate(el =>
        (/(^|\.)macys\.com$/.test(new URL(document.baseURI).hostname) && !el.hasAttribute('data-xeko-product-thumbnail')) ||
        !!el.closest('a') ||
        !!el.querySelector('a') || !!el.closest('[class*="recommend"], [id*="recommend"], [class*="recently"], [class*="related"], [class*="similar"]') || /video|play|360/i.test(el.getAttribute('aria-label') || ''));
      if (unsafe) continue;
      await thumb.click({ timeout: Math.min(1500, Math.max(1, budgetMs - (Date.now() - started))), noWaitAfter: true });
      clicked++;
      // Poll for lazy/async image updates instead of assuming 500 ms is enough.
      const deadline = Math.min(started + budgetMs, Date.now() + 2500);
      while (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(250, deadline - Date.now()));
        const sources = await page.evaluate(collectProductImages);
        const hasNewImage = sources.some(src => !images.has(src));
        for (const src of sources) images.add(src);
        if (hasNewImage) break;
      }
    } catch {
      failed++;
    }
  }
  return { images: [...images], gallery: { found: await thumbnails.count(), clicked, failed,
    imageCount: images.size, limited: count < await thumbnails.count() || Date.now() - started >= budgetMs } };
}

// DEBUG ONLY — does not affect which images get collected. Reports every
// img.picture-image on the page (the lenient Macy's fallback selector) along
// with its alt text and nearby ancestor class chain, so a leak can be traced
// to the exact container (e.g. a "shop other colors" widget) and excluded by
// name — instead of guessing exclusion patterns blind.
function inspectPictureImages() {
  const isMacys = /(^|\.)macys\.com$/.test(new URL(document.baseURI).hostname);
  if (!isMacys) return [];
  const out = [];
  for (const img of document.querySelectorAll('img.picture-image')) {
    const chain = [];
    let el = img;
    for (let i = 0; i < 5 && el; i++) {
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      chain.push(el.tagName ? el.tagName.toLowerCase() + (cls ? '.' + cls.replace(/\s+/g, '.') : '') : '');
      el = el.parentElement;
    }
    out.push({ alt: img.getAttribute('alt') || '', chain });
  }
  return out.slice(0, 20);
}

module.exports = { collectProductImages, collectGalleryImages, inspectPictureImages };
