// Runs in the product page; prefer structured product metadata over title guesses.
module.exports = function extractProductBrand() {
  function find(node) {
    if (!node || typeof node !== 'object') return '';
    if (Array.isArray(node)) {
      for (const item of node) { const brand = find(item); if (brand) return brand; }
      return '';
    }
    if ([].concat(node['@type'] || []).includes('Product')) {
      const brand = typeof node.brand === 'string' ? node.brand : node.brand?.name;
      if (typeof brand === 'string' && brand.trim()) return brand.trim();
    }
    return find(node['@graph']);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const brand = find(JSON.parse(script.textContent)); if (brand) return brand; } catch {}
  }
  const element = document.querySelector('[itemprop="brand"], meta[property="product:brand"]');
  return (element?.getAttribute('content') || element?.textContent || '').trim();
};
