(() => {
  'use strict';
  // Keep requests inside this Xeko instance, including /b/<bot-id>/ deployments.
  const BASE_URL = window.location.pathname.replace(/\/[^/]*$/, '');
  const $ = id => document.getElementById(id);
  const closeMenu = () => { $('xekoSidebar').classList.remove('open'); $('xekoMenu').setAttribute('aria-expanded','false'); $('xekoMenu').setAttribute('aria-label','Mở menu Xeko'); };
  $('xekoMenu').onclick = () => {
    const open = $('xekoSidebar').classList.toggle('open');
    $('xekoMenu').setAttribute('aria-expanded',String(open));
    $('xekoMenu').setAttribute('aria-label',open?'Đóng menu Xeko':'Mở menu Xeko');
  };
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();}});
  const ACTIVE = ['analysis_queued','analyzing','uid_queued','resolving_uid','send_queued','sending'];
  const labels = { import_review:'Chờ duyệt danh sách',analysis_queued:'Chờ chạy AI',analyzing:'AI đang đánh giá',analysis_review:'Chờ duyệt kết quả AI',message_review:'Chờ duyệt tin nhắn',send_queued:'Chờ gửi',sending:'Đang gửi',completed:'Hoàn tất',cancelled:'Đã dừng',interrupted:'Bị gián đoạn',needs_attention:'Cần xử lý',skipped:'Đã bỏ qua',pending:'Chờ đánh giá',checking:'Đang đánh giá',qualified:'Đạt',review:'Cần kiểm tra',duplicate:'Đã liên hệ',sent:'Đã gửi',unconfirmed:'Chưa xác nhận gửi',done:'Hoàn tất',draft:'Bản cũ',failed:'Lỗi' };
  const defaultTemplate = $('template').value;
  Object.assign(labels, {uid_queued:'Chờ tìm UID',resolving_uid:'Đang tìm UID'});
  let selected = null, epoch = 0, timer = null, busy = false, uncertain = false, retries = 0;
  let picks = new Set(), accounts = [], campaigns = [];
  const show = (id, visible) => { $(id).hidden = !visible; };
  let viewedStep = 1;
  function viewStep(n) {
    viewedStep = n;
    for (let i=1;i<=3;i++) {
      show(`step${i}`,i===n);
      $(`nav${i}`).classList.toggle('viewing',i===n);
      $(`nav${i}`).setAttribute('aria-expanded',String(i===n));
    }
  }
  for(let n=1;n<=3;n++) {
    $(`nav${n}`).setAttribute('aria-controls',`step${n}`);
    $(`nav${n}`).onclick=e=>{e.preventDefault();viewStep(n);};
  }
  viewStep(1);
  const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  function renderAssessment(v) {
    const type = {personal:'Profile cá nhân',page:'Fanpage',group:'Group'}[v.type] || 'Chưa rõ loại';
    const seller = {yes:'Có',no:'Không'}[v.sellerUS] || 'Chưa rõ';
    const confidence = Number.isFinite(v.confidence) ? Math.round(v.confidence * 100) + '%' : 'Chưa đủ dữ liệu';
    const sections = [
      ['Đánh giá chung', type + ' - Bán sản phẩm có trên website Mỹ - ' + seller + ' - ' + confidence],
      ['Tên Facebook', v.name || 'Chưa đọc được tên Facebook'],
      ['Bio ở profile', v.bio || 'Chưa có dữ liệu bio'],
      ['Các thương hiệu có trên bài viết bán hàng', Array.isArray(v.brands) && v.brands.length ? v.brands.join(', ') : 'Chưa xác định được thương hiệu'],
      ['Phân tích cụ thể caption', v.captionAnalysis || v.reason || 'Chưa có phân tích caption'],
    ];
    const list = element('ol', undefined, 'assessment-sections');
    for (const [label, value] of sections) {
      const item = element('li');
      item.append(element('strong', label + ': '), element('span', value));
      list.append(item);
    }
    return list;
  }
  function renderAssessmentPreview(v) {
    const preview = element('div');
    const seller = {yes:'Có',no:'Không'}[v.sellerUS] || 'Chưa đủ dữ liệu';
    preview.append(element('p', 'Seller bán sản phẩm trên website Mỹ: ' + seller, 'seller-verdict'));
    const details = element('details', undefined, 'assessment-details');
    const summary = element('summary');
    summary.append(element('span', 'Xem chi tiết', 'expand-label'), element('span', 'Thu gọn', 'collapse-label'));
    details.append(summary, renderAssessment(v));
    preview.append(details);
    return preview;
  }
  function renderScanLog(lead) {
    const log = element('div', undefined, 'scan-log');
    const entries = lead.scanLog || [], latest = entries.at(-1);
    if (!latest) return log;
    log.append(element('p', `${Math.round(latest.elapsedMs / 1000)}s · ${latest.message}`, 'muted'));
    const details = element('details');
    details.open = openScanLogs.has(lead.id);
    details.ontoggle = () => { if (details.open) openScanLogs.add(lead.id); else openScanLogs.delete(lead.id); };
    details.append(element('summary', `Nhật ký quét (${entries.length})`));
    const list = element('ol');
    for (const entry of entries) list.append(element('li', `${Math.round(entry.elapsedMs / 1000)}s · ${entry.message}`));
    details.append(list); log.append(details);
    return log;
  }
  const openScanLogs = new Set();
  function selectionExplanation(l) {
    const v = l.assessment;
    if (!v?.eligible && ['page','group'].includes(v?.type)) return v.type === 'page'
      ? 'Không thể chọn: đây là Fanpage. Chiến dịch hiện chỉ cho chọn profile cá nhân, dù AI xác định có bán sản phẩm trên website Mỹ.'
      : 'Không thể chọn: đây là Group. Chiến dịch hiện chỉ cho chọn profile cá nhân.';
    return l.selectionBlockedReason || l.blockedReason || v?.gateReason || 'Hồ sơ chưa đủ điều kiện để chọn.';
  }
  const urlsFrom = text => text.match(/https?:\/\/[^\s,"'<>]+/gi) || [];
  const canPick = l => l.state !== 'skipped' && l.assessment?.criteriaVersion === 'us-website-products-v2' && !(l.selectionBlockedReason ?? l.blockedReason);
  const canRetry = c => c?.workflowVersion === 2 && c.approvals?.import && c.leads.some(l => l.state !== 'skipped') && !c.approvals.send && ['analysis_review','message_review','interrupted','needs_attention'].includes(c.state);
  const accountName = key => accounts.find(a => a.key === key)?.name || key;
  function notice(message = '', error = false) { $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); show('notice', !!message); }
  async function api(url, method = 'GET', body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(BASE_URL + url, { method, signal: controller.signal, headers: { 'Content-Type':'application/json' }, ...(body !== undefined ? { body:JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) { const e = new Error(data?.error || `Không tải được dữ liệu (HTTP ${response.status})`); e.status = response.status; throw e; }
      return data;
    } finally { clearTimeout(timeout); }
  }
  function badge(text, style = '') { return element('span', text, `badge ${style}`); }
  function stats(id, values) { $(id).replaceChildren(...values.map(([label, count, cls]) => { const s = element('div',undefined,`stat ${cls || ''}`);s.append(element('strong',String(count)),element('span',label));return s;})); }
  function link(url, name) { const a = element('a',name || url); a.href=url; a.target='_blank';a.rel='noopener noreferrer';return a; }
  function customerLabel(value) {
    try {
      const url = new URL(value);
      return url.pathname === '/profile.php' ? url.searchParams.get('id') || 'profile.php' : url.pathname.replace(/^\/+|\/+$/g, '') || value;
    } catch { return value; }
  }
  function approvalText(a, fallback) { return a ? `Đã duyệt lúc ${new Date(a.at).toLocaleString('vi-VN')}` : fallback; }
  function sendCategory(lead) {
    if (lead.state === 'sent') return 'sent';
    if (lead.state === 'duplicate') return 'duplicate';
    if (['unconfirmed','review','failed'].includes(lead.state) || lead.error) return 'attention';
    return 'pending';
  }
  function cleanDiagnostic(value) {
    return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  }
  function sendIssue(lead) {
    const raw = cleanDiagnostic(lead.error);
    if (lead.state === 'unconfirmed') return 'Chưa xác nhận được tin đã gửi. Mở Messenger kiểm tra trước khi thực hiện thêm thao tác.';
    if (/timeout|locator\.waitFor/i.test(raw)) return 'Không mở được ô soạn tin trong thời gian chờ. Kiểm tra hội thoại và trạng thái đăng nhập Facebook.';
    if (/checkpoint|đăng nhập|login|challenge/i.test(raw)) return 'Tài khoản cần đăng nhập hoặc xác minh. Hãy xử lý trong Quản lý tài khoản.';
    if (/hội thoại khác|người nhận|recipient|UID/i.test(raw)) return 'Chưa xác minh được đúng người nhận. Kiểm tra lại hồ sơ và UID trước khi gửi.';
    if (/closed|đã đóng|disconnected/i.test(raw)) return 'Kết nối trình duyệt đã đóng. Kiểm tra tài khoản Facebook và hội thoại.';
    return 'Lượt gửi đã dừng ở khách này. Mở Messenger để kiểm tra; thông tin kỹ thuật nằm bên dưới.';
  }
  const openSendDetails = new Set();
  function renderSendRows(c) {
    const approved = c.approvals?.analysis?.leadIds || [];
    const leads = c.leads.filter(l => approved.includes(l.id));
    const query = $('sendSearch').value.trim().toLocaleLowerCase('vi'), filter = $('sendFilter').value;
    const matches = leads.filter(l => (filter === 'all' || sendCategory(l) === filter)
      && [l.assessment?.name,l.url,l.assessment?.recipientId].join(' ').toLocaleLowerCase('vi').includes(query));
    $('sendListCount').textContent = `Hiển thị ${matches.length}/${leads.length} khách`;
    $('sendRows').replaceChildren(...matches.map(l => {
      const category = sendCategory(l), row = element('article',undefined,`send-row send-${category}`);
      const info = element('div',undefined,'send-customer'), name = l.assessment?.name || customerLabel(l.url);
      const avatar = element('span',name.trim().slice(0,1).toUpperCase(),'send-avatar'); avatar.setAttribute('aria-hidden','true');
      const heading = element('div',undefined,'send-row-heading'), identity = element('div',undefined,'send-identity');
      identity.append(link(l.url,name),element('small',l.assessment?.recipientId ? `UID ${l.assessment.recipientId}` : customerLabel(l.url)));
      heading.append(avatar,identity);
      const state = l.state === 'unconfirmed' ? 'Chưa xác nhận' : category === 'attention' ? 'Cần kiểm tra' : category === 'duplicate' ? 'Đã liên hệ trước' : l.state === 'sending' ? 'Đang gửi' : category === 'sent' ? 'Đã gửi' : c.cancelled || c.state === 'needs_attention' ? 'Chưa gửi' : 'Chờ gửi';
      heading.append(badge(state,category === 'attention' ? 'warn' : category === 'sent' ? 'good' : ''));
      info.append(heading);
      if (category === 'attention') info.append(element('p',sendIssue(l),'send-explanation'));
      if (category === 'duplicate') info.append(element('p','Đã có lần liên hệ trước; lượt này không gửi lại.','send-explanation'));
      const actions = element('div',undefined,'send-row-actions');
      if (/^\d+$/.test(l.assessment?.recipientId || '')) actions.append(link(`https://www.facebook.com/messages/t/${l.assessment.recipientId}`,'Mở Messenger ↗'));
      actions.append(link(l.url,'Xem hồ sơ ↗')); info.append(actions);
      if (l.error) {
        const details = element('details',undefined,'send-diagnostic');
        const key = `${c.id}:${l.id}`;
        details.open = openSendDetails.has(key);
        details.ontoggle = () => { if (!details.isConnected) return; if(details.open)openSendDetails.add(key);else openSendDetails.delete(key); };
        details.append(element('summary','Chi tiết kỹ thuật'),element('pre',cleanDiagnostic(l.error)));
        info.append(details);
      }
      row.append(info); return row;
    }));
    if (!matches.length) $('sendRows').append(element('p','Không có khách phù hợp với bộ lọc.','send-empty'));
  }
  function renderSendSummary(c, leads) {
    const active = ['send_queued','sending'].includes(c.state), attention = leads.filter(l=>sendCategory(l)==='attention').length;
    const sent = leads.filter(l=>l.state==='sent').length, pending = leads.filter(l=>sendCategory(l)==='pending').length;
    const title = active ? c.cancelled ? 'Đang dừng gửi' : 'Đang gửi tin nhắn' : c.state==='needs_attention' || attention ? 'Lượt gửi cần kiểm tra' : c.cancelled || c.state==='cancelled' ? 'Đã dừng theo yêu cầu' : 'Đã kết thúc lượt gửi';
    $('sendSummary').className = 'send-summary' + (!active && (attention || c.state==='needs_attention') ? ' needs-attention' : !active && sent===leads.length && sent ? ' complete' : '');
    $('sendSummaryTitle').textContent = title;
    show('sendCampaignDiagnostic',!!c.error && !leads.some(l=>cleanDiagnostic(l.error)===cleanDiagnostic(c.error)));
    $('sendCampaignError').textContent = cleanDiagnostic(c.error);
    $('sendSummaryText').textContent = active ? 'Trạng thái tự cập nhật. Bạn có thể dừng các tin tiếp theo.' : attention ? `${attention} khách cần kiểm tra. ${pending ? `${pending} khách chưa được gửi. ` : ''}Xem hướng dẫn tại từng khách bên dưới.` : c.error ? 'Không thể hoàn tất lượt gửi. Kiểm tra tài khoản Facebook và trạng thái các khách bên dưới.' : `${sent}/${leads.length} tin được xác nhận đã gửi.${pending ? ` Còn ${pending} khách chưa gửi.` : ''}`;
    stats('sendStats',[['Đã gửi',sent,'good'],[active?'Chờ / đang gửi':'Chưa gửi',pending],['Cần kiểm tra',attention,attention?'warn':''],['Tổng đã duyệt',leads.length]]);
    $('sendNote').textContent = 'Tin chưa xác nhận không được tự gửi lại. Nội dung đã duyệt được lưu bên dưới.';
    renderSendRows(c);
  }
  function updateControls() {
    const c = selected, unlocked = !busy && !uncertain, modern = c?.workflowVersion === 2;
    for (const id of ['campaignName','profile','urls','file']) $(id).disabled = !!c || busy;
    $('importButton').disabled = !!c || busy || !accounts.length;
    $('newCampaign').disabled = busy;
    $('refresh').disabled = !c || busy;
    $('retryAnalysis').disabled = !unlocked || !canRetry(c);
    $('resolveUids').disabled = !unlocked || !modern || !['analysis_review','message_review'].includes(c.state) || !!c.approvals.send;
    $('approveImport').disabled = !unlocked || !modern || c.state !== 'import_review' || !c.leads.length;
    $('selectAll').disabled = !unlocked || !modern || c.state !== 'analysis_review';
    const eligible = c?.leads.filter(l => canPick(l) && matchesAnalysis(l)) || [];
    $('selectAll').checked = eligible.length > 0 && eligible.every(l => picks.has(l.id));
    $('selectAll').indeterminate = c?.state === 'analysis_review' && eligible.some(l => picks.has(l.id)) && !$('selectAll').checked;
    $('selectAll').disabled ||= !eligible.length;
    $('selectionCount').textContent = `${picks.size} khách được chọn`;
    $('approveAnalysis').textContent = `Duyệt ${picks.size} khách & sang bước 3 →`;
    $('approveAnalysis').disabled = !unlocked || !modern || c.state !== 'analysis_review' || !picks.size;
    for (const box of $('analysisRows').querySelectorAll('input')) box.disabled = !unlocked || !modern || c.state !== 'analysis_review' || !eligible.some(l => l.id === box.value);
    for (const button of $('analysisRows').querySelectorAll('button')) button.disabled = !unlocked || !modern || c.state !== 'analysis_review';
    const editing = modern && c.state === 'message_review';
    $('template').disabled = !editing || !unlocked;
    $('prepareMessages').disabled = !editing || !unlocked || !$('template').value.trim();
    $('reviewSelection').disabled = !editing || !unlocked;
    const fresh = editing && c.messagePreview && $('template').value.trim() === c.template;
    $('confirmSend').disabled = !fresh || !unlocked;
    $('sendButton').disabled = !fresh || !unlocked || !$('confirmSend').checked;
    $('sendButton').textContent = `Duyệt & gửi ${c?.messagePreview?.messages.length || 0} tin nhắn`;
    for (const id of ['stopAnalysis','stopSending']) $(id).disabled = !unlocked || !!c?.cancelled;
    $('messageLength').textContent = `${$('template').value.length}/2000`;
    if (editing) $('previewHint').textContent = !c.messagePreview ? 'Tạo bản xem trước để kiểm tra từng người nhận và tin nhắn.' : fresh ? 'Đây là nội dung sẽ được gửi. Duyệt bên dưới để bắt đầu.' : 'Nội dung đã thay đổi. Hãy tạo lại bản xem trước trước khi duyệt gửi.';
    if (editing) {
      const blocked = c.leads.filter(l => c.approvals.analysis?.leadIds.includes(l.id) && l.blockedReason);
      if (blocked.length) {
        $('previewHint').textContent = blocked.map(l => `${customerLabel(l.url)}: ${l.blockedReason}`).join(' · ');
        $('prepareMessages').disabled = true;
        $('confirmSend').disabled = true;
        $('sendButton').disabled = true;
      }
    }
    else if (c?.approvals?.send) $('previewHint').textContent = 'Nội dung đã duyệt gửi được lưu cố định bên dưới.';
    for (const button of $('campaigns').querySelectorAll('button')) button.disabled = busy || (button.dataset.deleteState && ACTIVE.concat(['running','queued']).includes(button.dataset.deleteState));
  }
  function setPageView(view) {
    if (!['workflow', 'history', 'customers'].includes(view)) return;
    show('workflowSteps', view === 'workflow');
    show('campaignWorkspace', view === 'workflow');
    show('campaignHistory', view === 'history');
    show('customerLibrary', view === 'customers');
    $('toggleHistory').setAttribute('aria-expanded', String(view === 'history'));
    $('toggleCustomers').setAttribute('aria-expanded', String(view === 'customers'));
  }
  document.addEventListener('ctv:view', event => setPageView(event.detail));
  function setHistoryOpen(open) { setPageView(open ? 'history' : 'workflow'); }
  function renderHistory() {
    $('campaigns').replaceChildren();
    for (const c of [...campaigns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))) {
      const b = element('button', c.name || 'Chiến dịch gửi tin nhắn hàng loạt', c.id === selected?.id ? 'active' : '');
      b.append(element('small',`${new Date(c.createdAt).toLocaleDateString('vi-VN')} · ${c.leads.length} khách · ${labels[c.state] || c.state}`));
      b.disabled = busy; b.onclick = () => choose(c.id);
      const row = element('div', undefined, 'campaign-row'), remove = element('button','Xoá','secondary');
      remove.dataset.deleteState = c.state;
      remove.setAttribute('aria-label', `Xoá chiến dịch ${c.name}`);
      remove.disabled = busy || ACTIVE.concat(['running','queued']).includes(c.state);
      remove.onclick = () => deleteCampaign(c);
      row.append(b, remove); $('campaigns').append(row);
    }
    if (!campaigns.length) $('campaigns').append(element('p','Chưa có chiến dịch.','muted'));
  }
  function render(c, reset = false) {
    if (reset || selected?.id !== c.id) { $('analysisSearch').value=''; $('analysisFilter').value='all'; }
    if (selected?.id !== c.id || selected?.messagePreview?.token !== c.messagePreview?.token) $('confirmSend').checked = false;
    selected = c;
    if (reset) { picks = new Set(c.approvals?.analysis?.leadIds || []); $('template').value = c.template || defaultTemplate; $('confirmSend').checked = false; $('sendSearch').value='';$('sendFilter').value='all';$('sendCampaignDiagnostic').open=false; }
    if (c.state === 'analysis_review') picks = new Set([...picks].filter(id => c.leads.some(l => l.id === id && canPick(l))));
    else picks = new Set(c.approvals?.analysis?.leadIds || []);
    campaigns = [...campaigns.filter(x => x.id !== c.id), c]; renderHistory();
    $('currentName').textContent = c.name || 'Chiến dịch gửi tin nhắn hàng loạt'; $('currentProfile').textContent = `Tài khoản: ${accountName(c.profile)}`;
    $('currentState').textContent = labels[c.state] || c.state;
    const a = c.approvals || {}, modern = c.workflowVersion === 2;
    if (!modern) notice('Chiến dịch phiên bản cũ chỉ được xem. Tạo chiến dịch mới để dùng quy trình 3 bước có duyệt.',true);
    show('importForm',false);show('importResult',true);
    stats('importStats',[['Link hợp lệ',c.leads.length,'good'],['Link trùng đã gộp',c.duplicateCount || 0],['Link bị loại',c.rejected?.length || 0,'warn']]);
    $('importContext').textContent = `${c.name || 'Chiến dịch gửi tin nhắn hàng loạt'} · ${accountName(c.profile)} · Danh sách đã lưu cố định cho chiến dịch này.`;
    $('importList').replaceChildren(...c.leads.map(l => { const li=element('li');li.append(link(l.url,customerLabel(l.url)));return li;}));
    $('rejectedList').replaceChildren(...(c.rejected || []).map(r => element('p',`${r.value} — ${r.reason}`,'warning')));
    if (reset) $('importDetails').open = c.state === 'import_review';
    $('importApproval').textContent = approvalText(a.import,'Chỉ các link hợp lệ bên trên sẽ được chuyển sang AI.');
    show('approveImport',modern && c.state === 'import_review');
    $('status1').textContent = a.import ? 'Đã duyệt' : 'Chờ duyệt'; $('status1').className = 'badge ' + (a.import ? 'good' : 'warn');
    const hasAnalysis = !!a.import || !modern;
    show('analysisEmpty',!hasAnalysis);show('analysisResult',hasAnalysis);
    const analyzing = ['analysis_queued','analyzing','uid_queued','resolving_uid'].includes(c.state);
    $('status2').textContent = a.analysis ? 'Đã duyệt' : analyzing ? 'Đang đánh giá' : hasAnalysis ? 'Chờ duyệt' : 'Đang khóa';
    $('status2').className = 'badge ' + (a.analysis ? 'good' : analyzing ? 'blue' : hasAnalysis ? 'warn' : '');
    const checked = c.leads.filter(l => l.assessment || l.error).length;
    $('analysisProgress').textContent = `${checked}/${c.leads.length} hồ sơ đã xử lý${c.cancelled && c.state === 'analysis_review' ? ' · Đã dừng theo yêu cầu' : ''}`;
    $('analysisBar').max = c.leads.length || 1; $('analysisBar').value = checked;
    stats('analysisStats',[['AI đánh giá đạt',c.leads.filter(l=>l.assessment?.eligible).length,'good'],['Có thể chọn soạn tin',c.leads.filter(canPick).length],['Cần kiểm tra',c.leads.filter(l=>l.state==='review').length,'warn'],['Đã bỏ qua',c.leads.filter(l=>l.state==='skipped').length]]);
    show('analysisWarning',!!c.error && !a.analysis);$('analysisWarning').textContent = c.error || '';
    show('retryAnalysis',!!canRetry(c));
    show('resolveUids',modern && !a.send && ['analysis_review','message_review'].includes(c.state) && c.leads.some(l=>l.state!=='skipped' && l.assessment && !l.assessment.recipientId));
    if (['uid_queued','resolving_uid'].includes(c.state)) $('analysisProgress').textContent = `${labels[c.state]} · ${c.leads.filter(l=>l.uidLookup?.state==='resolved').length} hồ sơ đã tìm được UID`;
    show('stopAnalysis',analyzing);show('approveAnalysis',modern && c.state === 'analysis_review');
    $('analysisApproval').textContent = approvalText(a.analysis,'Bạn có thể duyệt gửi khách đã chọn dù AI chưa đánh giá đạt. Cần xác minh người nhận trước khi gửi.');
    $('analysisRows').replaceChildren();
    for (const [index, l] of c.leads.entries()) {
      const row = element('tr'), chooseCell = element('td'), customer = element('td'), uidCell = element('td'), fbName = element('td'), analysis = element('td'), result = element('td');
      row.dataset.leadId = l.id;
      const ordinal = element('td', String(index + 1), 'row-number');
      ordinal.dataset.label = 'STT';
      customer.className = 'customer-cell';
      const cb=element('input');cb.type='checkbox';cb.value=l.id;cb.checked=picks.has(l.id);cb.setAttribute('aria-label',`Chọn ${customerLabel(l.url)}`);
      cb.onchange=()=>{if(cb.checked)picks.add(l.id);else picks.delete(l.id);updateControls();};chooseCell.append(cb);
      customer.append(link(l.url,customerLabel(l.url))); customer.dataset.label='Khách hàng';
      analysis.dataset.label='AI đánh giá'; result.dataset.label='Kết quả';
      const v=l.assessment;
      uidCell.dataset.label = 'UID';
      uidCell.className = 'uid-cell';
      uidCell.append(element('span', v?.recipientId || 'Chưa xác định', 'uid-value'));
      fbName.dataset.label = 'Tên FB';
      fbName.className = 'fb-name';
      fbName.textContent = v?.name || (l.state === 'checking' ? 'Đang quét…' : v || l.error ? 'Chưa đọc được tên' : 'Chưa quét');
      if (v) {
        const reason = l.uidLookup?.reason || v.uidReason;
        if (!v.recipientId && reason) uidCell.append(element('p',reason,'muted'));
        if (modern && c.state === 'analysis_review' && !a.send && l.state !== 'skipped') {
          const findUid = element('button',v.recipientId ? 'Kiểm tra lại UID' : 'Tìm UID','secondary');
          findUid.onclick=()=>action('resolve-uids',{leadId:l.id});
          uidCell.append(findUid);
        }
      }
      if(v) analysis.append(renderAssessmentPreview(v));
      else analysis.append(element('p',l.error || 'Chưa có kết quả','muted'));
      analysis.append(renderScanLog(l));
      if(v && !canPick(l)) {
        const reason = selectionExplanation(l);
        const note = element('p', reason, 'selection-explanation');
        note.id = 'selection-reason-' + l.id;
        cb.setAttribute('aria-describedby', note.id);
        chooseCell.title = reason;
        analysis.append(note);
      }
      result.append(badge(l.state === 'qualified' && l.blockedReason ? 'AI đạt · Chưa sẵn sàng gửi' : labels[l.state] || l.state,canPick(l)?'good':l.state==='review'?'warn':''));
      if(canPick(l) && l.blockedReason && !a.send)result.append(element('p',l.blockedReason,'muted'));
      if(modern && c.state === 'analysis_review' && ['review','qualified'].includes(l.state) && (l.blockedReason || !v?.eligible)) {
        const skip = element('button','Bỏ qua','secondary');
        skip.setAttribute('aria-label',`Bỏ qua ${v?.name || l.url}`);
        skip.onclick=()=>action('skip-lead',{leadId:l.id});
        result.append(skip);
      }
      row.append(chooseCell,ordinal,customer,uidCell,fbName,analysis,result);$('analysisRows').append(row);
    }
    applyAnalysisFilters();
    const hasMessages=!!a.analysis;
    show('messageEmpty',!hasMessages);show('messageResult',hasMessages);
    $('status3').textContent=a.send?(labels[c.state] || c.state):hasMessages?'Chờ duyệt gửi':'Đang khóa';
    $('status3').className='badge '+(c.state==='needs_attention'?'warn':c.state==='completed'?'good':hasMessages?'blue':'');
    $('recipientSummary').textContent=`${a.analysis?.leadIds.length || 0} khách đã duyệt · Gửi từ ${accountName(c.profile)}`;
    show('reviewSelection',c.state==='message_review');show('prepareMessages',c.state==='message_review');
    show('messageComposer',!a.send);
    $('messageStageHint').textContent = a.send ? 'Theo dõi trạng thái và kiểm tra kết quả từng khách.' : 'Xem từng tin nhắn trước khi duyệt gửi.';
    show('messageArchive',!!c.messagePreview?.messages.length);
    const archiveMode = a.send ? 'sent' : 'preview';
    if (reset || $('messageArchive').dataset.mode !== archiveMode) $('messageArchive').open = !a.send;
    $('messageArchive').dataset.mode = archiveMode;
    $('messageArchiveTitle').textContent = `${a.send?'Nội dung đã duyệt':'Xem trước tin nhắn'} (${c.messagePreview?.messages.length || 0})`;
    $('messagePreviews').replaceChildren(...(c.messagePreview?.messages || []).map(m=>{const d=element('article',undefined,'message-card');d.append(element('h3',m.name || customerLabel(m.url)),link(m.url,customerLabel(m.url)),element('p',m.message));return d;}));
    show('sendApproval',c.state==='message_review' && !!c.messagePreview);
    show('sendResult',!!a.send);show('stopSending',['send_queued','sending'].includes(c.state));
    const sentLeads=c.leads.filter(l=>a.analysis?.leadIds.includes(l.id));
    if (a.send) renderSendSummary(c,sentLeads);
    for(let n=1;n<=3;n++){$(`nav${n}`).className='step-link';$(`nav${n}`).removeAttribute('aria-current');}
    const step=a.analysis?3:a.import?2:1;$(`nav${step}`).classList.add('active');$(`nav${step}`).setAttribute('aria-current','step');
    for(let n=1;n<step;n++)$(`nav${n}`).classList.add('done');
    $('navStatus1').textContent=a.import?'Đã duyệt danh sách':'Chờ bạn duyệt';
    $('navStatus2').textContent=a.analysis?'Đã duyệt kết quả':analyzing?'Đang đánh giá':hasAnalysis?'Chờ bạn duyệt':'Chờ duyệt bước 1';
    $('navStatus3').textContent=a.send?(labels[c.state] || c.state):hasMessages?'Soạn & duyệt tin nhắn':'Chờ duyệt bước 2';
    viewStep(reset ? step : viewedStep);
    updateControls(); schedule();
  }
  function schedule() {
    clearTimeout(timer);if(!selected || busy || (!ACTIVE.includes(selected.state) && !uncertain))return;
    const id=selected.id,version=epoch;
    timer=setTimeout(()=>sync(id,version),Math.min(15000,2500 * (1 + retries)));
  }
  async function sync(id=selected?.id,version=epoch) {
    if(!id)return;
    try{const c=await api(`/api/ctv/campaigns/${id}`);if(epoch!==version || selected?.id!==id)return;uncertain=false;retries=0;$('connection').textContent='Đã cập nhật '+new Date().toLocaleTimeString('vi-VN');render(c);}
    catch(e){if(epoch!==version || selected?.id!==id)return;uncertain=true;retries++;$('connection').textContent='Mất kết nối. Đang tự thử tải lại trạng thái…';notice(e.message,true);updateControls();schedule();}
  }
  async function choose(id) {
    if(busy)return;clearTimeout(timer);const version=++epoch;busy=true;updateControls();
    try{const c=await api(`/api/ctv/campaigns/${id}`);if(epoch!==version)return;uncertain=false;notice();render(c,true);setHistoryOpen(false);$('toggleHistory').focus();}
    catch(e){notice(e.message,true);}finally{busy=false;updateControls();schedule();}
  }
  async function deleteCampaign(c) {
    if (busy || !window.confirm(`Xoá chiến dịch “${c.name}”? Không thể khôi phục. Dữ liệu khách hàng và lịch sử chống gửi trùng vẫn được giữ.`)) return;
    busy=true; clearTimeout(timer); updateControls(); notice();
    try {
      await api(`/api/ctv/campaigns/${c.id}/delete`, 'POST', {});
      campaigns=campaigns.filter(item=>item.id!==c.id);
      busy=false;
      if(selected?.id===c.id) $('newCampaign').onclick();
      else renderHistory();
      notice('Đã xoá chiến dịch.');
    } catch(e) { notice(e.message,true); }
    finally { busy=false; updateControls(); schedule(); }
  }
  async function action(name,body={}) {
    if(!selected || busy || uncertain)return;
    const id=selected.id,version=epoch;busy=true;clearTimeout(timer);updateControls();notice();
    try{const c=await api(`/api/ctv/campaigns/${id}/${name}`,'POST',body);if(epoch!==version)return;uncertain=false;$('confirmSend').checked=false;render(c);if(name==='approve-import'||name==='review-analysis'||name==='retry-analysis'||name==='resolve-uids')viewStep(2);if(name==='approve-analysis')viewStep(3);}
    catch(e){if(epoch!==version)return;notice(e.message,true);uncertain=true;await sync(id,version);}
    finally{busy=false;updateControls();schedule();}
  }
  $('urls').oninput=()=>{$('count').textContent=`${urlsFrom($('urls').value).length} link tìm thấy`;};
  $('file').onchange=async()=>{try{const f=$('file').files[0];if(!f)return;if(f.size>1000000)throw new Error('File vượt quá 1 MB');$('urls').value=await f.text();$('fileName').textContent=f.name;$('urls').oninput();}catch(e){notice(e.message,true);}};
  $('importButton').onclick=async()=>{
    if(busy)return;const urls=urlsFrom($('urls').value);
    if(!$('profile').value || !urls.length || urls.length>100){notice('Chọn tài khoản và nhập từ 1 đến 100 link http/https để kiểm tra.',true);return;}
    busy=true;updateControls();notice();
    try{const c=await api('/api/ctv/campaigns','POST',{name:$('campaignName').value,profile:$('profile').value,urls});epoch++;uncertain=false;render(c,true);}
    catch(e){notice(e.message,true);}finally{busy=false;updateControls();schedule();}
  };
  $('retryAnalysis').onclick=()=>{if(canRetry(selected) && window.confirm('Đọc lại các profile chưa bỏ qua và đánh giá lại bằng AI? Kết quả cũ và bản duyệt tin nhắn sẽ được bỏ; bạn cần duyệt lại trước khi gửi.')){picks.clear();action('retry-analysis');}};
  $('approveImport').onclick=()=>action('approve-import');
  $('resolveUids').onclick=()=>action('resolve-uids');
  $('selectAll').onchange=()=>{for(const l of selected.leads.filter(l=>canPick(l)&&matchesAnalysis(l))){if($('selectAll').checked)picks.add(l.id);else picks.delete(l.id);}for(const box of $('analysisRows').querySelectorAll('input'))box.checked=picks.has(box.value);updateControls();};
  const searchText = value => String(value || '').normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
  function matchesAnalysis(lead) {
    const filter=$('analysisFilter').value;
    const category=lead.state==='skipped'?'skipped':lead.assessment?.eligible?'qualified':lead.assessment||lead.error?'review':'pending';
    return (filter==='all'||filter===category) && searchText([lead.assessment?.name,lead.url,lead.assessment?.recipientId].join(' ')).includes(searchText($('analysisSearch').value.trim()));
  }
  function applyAnalysisFilters() {
    if(!selected)return;
    const visible=new Set(selected.leads.filter(matchesAnalysis).map(l=>l.id));
    for(const row of $('analysisRows').children) row.hidden=!visible.has(row.dataset.leadId);
    $('analysisFilterCount').textContent=`Hiển thị ${visible.size}/${selected.leads.length} khách`;
    show('analysisFilterEmpty',visible.size===0);
  }
  $('analysisSearch').oninput=$('analysisFilter').onchange=()=>{applyAnalysisFilters();updateControls();};
  $('approveAnalysis').onclick=()=>action('approve-analysis',{leadIds:[...picks]});
  $('reviewSelection').onclick=()=>action('review-analysis');
  $('template').oninput=()=>{$('confirmSend').checked=false;updateControls();};
  $('prepareMessages').onclick=()=>action('prepare-messages',{template:$('template').value});
  $('confirmSend').onchange=updateControls;
  $('sendButton').onclick=()=>{if(!$('sendButton').disabled)action('send',{previewToken:selected.messagePreview.token});};
  $('stopAnalysis').onclick=$('stopSending').onclick=()=>action('stop');
  $('refresh').onclick=()=>sync();
  $('sendSearch').oninput=$('sendFilter').onchange=()=>{if(selected)renderSendRows(selected);};
  $('toggleHistory').onclick=()=>setHistoryOpen($('campaignHistory').hidden);
  $('closeHistory').onclick=()=>{setHistoryOpen(false);$('toggleHistory').focus();};
  $('newCampaign').onclick=()=>{if(busy)return;setHistoryOpen(false);epoch++;clearTimeout(timer);selected=null;uncertain=false;picks.clear();notice();viewStep(1);
    show('importForm',true);show('importResult',false);show('analysisEmpty',true);show('analysisResult',false);show('retryAnalysis',false);show('resolveUids',false);show('messageEmpty',true);show('messageResult',false);
    $('campaignName').value='';$('urls').value='';$('file').value='';$('fileName').textContent='Hoặc dán dữ liệu vào ô phía trên';$('urls').oninput();$('template').value=defaultTemplate;$('confirmSend').checked=false;
    $('currentName').textContent='Chưa có chiến dịch';$('currentProfile').textContent='Chọn tài khoản ở bước 1.';$('currentState').textContent='Chờ nhập dữ liệu';$('connection').textContent='';
    for(let n=1;n<=3;n++){$(`status${n}`).textContent=n===1?'Chưa nhập':'Đang khóa';$(`status${n}`).className='badge';$(`nav${n}`).className='step-link'+(n===1?' active':'');$(`nav${n}`).removeAttribute('aria-current');}
    $('nav1').setAttribute('aria-current','step');$('navStatus1').textContent='Chờ nhập dữ liệu';$('navStatus2').textContent='Chờ duyệt bước 1';$('navStatus3').textContent='Chờ duyệt bước 2';renderHistory();updateControls();viewStep(1);$('step1').scrollIntoView({behavior:'smooth'});
  };
  (async()=>{
    const results=await Promise.allSettled([api('/api/accounts'),api('/api/ctv/campaigns')]);
    if(results[0].status==='fulfilled'){
      const data=results[0].value;accounts=data.facebook || [];$('profile').replaceChildren(element('option',accounts.length?'Chọn Facebook cá nhân':'Chưa có tài khoản Facebook'));$('profile').firstChild.value='';
      for(const a of accounts){const option=element('option',a.name || a.key);option.value=a.key;$('profile').append(option);}show('demoBanner',data.demo===true);
    }else notice('Không tải được tài khoản. '+results[0].reason.message,true);
    if(results[1].status==='fulfilled'){campaigns=results[1].value;renderHistory();}else{$('campaigns').textContent='Chưa tải được lịch sử. Hãy tải lại trang.';notice(results[1].reason.message,true);}
    updateControls();
  })();
})();
