// Runs inside page.evaluate (also exercised against DOM fixtures).
function extractCategoryProducts() {
  const products = new Map();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const productUrl = value => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || !['www.macys.com', 'macys.com'].includes(u.hostname) || !u.pathname.startsWith('/shop/product/')) return null;
      const id = u.searchParams.get('ID') || u.searchParams.get('id');
      u.hash = '';
      u.search = '';
      if (id) u.searchParams.set('ID', id);
      return { url: u.href, id: id || u.pathname };
    } catch { return null; }
  };
  const imageUrl = value => {
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' && u.hostname === 'slimages.macysassets.com' && u.pathname.startsWith('/is/image/MCY/') ? u.href : '';
    } catch { return ''; }
  };
  function add(url, title, image, price) {
    const link = productUrl(url);
    const thumbnail = imageUrl(image);
    if (!link || !thumbnail) return;
    const old = products.get(link.id);
    products.set(link.id, { ...link, title: clean(title) || old?.title || 'Sản phẩm Macy’s', thumbnail, price: clean(price) || old?.price || '' });
  }
  for (const a of document.querySelectorAll('a[href*="/shop/product/"]')) {
    const card = a.closest('[data-product-id], [data-productid], .productThumbnail, .product-thumbnail, .product-tile, .productTile, li') || a.parentElement;
    if (!card) continue;
    const img = a.querySelector('img') || card.querySelector('img');
    if (!img) continue;
    const source = [img.currentSrc, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.src, ...(img.getAttribute('srcset') || '').split(',').map(s => s.trim().split(/\s+/)[0])].find(imageUrl);
    const title = card.querySelector('.productDescription, .product-description, [data-testid="product-title"], .product-name');
    const price = card.querySelector('.prices, .price, .product-price, [data-testid="product-price"]');
    add(a.href, title?.textContent || img.alt || a.getAttribute('aria-label') || a.textContent, source, price?.textContent);
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const types = [].concat(node['@type'] || []);
    if (types.includes('Product')) {
      const image = Array.isArray(node.image) ? node.image[0] : node.image;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const price = offer?.price ?? offer?.lowPrice;
      const link = productUrl(node.url || offer?.url);
      if (link && !products.has(link.id)) add(link.url, node.name, typeof image === 'object' ? image?.url : image, price == null ? '' : [offer.priceCurrency, price].filter(Boolean).join(' '));
    }
    Object.values(node).forEach(visit);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch {}
  }
  const next = [...document.querySelectorAll('a[rel="next"], a[aria-label], .pagination a')].find(a => !a.matches('[aria-disabled="true"], .disabled') && (a.rel === 'next' || /^(next|next page|trang sau)$/i.test(clean(a.getAttribute('aria-label') || a.textContent))));
  return { products: [...products.values()].slice(0, 120), nextUrl: next?.href || null };
}
module.exports = { extractCategoryProducts };
