// Runs inside page.evaluate (also exercised against DOM fixtures).
function extractCategoryProducts() {
  const products = new Map();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  // Không còn khoá cứng domain/đường dẫn của Macy's — chỉ yêu cầu link cùng
  // site (tránh gom nhầm link quảng cáo/affiliate ngoài trang) và ảnh https.
  const pageHost = (() => { try { return new URL(document.baseURI).hostname; } catch { return ''; } })();
  const productUrl = value => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || u.hostname !== pageHost) return null;
      // Macy's dùng CHUNG 1 đường dẫn slug cho nhiều sản phẩm khác nhau, chỉ
      // phân biệt bằng query ?ID= — giữ nguyên cách lấy id này cho đúng site
      // đó. Site khác thì dùng path+query làm id (không biết quy ước riêng).
      const macysId = /(^|\.)macys\.com$/.test(u.hostname) ? (u.searchParams.get('ID') || u.searchParams.get('id')) : null;
      u.hash = '';
      if (macysId) { u.search = ''; u.searchParams.set('ID', macysId); }
      return { url: u.href, id: macysId || (u.pathname + u.search) };
    } catch { return null; }
  };
  const imageUrl = value => {
    // "" (src rỗng/thiếu) resolve thành chính URL trang qua new URL(), không
    // phải lỗi cú pháp — phải chặn tay trước khi coi là ảnh hợp lệ.
    if (!value) return '';
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' ? u.href : '';
    } catch { return ''; }
  };
  function splitTitlePriceBlob(raw) {
    const text = String(raw || '');
    const idx = text.search(/current price/i);
    return idx === -1 ? { title: text, blob: '' } : { title: text.slice(0, idx), blob: text.slice(idx) };
  }
  function parsePriceBlob(blob) {
    const sale = blob.match(/current price\D*(\$[\d,.]+)/i)?.[1];
    if (!sale) return '';
    const off = blob.match(/(\d+)%\s*off/i)?.[1];
    const prev = blob.match(/previous price\D*(\$[\d,.]+)/i)?.[1];
    let out = sale;
    if (off) out += ' (-' + off + '%)';
    if (prev && prev !== sale) out += ' · Giá gốc ' + prev;
    return out;
  }
  function add(url, title, image, price) {
    const link = productUrl(url);
    const thumbnail = imageUrl(image);
    if (!link || !thumbnail) return;
    const old = products.get(link.id);
    const { title: titlePart, blob } = splitTitlePriceBlob(title);
    const cleanedPrice = clean(price);
    const parsedPrice = cleanedPrice ? '' : parsePriceBlob(blob);
    products.set(link.id, { ...link, title: clean(titlePart) || old?.title || 'Sản phẩm', thumbnail, price: cleanedPrice || parsedPrice || old?.price || '' });
  }
  // Quét MỌI link cùng site (trước đây chỉ link chứa "/shop/product/" của
  // Macy's) — bù lại bằng lọc ảnh nhỏ (icon/logo) để giảm nhiễu từ link menu,
  // social, v.v. Chỉ áp dụng khi ảnh đã tải xong (naturalWidth > 0), để không
  // loại nhầm ảnh sản phẩm thật đang lazy-load mà chưa kịp tải tới nơi.
  for (const a of document.querySelectorAll('a[href]')) {
    // Ảnh PHẢI nằm trong chính thẻ <a> — tín hiệu chung cho "đây là link ảnh
    // sản phẩm" trên hầu hết site, và tránh việc fallback ra card/body rộng
    // (không còn giới hạn theo "/shop/product/") vô tình vơ luôn ảnh của link
    // khác gần đó (ví dụ link phân trang "Next" từng bị nhầm thành sản phẩm).
    const img = a.querySelector('.slideshow-item.active img') || a.querySelector('img');
    if (!img) continue;
    if (img.naturalWidth > 0 && (img.naturalWidth < 150 || img.naturalHeight < 150)) continue;
    const card = a.closest('[data-product-id], [data-productid], .productThumbnail, .product-thumbnail, .product-tile, .productTile, li') || a.parentElement;
    const source = [img.currentSrc, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.src, ...(img.getAttribute('srcset') || '').split(',').map(s => s.trim().split(/\s+/)[0])].find(imageUrl);
    const title = card?.querySelector('.productDescription, .product-description, [data-testid="product-title"], .product-name');
    const price = card?.querySelector('.prices, .price, .product-price, [data-testid="product-price"]');
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
