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
  const ACTIVE = ['analysis_queued','analyzing','send_queued','sending'];
  const labels = { import_review:'Chờ duyệt danh sách',analysis_queued:'Chờ chạy AI',analyzing:'AI đang đánh giá',analysis_review:'Chờ duyệt kết quả AI',message_review:'Chờ duyệt tin nhắn',send_queued:'Chờ gửi',sending:'Đang gửi',completed:'Hoàn tất',cancelled:'Đã dừng',interrupted:'Bị gián đoạn',needs_attention:'Cần xử lý',pending:'Chờ đánh giá',checking:'Đang đánh giá',qualified:'Đạt',review:'Cần kiểm tra',duplicate:'Đã liên hệ',sent:'Đã gửi',unconfirmed:'Chưa xác nhận gửi',done:'Hoàn tất',draft:'Bản cũ',failed:'Lỗi' };
  const defaultTemplate = $('template').value;
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
  const urlsFrom = text => text.match(/https?:\/\/[^\s,"'<>]+/gi) || [];
  const canPick = l => l.assessment?.eligible && !l.blockedReason;
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
  function approvalText(a, fallback) { return a ? `Đã duyệt lúc ${new Date(a.at).toLocaleString('vi-VN')}` : fallback; }
  function updateControls() {
    const c = selected, unlocked = !busy && !uncertain, modern = c?.workflowVersion === 2;
    for (const id of ['campaignName','profile','urls','file']) $(id).disabled = !!c || busy;
    $('importButton').disabled = !!c || busy || !accounts.length;
    $('newCampaign').disabled = busy;
    $('refresh').disabled = !c || busy;
    $('approveImport').disabled = !unlocked || !modern || c.state !== 'import_review' || !c.leads.length;
    $('selectAll').disabled = !unlocked || !modern || c.state !== 'analysis_review';
    const eligible = c?.leads.filter(canPick) || [];
    $('selectAll').checked = eligible.length > 0 && eligible.every(l => picks.has(l.id));
    $('selectAll').indeterminate = c?.state === 'analysis_review' && picks.size > 0 && !$('selectAll').checked;
    $('selectionCount').textContent = `${picks.size} khách được chọn`;
    $('approveAnalysis').textContent = `Duyệt ${picks.size} khách & sang bước 3 →`;
    $('approveAnalysis').disabled = !unlocked || !modern || c.state !== 'analysis_review' || !picks.size;
    for (const box of $('analysisRows').querySelectorAll('input')) box.disabled = !unlocked || !modern || c.state !== 'analysis_review' || !eligible.some(l => l.id === box.value);
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
    else if (c?.approvals?.send) $('previewHint').textContent = 'Nội dung đã duyệt gửi được lưu cố định bên dưới.';
    for (const button of $('campaigns').querySelectorAll('button')) button.disabled = busy;
  }
  function renderHistory() {
    $('campaigns').replaceChildren();
    for (const c of [...campaigns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))) {
      const b = element('button', c.name || 'Chiến dịch CTV', c.id === selected?.id ? 'active' : '');
      b.append(element('small',`${new Date(c.createdAt).toLocaleDateString('vi-VN')} · ${c.leads.length} khách · ${labels[c.state] || c.state}`));
      b.disabled = busy; b.onclick = () => choose(c.id); $('campaigns').append(b);
    }
    if (!campaigns.length) $('campaigns').append(element('p','Chưa có chiến dịch.','muted'));
  }
  function render(c, reset = false) {
    if (selected?.id !== c.id || selected?.messagePreview?.token !== c.messagePreview?.token) $('confirmSend').checked = false;
    selected = c;
    if (reset) { picks = new Set(c.approvals?.analysis?.leadIds || []); $('template').value = c.template || defaultTemplate; $('confirmSend').checked = false; }
    if (c.state === 'analysis_review') picks = new Set([...picks].filter(id => c.leads.some(l => l.id === id && canPick(l))));
    else picks = new Set(c.approvals?.analysis?.leadIds || []);
    campaigns = [...campaigns.filter(x => x.id !== c.id), c]; renderHistory();
    $('currentName').textContent = c.name || 'Chiến dịch CTV'; $('currentProfile').textContent = `Tài khoản: ${accountName(c.profile)}`;
    $('currentState').textContent = labels[c.state] || c.state;
    const a = c.approvals || {}, modern = c.workflowVersion === 2;
    if (!modern) notice('Chiến dịch phiên bản cũ chỉ được xem. Tạo chiến dịch mới để dùng quy trình 3 bước có duyệt.',true);
    show('importForm',false);show('importResult',true);
    stats('importStats',[['Link hợp lệ',c.leads.length,'good'],['Link trùng đã gộp',c.duplicateCount || 0],['Link bị loại',c.rejected?.length || 0,'warn']]);
    $('importContext').textContent = `${c.name || 'Chiến dịch CTV'} · ${accountName(c.profile)} · Danh sách đã lưu cố định cho chiến dịch này.`;
    $('importList').replaceChildren(...c.leads.map(l => { const li=element('li');li.append(link(l.url));return li;}));
    $('rejectedList').replaceChildren(...(c.rejected || []).map(r => element('p',`${r.value} — ${r.reason}`,'warning')));
    if (reset) $('importDetails').open = c.state === 'import_review';
    $('importApproval').textContent = approvalText(a.import,'Chỉ các link hợp lệ bên trên sẽ được chuyển sang AI.');
    show('approveImport',modern && c.state === 'import_review');
    $('status1').textContent = a.import ? 'Đã duyệt' : 'Chờ duyệt'; $('status1').className = 'badge ' + (a.import ? 'good' : 'warn');
    const hasAnalysis = !!a.import || !modern;
    show('analysisEmpty',!hasAnalysis);show('analysisResult',hasAnalysis);
    const analyzing = ['analysis_queued','analyzing'].includes(c.state);
    $('status2').textContent = a.analysis ? 'Đã duyệt' : analyzing ? 'Đang đánh giá' : hasAnalysis ? 'Chờ duyệt' : 'Đang khóa';
    $('status2').className = 'badge ' + (a.analysis ? 'good' : analyzing ? 'blue' : hasAnalysis ? 'warn' : '');
    const checked = c.leads.filter(l => l.assessment || l.error).length;
    $('analysisProgress').textContent = `${checked}/${c.leads.length} hồ sơ đã xử lý${c.cancelled && c.state === 'analysis_review' ? ' · Đã dừng theo yêu cầu' : ''}`;
    $('analysisBar').max = c.leads.length || 1; $('analysisBar').value = checked;
    stats('analysisStats',[['AI đánh giá đạt',c.leads.filter(l=>l.assessment?.eligible).length,'good'],['Có thể chọn gửi',c.leads.filter(canPick).length],['Cần kiểm tra',c.leads.filter(l=>l.state==='review').length,'warn']]);
    show('analysisWarning',!!c.error && !a.analysis);$('analysisWarning').textContent = c.error || '';
    show('stopAnalysis',analyzing);show('approveAnalysis',modern && c.state === 'analysis_review');
    $('analysisApproval').textContent = approvalText(a.analysis,'Khách chưa đạt hoặc chưa rõ người nhận sẽ không được chuyển sang gửi.');
    $('analysisRows').replaceChildren();
    for (const l of c.leads) {
      const row = element('tr'), chooseCell = element('td'), customer = element('td'), analysis = element('td'), result = element('td');
      const cb=element('input');cb.type='checkbox';cb.value=l.id;cb.checked=picks.has(l.id);cb.setAttribute('aria-label',`Chọn ${l.assessment?.name || l.url}`);
      cb.onchange=()=>{if(cb.checked)picks.add(l.id);else picks.delete(l.id);updateControls();};chooseCell.append(cb);
      customer.append(link(l.url,l.assessment?.name || l.url)); customer.dataset.label='Khách hàng';
      analysis.dataset.label='AI đánh giá'; result.dataset.label='Kết quả';
      const v=l.assessment;
      if(v){analysis.append(element('p',`${v.type==='personal'?'Cá nhân':v.type==='page'?'Fanpage':'Chưa rõ loại'} · Seller US: ${v.sellerUS==='yes'?'Có':v.sellerUS==='no'?'Không':'Chưa rõ'}${typeof v.confidence==='number'?' · '+Math.round(v.confidence*100)+'%':''}`),element('p',v.reason || ''));
        if(v.evidence?.length){const d=element('details');d.append(element('summary',`Xem ${v.evidence.length} bằng chứng`));v.evidence.forEach(q=>d.append(element('blockquote',q)));analysis.append(d);}
        if(v.gateReason&&!v.eligible)analysis.append(element('p',v.gateReason,'muted'));
      }else analysis.append(element('p',l.error || 'Chưa có kết quả','muted'));
      result.append(badge(labels[l.state] || l.state,canPick(l)?'good':l.state==='review'?'warn':''));
      if(v?.eligible && l.blockedReason && !a.send)result.append(element('p',l.blockedReason,'muted'));
      row.append(chooseCell,customer,analysis,result);$('analysisRows').append(row);
    }
    const hasMessages=!!a.analysis;
    show('messageEmpty',!hasMessages);show('messageResult',hasMessages);
    $('status3').textContent=a.send?(labels[c.state] || c.state):hasMessages?'Chờ duyệt gửi':'Đang khóa';
    $('status3').className='badge '+(c.state==='completed'?'good':hasMessages?'blue':'');
    $('recipientSummary').textContent=`${a.analysis?.leadIds.length || 0} khách đã duyệt · Gửi từ ${accountName(c.profile)}`;
    show('reviewSelection',c.state==='message_review');show('prepareMessages',c.state==='message_review');
    $('messagePreviews').replaceChildren(...(c.messagePreview?.messages || []).map(m=>{const d=element('article',undefined,'message-card');d.append(element('h3',m.name),link(m.url),element('p',m.message));return d;}));
    show('sendApproval',c.state==='message_review' && !!c.messagePreview);
    show('sendResult',!!a.send);show('stopSending',['send_queued','sending'].includes(c.state));
    const sentLeads=c.leads.filter(l=>a.analysis?.leadIds.includes(l.id));
    stats('sendStats',[['Đã gửi',sentLeads.filter(l=>l.state==='sent').length,'good'],['Chưa xác nhận',sentLeads.filter(l=>l.state==='unconfirmed').length,'warn'],['Tổng đã duyệt',sentLeads.length]]);
    $('sendRows').replaceChildren(...sentLeads.map(l=>{const row=element('div',undefined,'send-row'),info=element('div');info.append(link(l.url,l.assessment?.name));if(l.error)info.append(element('p',l.error,'muted'));row.append(info,badge(l.state==='qualified'?'Chờ gửi':labels[l.state] || l.state,l.state==='sent'?'good':l.state==='unconfirmed'?'warn':''));return row;}));
    $('sendNote').textContent=c.error || (c.cancelled?'Đã yêu cầu dừng; tin đã gửi không thể thu hồi tại đây.':'Chỉ ghi đã gửi khi Messenger xác nhận. Tin chưa rõ trạng thái không được tự gửi lại.');
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
    try{const c=await api(`/api/ctv/campaigns/${id}`);if(epoch!==version)return;uncertain=false;notice();render(c,true);}
    catch(e){notice(e.message,true);}finally{busy=false;updateControls();schedule();}
  }
  async function action(name,body={}) {
    if(!selected || busy || uncertain)return;
    const id=selected.id,version=epoch;busy=true;clearTimeout(timer);updateControls();notice();
    try{const c=await api(`/api/ctv/campaigns/${id}/${name}`,'POST',body);if(epoch!==version)return;uncertain=false;$('confirmSend').checked=false;render(c);if(name==='approve-import'||name==='review-analysis')viewStep(2);if(name==='approve-analysis')viewStep(3);}
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
  $('approveImport').onclick=()=>action('approve-import');
  $('selectAll').onchange=()=>{picks=$('selectAll').checked?new Set(selected.leads.filter(canPick).map(l=>l.id)):new Set();for(const box of $('analysisRows').querySelectorAll('input'))box.checked=picks.has(box.value);updateControls();};
  $('approveAnalysis').onclick=()=>action('approve-analysis',{leadIds:[...picks]});
  $('reviewSelection').onclick=()=>action('review-analysis');
  $('template').oninput=()=>{$('confirmSend').checked=false;updateControls();};
  $('prepareMessages').onclick=()=>action('prepare-messages',{template:$('template').value});
  $('confirmSend').onchange=updateControls;
  $('sendButton').onclick=()=>{if(!$('sendButton').disabled)action('send',{previewToken:selected.messagePreview.token});};
  $('stopAnalysis').onclick=$('stopSending').onclick=()=>action('stop');
  $('refresh').onclick=()=>sync();
  $('newCampaign').onclick=()=>{if(busy)return;epoch++;clearTimeout(timer);selected=null;uncertain=false;picks.clear();notice();viewStep(1);
    show('importForm',true);show('importResult',false);show('analysisEmpty',true);show('analysisResult',false);show('messageEmpty',true);show('messageResult',false);
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
