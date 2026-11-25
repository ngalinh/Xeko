(() => {

const BASE_URL = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');

const root = document.querySelector('[data-deal-app]');
const $ = (id) => root.querySelector('[data-deal-id=' + id + ']');
const btn = $('go');
let currentDeal = null;
let currentDownloads = []; // hàm tải từng ảnh, dùng lại cho nút "Tải tất cả ảnh"

// ===== Chọn trước profile + nơi đăng (tuỳ chọn) =====
// Chỉ ảnh hưởng tới nút "Dùng để đăng bài": nếu để trống thì hành vi y hệt
// trước giờ (qua tab Đăng bài rồi tự chọn kênh). Dữ liệu kênh lấy từ cùng
// nguồn với tab "Kênh" của app (/api/channels), không tạo thêm state riêng.
let _dealIgAccounts = [];
let _dealChannelsData = { fbGroups: [], fbPages: [], zaloGroups: [], profileChannels: {} };

Promise.all([
  fetch(BASE_URL + '/api/accounts').then(r => r.json()).catch(() => ({})),
  fetch(BASE_URL + '/api/channels').then(r => r.json()).catch(() => ({})),
]).then(([accounts, channels]) => {
  const profiles = (accounts && accounts.facebook) || [];
  _dealIgAccounts = (accounts && accounts.instagram) || [];
  _dealChannelsData = channels && channels.profileChannels ? channels : _dealChannelsData;
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.name || p.key;
    $('post-profile').appendChild(opt);
  }
});

// Danh sách kênh có thể tick cho profile đang chọn — cùng độ chi tiết mà
// khung chat "Đăng bài" hỗ trợ: cả nhóm FB chỉ chọn được theo category (bó
// chung), không chọn được 1 nhóm lẻ trong category.
let _dealSelectedChannels = []; // [{ type: 'personal'|'group'|'page'|'zalo'|'instagram', key?, category?, label, sub, icon }]

function dealChannelKey(o) {
  return o.type === 'personal' ? 'personal' : o.type + ':' + (o.key || o.category);
}

function dealChannelToTargetVal(o) {
  if (o.type === 'personal') return 'fb:personal';
  if (o.type === 'group') return 'fb:cat:' + o.category;
  if (o.type === 'page') return 'fb:page:' + o.key;
  if (o.type === 'zalo') return 'zalo:' + o.key;
  if (o.type === 'instagram') return 'instagram:' + o.key;
  return null;
}

function buildDealChannelOptions(profileKey) {
  const cfg = (_dealChannelsData.profileChannels || {})[profileKey] || {};
  const opts = [{ type: 'personal', icon: 'home', label: 'Profile', sub: '' }];
  const fbGroupKeys = new Set(cfg.fbGroups || []);
  const catCount = new Map();
  for (const g of (_dealChannelsData.fbGroups || [])) {
    if (!fbGroupKeys.has(g.key)) continue;
    const cat = (g.category || '').trim() || 'Chưa phân loại';
    catCount.set(cat, (catCount.get(cat) || 0) + 1);
  }
  for (const [cat, count] of [...catCount.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))) {
    opts.push({ type: 'group', category: cat, icon: 'users', label: cat, sub: String(count) });
  }
  const fbPageKeys = new Set(cfg.fbPages || []);
  for (const p of (_dealChannelsData.fbPages || [])) {
    if (fbPageKeys.has(p.key)) opts.push({ type: 'page', key: p.key, icon: 'file', label: p.name || p.key, sub: 'Page' });
  }
  const zaloGroupKeys = new Set(cfg.zaloGroups || []);
  for (const z of (_dealChannelsData.zaloGroups || [])) {
    if (zaloGroupKeys.has(z.key)) opts.push({ type: 'zalo', key: z.key, icon: 'chat', label: z.name || z.key, sub: 'Zalo' });
  }
  const igKeys = new Set(cfg.instagram || []);
  for (const ig of _dealIgAccounts) {
    if (igKeys.has(ig.key)) opts.push({ type: 'instagram', key: ig.key, icon: 'camera', label: ig.name || ig.key, sub: 'Instagram' });
  }
  return opts;
}

// Khung tick chọn kênh — cùng kiểu danh sách checkbox như modal "Repost bài
// viết" (tài khoản/nơi đăng), nhưng tự quản state riêng (_dealSelectedChannels)
// để không đụng vào state của modal Repost.
function renderDealChannelList() {
  const container = $('post-target-list');
  const profileKey = $('post-profile').value;
  if (!profileKey) {
    container.innerHTML = '<div class="deal-channel-hint">Chọn profile trước</div>';
    return;
  }
  const opts = buildDealChannelOptions(profileKey);
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (x => x);
  const icon = (name) => (typeof xekoIcon === 'function') ? xekoIcon(name, 'xi xi-sm') : '';
  container.innerHTML = opts.map((o, i) => {
    const selected = _dealSelectedChannels.some(c => dealChannelKey(c) === dealChannelKey(o));
    return `<label class="deal-channel-item${selected ? ' selected' : ''}">`
      + `<input type="checkbox" data-idx="${i}"${selected ? ' checked' : ''}>`
      + icon(o.icon) + `<span class="deal-channel-label">${esc(o.label)}</span>`
      + (o.sub ? `<span class="deal-channel-sub">${esc(o.sub)}</span>` : '')
      + `</label>`;
  }).join('');
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const o = opts[Number(cb.dataset.idx)];
      const key = dealChannelKey(o);
      if (cb.checked) {
        if (!_dealSelectedChannels.some(c => dealChannelKey(c) === key)) _dealSelectedChannels.push(o);
      } else {
        _dealSelectedChannels = _dealSelectedChannels.filter(c => dealChannelKey(c) !== key);
      }
      cb.closest('.deal-channel-item').classList.toggle('selected', cb.checked);
    });
  });
}

$('post-profile').addEventListener('change', () => {
  _dealSelectedChannels = []; // đổi profile → nơi đăng của profile cũ không còn hợp lệ
  renderDealChannelList();
});

// Job nền + poll — tránh giới hạn ~60s của ngrok free khi quét nhiều màu hoặc
// khi bị chặn bot phải đổi engine (xem get-deal.js), chạy lâu hơn 1 request
// HTTP giữ được. Poll mỗi 3s, tối đa 10 phút.
async function pollDealJob(jobId) {
  for (let i = 0; i < 200; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 3000));
    const res = await fetch(BASE_URL + '/api/deal-job/' + encodeURIComponent(jobId));
    let job;
    try { job = await res.json(); } catch { continue; }
    if (job.status === 'done') {
      if (!job.ok) throw new Error(job.error || 'Lỗi không rõ');
      return job.result;
    }
  }
  throw new Error('Quá 10 phút chưa xong — kiểm tra log server hoặc thử lại.');
}

function waitFor(conditionFn, timeoutMs = 6000, intervalMs = 150) {
  return new Promise(resolve => {
    const start = Date.now();
    (function tick() {
      const value = conditionFn();
      if (value) return resolve(value);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    })();
  });
}

function findDealChannelCheckbox(panel, targetVal) {
  const sepIdx = targetVal.indexOf(':');
  const platform = sepIdx < 0 ? targetVal : targetVal.slice(0, sepIdx);
  const rest = sepIdx < 0 ? '' : targetVal.slice(sepIdx + 1);
  const items = panel.querySelectorAll('.channel-item');
  for (const item of items) {
    if (item.dataset.platform !== platform) continue;
    if (platform === 'fb') {
      if (rest === 'personal' && item.dataset.chid === 'personal') return item.querySelector('input');
      if (rest.startsWith('cat:') && item.dataset.chid === 'cat' && item.dataset.category === rest.slice(4)) return item.querySelector('input');
      if (rest.startsWith('page:') && item.dataset.chid === rest) return item.querySelector('input');
    } else if (item.dataset.chid === rest) {
      return item.querySelector('input');
    }
  }
  return null;
}

// Tick sẵn đúng (các) kênh đã chọn trong khung chat "Đăng bài" — dùng lại
// nguyên các hàm thật của khung chat (selectMode/onChannelChange/
// confirmChannelSelection) thay vì tự dựng lại logic chọn kênh. Panel kênh
// render bất đồng bộ (phải gọi API /api/channels, /api/accounts riêng của
// khung chat) nên phải đợi. Nếu có gì bất thường (panel không render kịp,
// không tìm thấy đúng kênh) thì bỏ qua lặng lẽ — người dùng vẫn tự chọn kênh
// như bình thường ở tab Đăng bài.
async function preselectDealChannels(targetVals) {
  if (!targetVals.length || typeof selectMode !== 'function' || typeof confirmChannelSelection !== 'function') return;
  const beforePid = (typeof channelPanelId === 'number') ? channelPanelId : 0;
  selectMode('now');
  const panel = await waitFor(() => {
    if (typeof channelPanelId !== 'number' || channelPanelId <= beforePid) return null;
    return document.getElementById('channelPanel_' + channelPanelId);
  });
  if (!panel) return;
  const pid = channelPanelId;
  let checkedAny = false;
  for (const val of targetVals) {
    const checkbox = findDealChannelCheckbox(panel, val);
    if (checkbox) { checkbox.checked = true; checkedAny = true; }
  }
  if (!checkedAny) return;
  if (typeof onChannelChange === 'function') onChannelChange(pid);
  confirmChannelSelection(pid);
}

function setStatus(msg) { $('status').textContent = msg || ''; }
function setError(msg) { $('error').textContent = msg || ''; }

function updateSelectedCount() {
  const total = root.querySelectorAll('.draft-image').length;
  const checked = root.querySelectorAll('.draft-image:checked').length;
  $('images-select-all').checked = total > 0 && checked === total;
  $('images-select-all').indeterminate = checked > 0 && checked < total;
  $('images-selected-count').textContent = total ? ('Đã chọn ' + checked + '/' + total + ' ảnh') : '';
  const aiBtn = $('ai-suggest');
  if (aiBtn) aiBtn.style.display = checked > 0 ? '' : 'none';
}
$('images').addEventListener('change', (e) => {
  if (e.target.classList.contains('draft-image')) updateSelectedCount();
});

// ===== AI Editor nội tuyến (thay cho sheet popup dùng chung toàn app) =====
// Tự chứa, không đụng state/DOM của sheet AI Editor ở tab Đăng bài/Theo category.
let _dealAiStyle = 'short';
let _dealAiCache = {}; // style -> nội dung đã tạo, dùng lại khi đổi qua lại phong cách
let _dealAiGenerating = false;
let _dealAiResult = '';

function resetDealAiPanel() {
  $('ai-panel').hidden = true;
  _dealAiCache = {};
  _dealAiResult = '';
  _dealAiStyle = 'short';
  $('ai-styles').querySelectorAll('.deal-ai-style').forEach(b => b.classList.toggle('active', b.dataset.style === 'short'));
}

$('ai-suggest').addEventListener('click', () => {
  const panel = $('ai-panel');
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (opening) runDealAiGenerate();
});

$('ai-styles').querySelectorAll('.deal-ai-style').forEach(chip => {
  chip.addEventListener('click', () => {
    if (chip.dataset.style === _dealAiStyle && !_dealAiGenerating) return;
    $('ai-styles').querySelectorAll('.deal-ai-style').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    _dealAiStyle = chip.dataset.style;
    const cached = _dealAiCache[_dealAiStyle];
    if (cached) showDealAiResult(cached); else runDealAiGenerate();
  });
});

async function runDealAiGenerate() {
  if (_dealAiGenerating) return;
  _dealAiGenerating = true;
  const resultEl = $('ai-result');
  const applyBtn = $('ai-apply');
  const retryBtn = $('ai-retry');
  _dealAiResult = '';
  resultEl.classList.add('loading');
  resultEl.innerHTML = '<span class="ai-spinner"></span> AI đang phân tích ảnh sản phẩm...';
  applyBtn.disabled = true;
  retryBtn.disabled = true;
  try {
    const urls = [...root.querySelectorAll('.draft-image:checked')].map(el => el.value).slice(0, 5);
    const form = new FormData();
    for (const url of urls) {
      try { form.append('images', await (await fetch(url)).blob(), 'image.jpg'); } catch { /* bỏ qua ảnh lỗi */ }
    }
    form.append('style', _dealAiStyle);
    const productName = $('draft-title').value.trim();
    if (productName) form.append('productName', productName);
    const res = await fetch(BASE_URL + '/api/ai/suggest', { method: 'POST', credentials: 'include', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi không xác định');
    const text = (data.suggestions || [])[0] || '';
    _dealAiCache[_dealAiStyle] = text;
    showDealAiResult(text);
  } catch (err) {
    resultEl.classList.remove('loading');
    resultEl.textContent = '❌ ' + err.message;
    applyBtn.disabled = true;
  } finally {
    _dealAiGenerating = false;
    retryBtn.disabled = false;
  }
}

function showDealAiResult(text) {
  _dealAiResult = text;
  const resultEl = $('ai-result');
  resultEl.classList.remove('loading');
  resultEl.textContent = text || '(Không có kết quả)';
  $('ai-apply').disabled = !text;
}

$('ai-retry').addEventListener('click', runDealAiGenerate);
$('ai-apply').addEventListener('click', () => {
  if (!_dealAiResult) return;
  $('draft-description').value = _dealAiResult;
  $('ai-panel').hidden = true;
  $('draft-description').focus();
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Tính giá VNĐ từ Giá sale (USD) và Tỷ giá nhập tay (vd "1 USD = 25.500 VND").
function computeVndPrice() {
  const saleMatch = ($('price').textContent || '').match(/[\d.,]+/);
  const sale = saleMatch ? parseFloat(saleMatch[0].replace(/,/g, '')) : null;
  const rateMatch = ($('exchange-rate').value || '').match(/([\d.,]+)\s*(?:vnd|đ)?\s*$/i);
  const rate = rateMatch ? parseInt(rateMatch[1].replace(/[.,]/g, ''), 10) : null;
  $('price-vnd').textContent = (sale && rate) ? Math.round(sale * rate).toLocaleString('vi-VN') + ' VNĐ' : '—';
}
$('exchange-rate').addEventListener('input', computeVndPrice);

// Lịch sử lấy deal — tên sản phẩm/link/website đã lấy gần đây, để biết ai đã lấy gì.
let historyPage = 1;
let historyRequest = 0;
async function loadDealHistory(page = historyPage) {
  const body = $('history-body');
  if (!body) return;
  const pager = $('history-pagination');
  const request = ++historyRequest;
  if (pager) pager.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const res = await fetch(BASE_URL + '/api/deal-history?limit=20&page=' + page);
    if (!res.ok) throw new Error('Không tải được lịch sử');
    const data = await res.json();
    if (request !== historyRequest) return;
    const rows = Array.isArray(data) ? data : data.rows;
    historyPage = Array.isArray(data) ? 1 : data.page;
    if (pager) {
      pager.replaceChildren();
      pager.hidden = !rows?.length;
      const pages = data.pages || 1;
      const info = document.createElement('span');
      info.textContent = `Trang ${historyPage}/${pages} · ${data.total ?? rows.length} lượt`;
      pager.appendChild(info);
      const addButton = (label, target, disabled, current = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = disabled;
        button.setAttribute('aria-label', /^\d+$/.test(label) ? 'Trang ' + label : label);
        if (current) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => loadDealHistory(target));
        pager.appendChild(button);
      };
      addButton('Trước', historyPage - 1, historyPage === 1);
      const visible = new Set([1, pages]);
      for (let n = Math.max(1, historyPage - 2); n <= Math.min(pages, historyPage + 2); n++) visible.add(n);
      let previous = 0;
      for (const n of [...visible].sort((a, b) => a - b)) {
        if (previous && n - previous > 1) {
          const gap = document.createElement('span');
          gap.textContent = '…';
          pager.appendChild(gap);
        }
        addButton(String(n), n, n === historyPage, n === historyPage);
        previous = n;
      }
      addButton('Sau', historyPage + 1, historyPage === pages);
    }
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="deal-history-empty">Chưa có lịch sử lấy deal.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r, index) => {
      const title = r.title || '(không có tên)';
      const time = r.createdAt ? new Date(r.createdAt).toLocaleString('vi-VN') : '';
      const linkCell = r.url
        ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a>`
        : '—';
      return `<tr>
        <td>${(historyPage - 1) * 20 + index + 1}</td>
        <td><span title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          ${r.log ? `<details class="deal-history-log"><summary>Chi tiết lượt lấy deal · ${r.log.status === 'error' ? 'Thất bại' : 'Thành công'}</summary><pre>${escapeHtml(JSON.stringify(r.log, null, 2))}</pre></details>` : '<div class="status">Chưa có log</div>'}
        </td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td>${linkCell}</td>
        <td>${escapeHtml(r.website || '—')}</td>
        <td>${escapeHtml(time)}</td>
      </tr>`;
    }).join('');
  } catch {
    if (request !== historyRequest) return;
    if (pager) pager.hidden = true;
    body.innerHTML = '<tr><td colspan="6" class="deal-history-empty">Không tải được lịch sử.</td></tr>';
  }
}
loadDealHistory();

// Chuyển tab chỉ ẩn panel để giữ nguyên form và ảnh đang chọn.
const dealTabs = document.querySelectorAll('[data-deal-tab]');
for (const tab of dealTabs) {
  tab.addEventListener('click', () => {
    const selected = tab.dataset.dealTab;
    for (const button of dealTabs) {
      if (button === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    root.querySelectorAll('[data-deal-panel]').forEach(panel => {
      panel.hidden = panel.dataset.dealPanel !== selected;
    });
    if (selected === 'history') loadDealHistory();
  });
}

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
  resetDealAiPanel();
  $('product-info').hidden = true;
  $('draft-status').textContent = '';
  $('draft-preview').textContent = '';
  $('draft-library').hidden = true;
  $('use-for-post').hidden = true;
  btn.disabled = true;
  $('engines').disabled = true;
  setError('');
  $('price-section').hidden = true;
  $('price-section').classList.remove('no-price');
  $('price').textContent = '';
  $('price-vnd').textContent = '—';
  $('images-section').hidden = true;
  $('images-toolbar').hidden = true;
  $('images-selected-count').textContent = '';
  $('shot').innerHTML = '';
  $('images').replaceChildren();
  $('images-status').textContent = '';
  $('debug').textContent = '';
  const allColors = $('all-colors').checked;
  setStatus('Đang mở trang bằng ' + engineLabel + (allColors
    ? ' và lấy ảnh lần lượt từng màu (có thể mất vài phút)...'
    : ' và tự bấm ảnh thu nhỏ để gom ảnh sản phẩm...'));

  try {
    const startRes = await fetch(BASE_URL + '/api/get-deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, proxy: $('proxy').value.trim() || undefined, engine, allColors }),
    });
    let start;
    try { start = await startRes.json(); } catch {
      throw new Error('Server phản hồi không hợp lệ. Hãy thử lại.');
    }
    if (!startRes.ok || !start.jobId) throw new Error(start.error || 'Lỗi không rõ');
    const data = await pollDealJob(start.jobId);

    const colorNote = Array.isArray(data.debug?.colors) && data.debug.colors.length > 1
      ? ' Đã lấy ' + data.debug.colors.length + ' màu.'
      : '';
    setStatus(colorNote.trim());
    $('price-section').hidden = false;
    $('price-section').classList.toggle('no-price', !data.price);
    $('product-info').hidden = false;
    // Only split explicitly labelled prices; missing values remain unknown.
    const rawPrice = String(data.price || '');
    const money = '(?:US\\$|\\$|€|£)?\\s*\\d[\\d,.]*';
    const sale = rawPrice.match(new RegExp('(?:sale|now|giá sale)\\s*:?\\s*(' + money + ')', 'i'));
    const original = rawPrice.match(new RegExp('(?:orig(?:inal)?\\.?|regular|was|giá gốc)\\s*:?\\s*(' + money + ')', 'i'));
    const discount = rawPrice.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:off|giảm)/i);
    $('price').textContent = sale ? sale[1].trim() : (rawPrice || 'Chưa có giá');
    $('original-price').textContent = original ? original[1].trim() : '—';
    $('discount').textContent = discount ? discount[1] + '%' : '—';
    computeVndPrice();

    const images = (Array.isArray(data.images) ? data.images : []).filter(src => {
      try { return ['http:', 'https:'].includes(new URL(src).protocol); } catch { return false; }
    });
    $('images-section').hidden = false;
    $('images-status').textContent = images.length ? '' : 'Chưa tìm thấy ảnh sản phẩm trong dữ liệu trang.';
    $('images-toolbar').hidden = !images.length;
    currentDeal = { price: data.price, images };
    $('draft-title').value = data.debug?.jsonLdProducts?.[0]?.name || data.debug?.pageTitle || '';
    $('draft-description').value = '';
    $('draft-panel').hidden = !images.length;
    $('create-draft').disabled = false;
    currentDownloads = [];
    const groups = [];
    const assigned = new Set();
    for (const color of (Array.isArray(data.debug?.colors) ? data.debug.colors : [])) {
      const sources = (Array.isArray(color.images) ? color.images : []).filter(src => {
        if (!images.includes(src) || assigned.has(src)) return false;
        assigned.add(src);
        return true;
      });
      if (!sources.length) continue;
      let label = typeof color.label === 'string' ? color.label.replace(/^Color:\s*/i, '').trim() : '';
      if (!label && groups.length === 0) {
        try { label = new URL(url).searchParams.get('swatchColor') || ''; } catch {}
      }
      groups.push({ label: label || 'Màu ban đầu', images: sources });
    }
    const remaining = images.filter(src => !assigned.has(src));
    if (remaining.length) groups.push({ label: groups.length ? 'Ảnh khác' : 'Ảnh sản phẩm', images: remaining });
    $('images').classList.toggle('has-color-groups', groups.length > 0);
    groups.forEach(group => {
      const section = document.createElement('section');
      section.className = 'deal-color-group';
      const header = document.createElement('div');
      header.className = 'deal-color-header';
      const heading = document.createElement('h3');
      heading.textContent = group.label + ' · ' + group.images.length + ' ảnh';
      header.append(heading);
      const grid = document.createElement('div');
      grid.className = 'product-images';
      for (const [text, checked] of [['Chọn màu này', true], ['Bỏ chọn', false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-label', text + ': ' + group.label);
        button.addEventListener('click', () => {
          grid.querySelectorAll('.draft-image').forEach(cb => { cb.checked = checked; });
          updateSelectedCount();
        });
        header.append(button);
      }
      section.append(header, grid);
      $('images').append(section);
      group.images.forEach(src => {
        const index = images.indexOf(src);
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
        link.append(img);
        link.setAttribute('aria-label', 'Mở ảnh ' + (index + 1) + ' trong tab mới');
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
            feedback.textContent = 'Không tải trực tiếp được. Bấm vào ảnh, rồi chọn “Lưu hình ảnh thành…”.';
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
        checkbox.setAttribute('aria-label', 'Chọn ảnh ' + (index + 1));
        choice.append(checkbox);
        item.className = 'deal-image';
        item.append(choice, link, download, feedback);
        grid.append(item);
      });
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
    loadDealHistory();
    btn.disabled = false;
    $('engines').disabled = false;
  }
});
$('images-select-all').addEventListener('change', (event) => {
  root.querySelectorAll('.draft-image').forEach(cb => { cb.checked = event.target.checked; });
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
        description: [$('draft-description').value.trim(), $('exchange-rate').value.trim() ? 'Tỷ giá: ' + $('exchange-rate').value.trim() : ''].filter(Boolean).join('\n'), url: $('url').value.trim() }),
    });
    let data;
    try { data = await response.json(); } catch {
      throw new Error('Server phản hồi không hợp lệ, có thể do quá thời gian chờ. Vui lòng thử lại.');
    }
    if (!response.ok) throw new Error(data.error || 'Không lưu được bản nháp');
    $('draft-preview').textContent = data.item.body;
    $('draft-status').textContent = 'Đã lưu bản nháp #' + data.item.id + ' với ' + data.item.images.length + ' ảnh trong Kho content. Chưa đăng bài.';
    $('draft-library').href = BASE_URL + '/?page=drafts&draft=' + encodeURIComponent(data.item.id);
    $('draft-library').hidden = false;
    $('use-for-post').hidden = false;
    $('use-for-post').onclick = async () => {
      // useContent() đọc từ cache _contentItems (chỉ được nạp khi mở trang Kho
      // content) — nạp thẳng bản nháp vừa tạo vào cache để dùng ngay được dù
      // chưa từng mở trang đó trong phiên này.
      if (typeof _contentItems !== 'undefined') {
        _contentItems = _contentItems.filter(c => c.id !== data.item.id);
        _contentItems.push(data.item);
      }
      // Đã chọn sẵn profile/nơi đăng ở 2 ô trên → chuyển luôn trước khi mở
      // bản nháp để đăng, giống hệt như tự bấm chọn trong khung chat.
      const chosenProfile = $('post-profile').value;
      const chosenTargets = _dealSelectedChannels.map(dealChannelToTargetVal).filter(Boolean);
      if (chosenProfile && typeof selectProfile === 'function') {
        selectProfile(chosenProfile);
        // selectProfile() tự set currentProfile bất đồng bộ (sau khi gọi API
        // /api/profile) — đợi nó cập nhật xong rồi mới dựng panel kênh, nếu
        // không panel sẽ dựng nhầm theo profile cũ.
        await waitFor(() => (typeof currentProfile !== 'undefined' && currentProfile === chosenProfile) || null, 4000, 100);
      }
      if (chosenProfile && chosenTargets.length) {
        try { await preselectDealChannels(chosenTargets); } catch (e) {
          console.error('[deal] Không tự chọn được kênh, bạn chọn tay ở tab Đăng bài nhé.', e);
        }
      }
      if (typeof useContent === 'function') useContent(data.item.id);
    };
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
