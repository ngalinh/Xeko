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
        (name.endsWith(' ' + productName) || productName.endsWith(' ' + name) ||
          // Gallery image alt text often appends the color/swatch name after the
          // product name (e.g. "...Sweater Dark Night Navy") — a trailing suffix
          // that breaks the endsWith checks above and wrongly rejected real
          // same-color gallery photos, which then fell through to the JSON-LD
          // fallback that can list every color under one Product entry.
          name.startsWith(productName + ' '))));
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
    '[aria-label*="swatch" i], [aria-label*="color" i], [data-testid*="swatch" i], [data-testid*="color" i], ' +
    '[class*="stylitics" i]';
  if (markThumbnails) {
    for (const el of document.querySelectorAll('[data-xeko-product-thumbnail]')) {
      el.removeAttribute('data-xeko-product-thumbnail');
    }
  }
  const galleryRoots = [
    '[class*="product-gallery"]', '[class*="product-images"]',
    '[id*="productImages"]', '[data-testid*="product-gallery"]',
    '[class*="image-grid"]', '[class*="imageGrid"]', '[class*="alt-img"]',
  ].join(',');
  // JSON-LD "Product.image" can legitimately list ONE representative photo per
  // COLOR VARIANT under a single entry (confirmed: one Macy's product page had
  // exactly 1 JSON-LD Product node whose image array held 4 photos — one per
  // color — while the real on-page gallery only ever showed the current color).
  // Treat JSON-LD as a fallback only, used when the DOM gallery found nothing,
  // rather than always merging it in and risking a cross-color leak.
  const jsonLdImages = new Set();
  function addTo(set, value) {
    if (Array.isArray(value)) return value.forEach(v => addTo(set, v));
    if (value && typeof value === 'object') return addTo(set, value.contentUrl || value.url || value['@id']);
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
      set.add(url.href);
    } catch { /* Ignore malformed image metadata. */ }
  }
  function add(value) { addTo(images, value); }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const types = [].concat(value['@type'] || []);
    if (types.some(type => /(^|[/#])Product$/.test(type)) &&
        (!isMacys || matchesName(value.name))) addTo(jsonLdImages, value.image);
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
    '[class*="alt-img"] img',
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
      const control = img.closest('button, [role="tab"], [role="button"], [class*="thumbnail" i], li[class*="image-wrapper" i]');
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
  // Only trust JSON-LD once the real DOM gallery/picture scan found nothing —
  // see the note above jsonLdImages for why.
  if (!images.size) {
    for (const url of jsonLdImages) images.add(url);
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
  '[class*="image-grid"]', '[class*="imageGrid"]', '[class*="alt-img"]',
].flatMap(root => [
  `${root} button:has(img)`,
  `${root} [role="tab"]:has(img)`,
  `${root} [class*="thumbnail"]:has(img):not(a)`,
  `${root} li[class*="image-wrapper"]:has(img):not(a)`,
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

// Color/variant swatch pickers — the SAME patterns collectProductImages()
// deliberately excludes from the default gallery (see `excluded`), used here
// on purpose: click each color, re-run the full gallery collection for it,
// and merge every color's complete photo set. Opt-in only (slower, more
// clicks — higher chance of bot-detection friction on sites like Macy's).
const SWATCHES = [
  '[class*="swatch" i]', '[class*="colorway" i]', '[class*="colorpicker" i]',
  '[class*="color-picker" i]', '[data-testid*="swatch" i]', '[data-testid*="color" i]',
].flatMap(root => [
  ...['button', '[role="radio"]', '[role="button"]', 'input[type="radio"]'].flatMap(control => [
    `${root}${control.startsWith('[') ? control : ':is(' + control + ')'}`,
    `${root} ${control}`,
  ]),
]).join(',');

// Only activate the already identified color control; never click an ancestor
// or a different page action when Playwright cannot deliver a pointer click.
function activateColorControl(el) {
  if (!el.isConnected || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') {
    throw new Error('Color control is detached or disabled');
  }
  if (!el.matches('button, input[type="radio"], [role="radio"], [role="button"], label')) {
    throw new Error('Unsupported color control');
  }
  el.click();
}

function colorErrorSummary(error) {
  return String(error?.message || error).replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n').filter(line => line.trim() && !line.includes('waiting for locator('))
    .map(line => line.slice(0, 240)).slice(-12).join('\n').slice(0, 2400);
}

async function collectAllColorImages(page, { maxColors = 6, perColorBudgetMs = 10000 } = {}) {
  const current = await collectGalleryImages(page, { budgetMs: perColorBudgetMs });
  const images = new Set(current.images);
  const colors = [{ label: null, imageCount: current.images.length }];

  const swatches = page.locator(SWATCHES);
  const total = await swatches.count().catch(() => 0);
  const count = Math.min(total, maxColors);
  const seenLabels = new Set();
  const attempts = [];
  for (let i = 0; i < count; i++) {
    const swatch = swatches.nth(i);
    let label = '';
    try {
      label = ((await swatch.getAttribute('aria-label')) || (await swatch.getAttribute('title')) ||
        (await swatch.getAttribute('data-color')) || (await swatch.getAttribute('value')) ||
        (await swatch.locator('img').first().getAttribute('alt').catch(() => '')) ||
        (await swatch.innerText().catch(() => '')) || '').trim();
    } catch {
      continue;
    }
    if (!label || seenLabels.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    let stage = 'inspect-control';
    try {
      const disabled = await swatch.getAttribute('disabled');
      const ariaDisabled = await swatch.getAttribute('aria-disabled');
      if (disabled !== null || ariaDisabled === 'true' || /\bunavailable\b/i.test(label)) {
        attempts.push({ label, status: 'unavailable' });
        continue;
      }
      // Native radio inputs may be hidden beneath a styled, clickable label.
      const target = await swatch.evaluate(el => {
        const input = el.matches('input[type="radio"]');
        return { radio: input, labelFor: input && el.id && el.labels?.length ? el.id : null };
      });
      let control = swatch;
      if (target.labelFor) {
        control = page.locator('label').filter({ has: swatch });
        if (!await control.count()) {
          control = page.locator(`label[for=${JSON.stringify(target.labelFor)}]`);
        }
        control = control.first();
      }
      stage = 'click';
      const before = await page.evaluate(collectProductImages);
      try {
        await control.click({ timeout: 2000, noWaitAfter: true });
      } catch (error) {
        if (!/timeout/i.test(String(error?.message || error))) throw error;
        // Styled swatches can have no pointer hit area. DOM activation still
        // runs their handlers; the gallery-change check below verifies success.
        stage = 'activate-control';
        await control.evaluate(activateColorControl);
      }
      stage = 'wait-gallery';
      // Require a changed, stable gallery before attributing photos to this color.
      let previous = '';
      let stable = 0;
      let ready = false;
      for (let poll = 0; poll < 24; poll++) {
        await page.waitForTimeout(250);
        const sources = await page.evaluate(collectProductImages);
        const signature = JSON.stringify([...sources].sort());
        const changed = sources.length && sources.some(src => !before.includes(src));
        stable = changed && signature === previous ? stable + 1 : 0;
        previous = signature;
        if (stable >= 3) { ready = true; break; }
      }
      if (!ready) {
        attempts.push({ label, status: 'unchanged-or-timeout' });
        continue;
      }
      stage = 'collect-gallery';
      const result = await collectGalleryImages(page, { budgetMs: perColorBudgetMs });
      for (const url of result.images) images.add(url);
      colors.push({ label, imageCount: result.images.length });
      attempts.push({ label, status: 'collected' });
    } catch (error) {
      attempts.push({ label, status: 'failed', stage,
        error: colorErrorSummary(error) });
      // Bấm lỗi ở 1 màu không chặn các màu còn lại.
    }
  }
  return { images: [...images], gallery: { ...current.gallery, colorAttempts: attempts }, colors,
    swatchesFound: total, limited: total > maxColors };
}

// DEBUG ONLY — does not affect which images get collected. Reports every
// Product entry found in the page's JSON-LD structured data (name/color/sku
// plus a few of its image URLs), to check whether a single entry aggregates
// photos across multiple color variants under one product name.
function inspectJsonLd() {
  const out = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const types = [].concat(value['@type'] || []);
    if (types.some(type => /(^|[/#])Product$/.test(type))) {
      const images = [].concat(value.image || []).map(i =>
        typeof i === 'string' ? i : (i && (i.contentUrl || i.url || i['@id'])) || '');
      out.push({
        name: value.name || '',
        color: value.color || '',
        sku: value.sku || value.mpn || '',
        imageCount: images.length,
        images: images.slice(0, 3),
      });
    }
    Object.values(value).forEach(visit);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Other metadata may be invalid. */ }
  }
  return out;
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

module.exports = { collectProductImages, collectGalleryImages, collectAllColorImages, inspectPictureImages, inspectJsonLd };
