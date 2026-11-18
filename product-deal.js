(() => {

const BASE_URL = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');

const root = document.querySelector('[data-deal-app]');
const $ = (id) => root.querySelector('[data-deal-id=' + id + ']');
const btn = $('go');
let currentDeal = null;
let currentDownloads = []; // hàm tải từng ảnh, dùng lại cho nút "Tải tất cả ảnh"

function setStatus(msg) { $('status').textContent = msg || ''; }
function setError(msg) { $('error').textContent = msg || ''; }

function updateSelectedCount() {
  const total = root.querySelectorAll('.draft-image').length;
  const checked = root.querySelectorAll('.draft-image:checked').length;
  $('images-selected-count').textContent = total ? ('Đã chọn ' + checked + '/' + total + ' ảnh') : '';
}
$('images').addEventListener('change', (e) => {
  if (e.target.classList.contains('draft-image')) updateSelectedCount();
});

// Nhớ proxy đã nhập lần trước để khỏi phải gõ lại mỗi lần lấy deal.
const PROXY_STORAGE_KEY = 'xeko-deal-proxy';
try {
  const savedProxy = localStorage.getItem(PROXY_STORAGE_KEY);
  if (savedProxy) $('proxy').value = savedProxy;
} catch {}
$('proxy').addEventListener('input', () => {
  try {
    const v = $('proxy').value.trim();
    if (v) localStorage.setItem(PROXY_STORAGE_KEY, v);
    else localStorage.removeItem(PROXY_STORAGE_KEY);
  } catch {}
});

btn.addEventListener('click', async () => {
  const url = $('url').value.trim();
  if (!url) { setError('Chưa nhập link'); return; }

  const selectedEngine = root.querySelector('input[name="engine"]:checked');
  const engine = selectedEngine.value;
  const engineLabel = selectedEngine.parentElement.textContent.trim();
  currentDeal = null;
  $('draft-panel').hidden = true;
  $('draft-status').textContent = '';
  $('draft-preview').textContent = '';
  $('draft-library').hidden = true;
  btn.disabled = true;
  $('engines').disabled = true;
  setError('');
  $('price-section').hidden = true;
  $('price-section').classList.remove('no-price');
  $('price').textContent = '';
  $('images-section').hidden = true;
  $('images-toolbar').hidden = true;
  $('images-selected-count').textContent = '';
  $('shot').innerHTML = '';
  $('images').replaceChildren();
  $('images-status').textContent = '';
  $('debug').textContent = '';
  setStatus('Đang mở trang bằng ' + engineLabel + ' và tự bấm ảnh thu nhỏ để gom ảnh sản phẩm...');

  try {
    const res = await fetch(BASE_URL + '/api/get-deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, proxy: $('proxy').value.trim() || undefined, engine }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi không rõ');

    setStatus('Xong — trình duyệt đã chọn: ' + engineLabel + '.');
    $('price-section').hidden = false;
    $('price-section').classList.toggle('no-price', !data.price);
    $('price').textContent = data.price || 'Không đọc được giá trên trang này.';

    const images = (Array.isArray(data.images) ? data.images : []).filter(src => {
      try { return ['http:', 'https:'].includes(new URL(src).protocol); } catch { return false; }
    });
    $('images-section').hidden = false;
    $('images-status').textContent = images.length
      ? 'Ảnh sản phẩm: ' + images.length + ' — ưu tiên bản lớn/ảnh zoom; bấm để mở và lưu ảnh.'
      : 'Chưa tìm thấy ảnh sản phẩm trong dữ liệu trang.';
    $('images-toolbar').hidden = !images.length;
    currentDeal = { price: data.price, images };
    $('draft-title').value = data.debug?.pageTitle || '';
    $('draft-description').value = '';
    $('draft-panel').hidden = !images.length;
    $('create-draft').disabled = false;
    currentDownloads = [];
    images.forEach((src, index) => {
      const item = document.createElement('div');
      const link = document.createElement('a');
      link.href = src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Ảnh sản phẩm ' + (index + 1);
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        link.append(document.createTextNode(' (không tải được bản xem trước)'));
      });
      link.append(img, document.createTextNode('Link ảnh ' + (index + 1)));
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'dl-icon-btn';
      download.title = 'Tải ảnh ' + (index + 1);
      download.setAttribute('aria-label', 'Tải ảnh ' + (index + 1));
      download.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M4 19h16"/></svg>';
      const feedback = document.createElement('div');
      feedback.className = 'status';
      const runDownload = async () => {
        download.disabled = true;
        feedback.textContent = 'Đang tải ảnh lớn...';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(src, { signal: controller.signal, credentials: 'omit' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const blob = await response.blob();
          if (!blob.size || !blob.type.startsWith('image/')) throw new Error('Không nhận được ảnh');
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
            'image/avif': 'avif', 'image/gif': 'gif' }[blob.type] || 'img';
          const objectUrl = URL.createObjectURL(blob);
          const save = document.createElement('a');
          save.href = objectUrl;
          save.download = 'san-pham-' + (index + 1) + '.' + ext;
          document.body.append(save);
          save.click();
          save.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
          feedback.textContent = 'Đã gửi ảnh tới trình duyệt để lưu.';
        } catch {
          feedback.textContent = 'Không tải trực tiếp được. Bấm “Link ảnh” phía trên, rồi chọn “Lưu hình ảnh thành…”.';
        } finally {
          clearTimeout(timeout);
          download.disabled = false;
        }
      };
      download.addEventListener('click', runDownload);
      currentDownloads.push(runDownload);
      const choice = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'draft-image';
      checkbox.value = src;
      checkbox.checked = index < 20;
      choice.append(checkbox, document.createTextNode(' Dùng ảnh ' + (index + 1)));
      item.className = 'deal-image';
      item.append(choice, link, download, feedback);
      $('images').append(item);
    });
    updateSelectedCount();

    if (data.debug) {
      $('debug').textContent = JSON.stringify(data.debug, null, 2);
    }

    if (data.screenshotFile) {
      const img = document.createElement('img');
      img.src = BASE_URL + '/api/get-deal-image?file=' + encodeURIComponent(data.screenshotFile);
      $('shot').append(img);
    }
  } catch (e) {
    setStatus('');
    setError('❌ ' + e.message);
  } finally {
    btn.disabled = false;
    $('engines').disabled = false;
  }
});
$('images-select-all').addEventListener('click', () => {
  root.querySelectorAll('.draft-image').forEach(cb => { cb.checked = true; });
  updateSelectedCount();
});
$('images-select-none').addEventListener('click', () => {
  root.querySelectorAll('.draft-image').forEach(cb => { cb.checked = false; });
  updateSelectedCount();
});
$('images-download-all').addEventListener('click', async () => {
  const allBtn = $('images-download-all');
  allBtn.disabled = true;
  for (const run of currentDownloads) await run();
  allBtn.disabled = false;
});

$('draft-library').href = BASE_URL + '/?page=drafts';
$('create-draft').addEventListener('click', async () => {
  const images = [...root.querySelectorAll('.draft-image:checked')].map(el => el.value);
  const title = $('draft-title').value.trim();
  if (!title || !images.length || images.length > 20) {
    $('draft-status').textContent = 'Nhập tên sản phẩm và chọn từ 1 đến 20 ảnh.';
    return;
  }
  $('create-draft').disabled = true;
  btn.disabled = true;
  $('draft-status').textContent = 'Đang tải ảnh, nhờ AI viết và lưu bản nháp…';
  try {
    const response = await fetch(BASE_URL + '/api/product-drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, images, price: currentDeal?.price,
        description: $('draft-description').value, style: $('draft-style').value, url: $('url').value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không lưu được bản nháp');
    $('draft-preview').textContent = data.item.body;
    $('draft-status').textContent = 'Đã lưu bản nháp #' + data.item.id + ' với ' + data.item.images.length + ' ảnh trong Kho content. Chưa đăng bài.';
    $('draft-library').href = BASE_URL + '/?page=drafts&draft=' + encodeURIComponent(data.item.id);
    $('draft-library').hidden = false;
  } catch (error) {
    $('draft-status').textContent = error.message + ' Nếu mất kết nối, kiểm tra Kho content trước khi tạo lại để tránh trùng bài.';
    $('create-draft').disabled = false;
  } finally { btn.disabled = false; }
});

$('draft-library').addEventListener('click', async (event) => {
  if (typeof switchPage !== 'function') return;
  event.preventDefault();
  const id = Number(new URL(event.currentTarget.href).searchParams.get('draft'));
  await switchPage('drafts');
  if (Number.isSafeInteger(id) && id > 0) await openContentModal(id);
});

})();
