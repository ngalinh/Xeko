(() => {
  const root = document.querySelector('[data-deal-app]');
  const $ = key => root?.querySelector('[data-category="' + key + '"]');
  if (!$('form')) return;
  const base = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');
  let products = [], nextUrl = null, busy = false, downloading = false;
  const selected = new Set(), visited = new Set();
  function update() {
    $('count').textContent = 'Đã chọn ' + selected.size + '/' + products.length + ' ảnh';
    $('all').checked = products.length > 0 && selected.size === products.length;
    $('all').indeterminate = selected.size > 0 && selected.size < products.length;
    $('download').disabled = busy || downloading || !selected.size;
    $('ai-content').disabled = busy || downloading || !selected.size;
    $('go').disabled = busy || downloading;
    $('more').disabled = busy || downloading;
    $('more').hidden = !nextUrl;
    $('toolbar').hidden = !products.length;
  }
  function render() {
    $('grid').replaceChildren();
    for (const product of products) {
      const card = document.createElement('article');
      card.className = 'category-product';
      const choice = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selected.has(product.id);
      checkbox.setAttribute('aria-label', 'Chọn ' + product.title);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(product.id); else selected.delete(product.id);
        update();
      });
      choice.append(checkbox, ' Chọn ảnh');
      const link = document.createElement('a');
      link.href = product.thumbnail; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = product.thumbnail; img.alt = product.title; img.loading = 'lazy';
      img.addEventListener('error', () => { link.textContent = 'Không tải được thumbnail — mở ảnh'; });
      link.append(img);
      const title = document.createElement('a');
      title.className = 'category-title'; title.textContent = product.title;
      title.href = product.url; title.target = '_blank'; title.rel = 'noopener noreferrer';
      const price = document.createElement('div'); price.className = 'category-price';
      price.textContent = product.price || 'Chưa đọc được giá';
      const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Lấy deal';
      go.addEventListener('click', () => {
        const button = root.querySelector('[data-deal-id="go"]');
        if (button.disabled) { $('error').textContent = 'Đang lấy một sản phẩm khác. Vui lòng đợi hoàn tất.'; return; }
        root.querySelector('[data-deal-id="url"]').value = product.url;
        document.querySelector('[data-deal-tab="product"]').click();
        button.click();
      });
      card.append(choice, link, title, price, go); $('grid').append(card);
    }
    update();
  }
  function validProduct(p) {
    try {
      const u = new URL(p.url), img = new URL(p.thumbnail);
      return p.id && u.protocol === 'https:' && ['www.macys.com', 'macys.com'].includes(u.hostname) && u.pathname.startsWith('/shop/product/') && img.protocol === 'https:' && img.hostname === 'slimages.macysassets.com';
    } catch { return false; }
  }
  async function load(append) {
    if (busy || downloading) return;
    const url = append ? nextUrl : $('url').value.trim();
    if (!url) return;
    busy = true; $('error').textContent = ''; $('status').textContent = 'Đang tải danh sách và thumbnail…'; update();
    try {
      const response = await fetch(base + '/api/get-category', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, engine: root.querySelector('input[name="engine"]:checked')?.value || 'firefox', proxy: root.querySelector('[data-deal-id="proxy"]')?.value.trim() || undefined }),
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Server phản hồi không hợp lệ. Hãy thử lại sau.'); }
      if (!response.ok) throw new Error(data.error || 'Không tải được category.');
      if (!Array.isArray(data.products)) throw new Error('Danh sách sản phẩm không hợp lệ.');
      const incoming = data.products.filter(validProduct);
      if (!incoming.length) throw new Error('Chưa tìm thấy sản phẩm có thumbnail.');
      if (!append) { products = []; selected.clear(); visited.clear(); }
      const ids = new Set(products.map(p => p.id));
      for (const p of incoming) if (!ids.has(p.id)) { products.push(p); ids.add(p.id); selected.add(p.id); }
      visited.add(url);
      nextUrl = data.nextUrl && !visited.has(data.nextUrl) ? data.nextUrl : null;
      render();
      $('status').textContent = 'Đã lấy ' + products.length + ' sản phẩm.' + (nextUrl ? '' : ' Không tìm thấy link trang tiếp; bạn có thể dán link trang khác để lấy tiếp.');
    } catch (e) {
      $('status').textContent = ''; $('error').textContent = e.message;
    } finally { busy = false; update(); }
  }
  $('form').addEventListener('submit', e => { e.preventDefault(); load(false); });
  $('more').addEventListener('click', () => load(true));
  $('all').addEventListener('change', () => {
    selected.clear(); if ($('all').checked) products.forEach(p => selected.add(p.id)); render();
  });
  $('ai-content').addEventListener('click', () => {
    const items = products.filter(p => selected.has(p.id));
    if (!items.length) return;
    const images = items.map(p => p.thumbnail).slice(0, 5);
    const names = items.slice(0, 5).map(p => p.title);
    const productName = 'Chương trình sale gồm ' + items.length + ' sản phẩm: ' + names.join('; ') + (items.length > names.length ? '…' : '');
    window.openAiSheet('category', { images, productName });
  });
  $('ai-result-copy').addEventListener('click', async () => {
    const text = $('ai-result-text').value;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); $('status').textContent = 'Đã sao chép nội dung.'; }
    catch { $('error').textContent = 'Không sao chép được. Hãy chọn và copy thủ công.'; }
  });
  $('download').addEventListener('click', async () => {
    if (downloading || busy) return;
    const items = products.filter(p => selected.has(p.id));
    downloading = true; update(); let saved = 0;
    $('error').textContent = '';
    for (const [index, p] of items.entries()) {
      $('status').textContent = 'Đang tải ảnh ' + (index + 1) + '/' + items.length + '…';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(p.thumbnail, { credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error('Không tải được ảnh');
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('Không nhận được ảnh');
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' }[blob.type] || 'img';
        a.href = url; a.download = 'category-' + (index + 1) + '.' + ext;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000); saved++;
      } catch {} finally { clearTimeout(timer); }
    }
    $('status').textContent = 'Đã gửi ' + saved + '/' + items.length + ' ảnh tới trình duyệt để lưu.';
    if (saved < items.length) $('error').textContent = 'Một số ảnh không tải trực tiếp được. Bấm thumbnail để mở ảnh rồi lưu thủ công.';
    downloading = false; update();
  });
  update();
})();
