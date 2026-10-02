(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = window.location.pathname.replace(/\/[^/]*$/, '');
  let records = [], page = 0, loading = false, loaded = false;
  const pageSize = 25;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const attention = r => ['review', 'unconfirmed', 'failed', 'duplicate'].includes(r.state) || !!r.error;
  const date = value => value ? new Date(value).toLocaleString('vi-VN') : '—';
  function field(label, value) { const cell = el('div'); cell.append(el('span', label, 'customer-field-label'), value); return cell; }
  function render() {
    const query = $('customerSearch').value.trim().toLocaleLowerCase('vi-VN');
    const status = $('customerStatus').value, account = $('customerAccount').value;
    const filtered = records.filter(r => (account === 'all' || r.profile === account)
      && (!query || [r.url, r.assessment?.name, r.assessment?.recipientId].some(v => String(v || '').toLocaleLowerCase('vi-VN').includes(query)))
      && (status === 'all' || status === 'sent' && r.sent || status === 'assessed' && r.assessment
        || status === 'imported' && !r.assessment && !r.sent || status === 'attention' && attention(r)));
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
    $('customerRecords').replaceChildren();
    for (const [index, r] of filtered.slice(page * pageSize, (page + 1) * pageSize).entries()) {
      const card = el('article', null, 'customer-record'), grid = el('div', null, 'customer-record-grid');
      const identity = el('div'); identity.append(el('strong', r.assessment?.name || 'Chưa có tên Facebook'));
      const link = el('a', r.url); link.href = r.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; identity.append(el('br'), link);
      const states = el('div');
      states.append(el('span', r.sent ? 'Đã gửi tin nhắn' : r.state === 'unconfirmed' ? 'Chưa xác nhận gửi' : r.assessment ? 'Đã đánh giá AI' : 'Đã nhập', 'badge'));
      if (attention(r)) states.append(el('p', 'Cần kiểm tra', 'muted'));
      grid.append(field('STT', String(page * pageSize + index + 1)), field('Khách hàng', identity), field('UID', String(r.assessment?.recipientId || 'Chưa xác định')), field('Tài khoản gửi', r.profile), field('Trạng thái', states));
      const details = el('details'); details.append(el('summary', 'Thông tin đã lưu & chiến dịch'));
      details.append(el('p', `Nhập lần đầu: ${date(r.importedAt)} · Cập nhật: ${date(r.updatedAt)}`));
      details.append(el('p', `Chiến dịch: ${r.campaigns.map(c => c.name || c.id).join(' · ')}`));
      if (r.assessment) {
        details.append(el('p', `AI đánh giá: ${r.assessment.eligible ? 'Đạt' : 'Cần kiểm tra'}`));
        for (const [label, value] of [['Bio', r.assessment.bio], ['Thương hiệu', r.assessment.brands?.join(', ')], ['Phân tích', r.assessment.captionAnalysis || r.assessment.reason]]) if (value) details.append(el('p', `${label}: ${value}`));
      }
      if (r.message) details.append(el('p', `Nội dung tin nhắn đã lưu${r.messageState === 'sent' ? '' : ' (chưa xác nhận gửi thành công)'}: ${r.message}`));
      if (r.error) details.append(el('p', `Lưu ý: ${r.error}`));
      card.append(grid, details); $('customerRecords').append(card);
    }
    $('customerLibraryStatus').textContent = `${filtered.length}/${records.length} khách · ${records.filter(r => r.sent).length} đã gửi · ${records.filter(r => r.assessment).length} đã đánh giá. Khách trùng link được gộp theo từng tài khoản gửi.`;
    if (!filtered.length) $('customerRecords').append(el('p', records.length ? 'Không có khách phù hợp bộ lọc.' : 'Chưa có dữ liệu khách hàng. Khách sẽ được lưu khi bạn nhập danh sách vào chiến dịch.', 'muted'));
    $('customerPage').textContent = `Trang ${page + 1}/${Math.max(1, Math.ceil(filtered.length / pageSize))}`;
    $('customerPrevious').disabled = page === 0; $('customerNext').disabled = (page + 1) * pageSize >= filtered.length;
  }
  async function load() {
    if (loading) return;
    loading = true; $('refreshCustomers').disabled = true;
    $('customerLibraryStatus').textContent = 'Đang tải dữ liệu khách hàng…';
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${base}/api/ctv/customers`, { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Không tải được dữ liệu');
      records = data; loaded = true;
      const selected = $('customerAccount').value;
      $('customerAccount').replaceChildren(new Option('Tất cả tài khoản', 'all'), ...[...new Set(records.map(r => r.profile))].sort().map(p => new Option(p, p)));
      $('customerAccount').value = [...$('customerAccount').options].some(o => o.value === selected) ? selected : 'all';
      render();
    } catch (e) { $('customerLibraryStatus').textContent = `${loaded ? 'Dữ liệu đang hiển thị chưa được cập nhật. ' : ''}Không tải được dữ liệu khách hàng. Bấm Cập nhật để thử lại. ${e.name === 'AbortError' ? 'Kết nối quá thời gian chờ.' : e.message}`; }
    finally { clearTimeout(timeout); loading = false; $('refreshCustomers').disabled = false; }
  }
  $('toggleCustomers').onclick = () => { const open = $('customerLibrary').hidden; document.dispatchEvent(new CustomEvent('ctv:view', { detail: open ? 'customers' : 'workflow' })); if (open) load(); };
  $('closeCustomers').onclick = () => { document.dispatchEvent(new CustomEvent('ctv:view', { detail: 'workflow' })); $('toggleCustomers').focus(); };
  $('refreshCustomers').onclick = load;
  $('customerSearch').oninput = $('customerStatus').onchange = $('customerAccount').onchange = () => { page = 0; render(); };
  $('customerPrevious').onclick = () => { page--; render(); };
  $('customerNext').onclick = () => { page++; render(); };
})();
