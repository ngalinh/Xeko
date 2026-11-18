(() => {

const BASE_URL = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');

const root = document.querySelector('[data-deal-app]');
const $ = (id) => root.querySelector('[data-deal-id=' + id + ']');
const btn = $('go');
let currentDeal = null;

function setStatus(msg) { $('status').textContent = msg || ''; }
function setError(msg) { $('error').textContent = msg || ''; }

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
  $('price').textContent = '';
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
    $('price').textContent = data.price ? ('Giá đọc được: ' + data.price) : 'Không đọc được giá trên trang này.';

    const images = (Array.isArray(data.images) ? data.images : []).filter(src => {
      try { return ['http:', 'https:'].includes(new URL(src).protocol); } catch { return false; }
    });
    $('images-status').textContent = images.length
      ? 'Ảnh sản phẩm: ' + images.length + ' — ưu tiên bản lớn/ảnh zoom; bấm để mở và lưu ảnh.'
      : 'Chưa tìm thấy ảnh sản phẩm trong dữ liệu trang.';
    currentDeal = { price: data.price, images };
    $('draft-title').value = data.debug?.pageTitle || '';
    $('draft-description').value = '';
    $('draft-panel').hidden = !images.length;
    $('create-draft').disabled = false;
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
      link.append(img, document.createTextNode('Mở ảnh lớn ' + (index + 1)));
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = 'Tải ảnh ' + (index + 1);
      const feedback = document.createElement('div');
      feedback.className = 'status';
      download.addEventListener('click', async () => {
        download.disabled = true;
        feedback.textContent = 'Đang tải ảnh lớn...';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(src, { signal: controller.signal(), credentials: 'omit' });
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
          feedback.textContent = 'Không tải trực tiếp được. Bấm “Mở ảnh lớn” phía trên, rồi chọn “Lưu hình ảnh thành…”.';
        } finally {
          clearTimeout(timeout);
          download.disabled = false;
        }
      });
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
