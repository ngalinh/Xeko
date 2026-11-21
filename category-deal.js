(() => {
  const root = document.querySelector('[data-deal-app]');
  const $ = key => root?.querySelector('[data-category="' + key + '"]');
  if (!$('form')) return;
  const base = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');
  let products = [], nextUrl = null, busy = false, downloading = false, batchRunning = false, batchCancelled = false;
  let batchCurrent = 0, batchTotal = 0;
  const selected = new Set(), visited = new Set();
  let lastCategoryAiImages = [], lastCategoryAiTitle = '';
  async function saveDraft({ title, body, images, link, price }, statusEl) {
    if (!body) return;
    statusEl.textContent = 'Đang lưu…';
    try {
      const form = new FormData();
      form.append('title', title || '');
      form.append('body', body);
      if (link) form.append('link', link);
      if (price) form.append('price', price);
      for (const url of (images || []).slice(0, 20)) {
        try { form.append('images', await (await fetch(url)).blob(), 'image.jpg'); } catch { /* bỏ qua ảnh lỗi */ }
      }
      const response = await fetch(base + '/api/contents', { method: 'POST', body: form });
      let data;
      try { data = await response.json(); } catch { throw new Error('Server phản hồi không hợp lệ.'); }
      if (!response.ok) throw new Error(data.error || 'Không lưu được bản nháp.');
      statusEl.textContent = 'Đã lưu bản nháp #' + data.id + '.';
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
    }
  }
  function renderImages(container, items) {
    container.replaceChildren();
    for (const item of items) {
      const link = document.createElement('a');
      link.href = item.src; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.title = item.title + ' — Mở ảnh';
      const img = document.createElement('img');
      img.src = item.src; img.alt = item.title; img.loading = 'lazy';
      img.addEventListener('error', () => { img.hidden = true; });
      const caption = document.createElement('span'); caption.textContent = item.title;
      link.append(img, caption); container.append(link);
    }
  }
  function update() {
    $('count').textContent = 'Đã chọn ' + selected.size + '/' + products.length + ' ảnh';
    $('all').checked = products.length > 0 && selected.size === products.length;
    $('all').indeterminate = selected.size > 0 && selected.size < products.length;
    $('download').disabled = busy || downloading || batchRunning || !selected.size;
    $('ai-content').disabled = busy || downloading || batchRunning || !selected.size;
    $('ai-each').disabled = (busy || downloading) ? true : (!batchRunning && !selected.size);
    const batchLabel = batchRunning ? (batchCancelled ? 'Đang dừng…' : 'Đang tạo ' + batchCurrent + '/' + batchTotal + ' · Dừng') : 'Viết từng sản phẩm';
    $('ai-each-label').textContent = batchLabel;
    $('ai-each-label').hidden = false;
    $('ai-each').setAttribute('aria-label', batchLabel);
    $('ai-each').title = batchRunning ? batchLabel : 'Lấy deal và viết bài riêng cho từng sản phẩm đã chọn';
    $('ai-each').classList.toggle('is-loading', batchRunning);
    $('ai-each').setAttribute('aria-busy', String(batchRunning));
    if (batchRunning && batchCancelled) $('ai-each').disabled = true;
    $('go').disabled = busy || downloading || batchRunning;
    $('more').disabled = busy || downloading || batchRunning;
    $('more').hidden = !nextUrl;
    $('toolbar').hidden = !products.length;
    $('create-toolbar').hidden = !products.length;
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
    renderImages($('ai-result-images'), items.slice(0, 5).map(p => ({ src: p.thumbnail, title: p.title })));
    $('ai-result-images-label').textContent = 'Ảnh gửi AI: ' + images.length + '/' + items.length + ' sản phẩm đã chọn';
    lastCategoryAiImages = images;
    lastCategoryAiTitle = 'Nội dung sale danh mục (' + items.length + ' sản phẩm)';
    window.openAiSheet('category', { images, productName });
  });
  $('ai-result-copy').addEventListener('click', async () => {
    const text = $('ai-result-text').value;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); $('status').textContent = 'Đã sao chép nội dung.'; }
    catch { $('error').textContent = 'Không sao chép được. Hãy chọn và copy thủ công.'; }
  });
  $('ai-result-save').addEventListener('click', () => {
    saveDraft({ title: lastCategoryAiTitle, body: $('ai-result-text').value, images: lastCategoryAiImages },
      $('ai-result-save-status'));
  });
  $('ai-each').addEventListener('click', () => {
    if (batchRunning) { batchCancelled = true; update(); return; }
    runAiEachBatch();
  });
  function validDealImages(list) {
    return (Array.isArray(list) ? list : []).filter(src => {
      try { return ['http:', 'https:'].includes(new URL(src).protocol); } catch { return false; }
    });
  }
  async function runAiEachBatch() {
    const items = products.filter(p => selected.has(p.id));
    if (!items.length || batchRunning) return;
    batchCurrent = 0; batchTotal = items.length;
    batchRunning = true; batchCancelled = false; update();
    $('ai-each-status').textContent = '';
    $('ai-each-list').replaceChildren();
    const engine = root.querySelector('input[name="engine"]:checked')?.value || 'firefox';
    const proxy = root.querySelector('[data-deal-id="proxy"]')?.value.trim() || undefined;
    for (const [index, p] of items.entries()) {
      if (batchCancelled) break;
      batchCurrent = index + 1; update();
      const row = document.createElement('article'); row.className = 'category-ai-each-item';
      const head = document.createElement('div'); head.className = 'category-ai-each-head';
      const thumb = document.createElement('img'); thumb.className = 'category-ai-each-thumb'; thumb.src = p.thumbnail; thumb.alt = p.title;
      const heading = document.createElement('div'); heading.className = 'category-ai-each-title'; heading.textContent = p.title;
      head.append(thumb, heading);
      const loading = document.createElement('div'); loading.className = 'category-ai-each-loading';
      loading.innerHTML = '<span class="ai-spinner"></span> Đang lấy deal và soạn nội dung…';
      const textarea = document.createElement('textarea'); textarea.rows = 4; textarea.hidden = true;
      const actions = document.createElement('div'); actions.className = 'category-ai-each-actions'; actions.hidden = true;
      const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.textContent = 'Sao chép';
      const saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.textContent = 'Lưu bản nháp';
      const saveStatus = document.createElement('span'); saveStatus.className = 'category-ai-save-status';
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(textarea.value); $('ai-each-status').textContent = 'Đã sao chép nội dung — ' + p.title + '.'; }
        catch { $('error').textContent = 'Không sao chép được. Hãy chọn và copy thủ công.'; }
      });
      let rowImages = [];
      saveBtn.addEventListener('click', () => {
        saveDraft({ title: p.title, body: textarea.value, images: rowImages, link: p.url, price: p.price }, saveStatus);
      });
      actions.append(copyBtn, saveBtn, saveStatus);
      const gallery = document.createElement('div'); gallery.className = 'category-content-images';
      gallery.setAttribute('aria-label', 'Ảnh sản phẩm dùng tạo bài');
      row.append(head, loading, gallery, textarea, actions);
      $('ai-each-list').append(row);
      try {
        const response = await fetch(base + '/api/get-deal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: p.url, engine, proxy, allColors: false }),
        });
        let data;
        try { data = await response.json(); } catch { throw new Error('Server phản hồi không hợp lệ.'); }
        if (!response.ok) throw new Error(data.error || 'Không lấy được deal.');
        const images = validDealImages(data.images).slice(0, 5);
        if (!images.length) throw new Error('Không tìm thấy ảnh sản phẩm.');
        rowImages = images;
        renderImages(gallery, images.map((src, i) => ({ src, title: p.title + ' — Ảnh ' + (i + 1) })));
        loading.lastChild.textContent = ' Đã lấy ' + images.length + ' ảnh · Đang soạn nội dung…';
        const content = await window.aiSuggestFromUrls(images, 'short', '', p.title);
        textarea.value = content || '(Không có kết quả)';
      } catch (e) {
        textarea.value = '';
        loading.innerHTML = '❌ ' + e.message;
        continue;
      }
      loading.hidden = true;
      textarea.hidden = false;
      actions.hidden = false;
    }
    $('ai-each-status').textContent = batchCancelled ? 'Đã dừng.' : 'Đã xử lý xong ' + items.length + ' sản phẩm.';
    batchRunning = false; update();
  }
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
