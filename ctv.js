(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let selected = null, timer = null;
  const labels = { draft:'Chưa chạy',queued:'Đang chờ',running:'Đang chạy',pending:'Chờ đánh giá',checking:'AI đang đánh giá',qualified:'Đạt điều kiện',review:'Cần kiểm tra',duplicate:'Đã có lần gửi trước',sending:'Đang gửi',sent:'Đã gửi',unconfirmed:'Chưa xác nhận gửi',done:'Hoàn tất',cancelled:'Đã dừng',interrupted:'Bị gián đoạn',needs_attention:'Cần xử lý',failed:'Lỗi' };
  const links = text => [...new Set(text.match(/https:\/\/(?:www\.|m\.)?facebook\.com\/[^\s,"'<>]+/gi) || [])];
  function notice(error) { $('notice').textContent = error?.message || error || ''; }
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
  function render(c) {
    selected = c;
    $('summary').textContent = `${labels[c.state] || c.state} · ${c.mode === 'auto' ? 'Đánh giá rồi tự gửi' : 'Chỉ đánh giá'} · ${c.leads.length} khách · ${c.leads.filter(l=>l.assessment?.eligible).length} đạt · ${c.leads.filter(l=>l.state === 'sent').length} đã gửi${c.error ? ' · '+c.error : ''}`;
    $('start').disabled = c.state !== 'draft'; $('stop').disabled = !['queued','running'].includes(c.state);
    $('rows').replaceChildren();
    for (const l of c.leads) {
      const tr = el('tr'), customer = el('td'), review = el('td'), message = el('td');
      const a = el('a',l.assessment?.name || l.url); a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; customer.append(a);
      const v = l.assessment;
      if (v) {
        review.append(el('div',`${v.type === 'personal' ? 'Cá nhân' : v.type === 'page' ? 'Fanpage' : 'Chưa rõ loại'} · Seller US: ${v.sellerUS === 'yes' ? 'Có' : v.sellerUS === 'no' ? 'Không' : 'Chưa rõ'}${typeof v.confidence === 'number' ? ' · '+Math.round(v.confidence*100)+'%' : ''}`));
        review.append(el('p',v.reason));
        if (v.gateReason && !v.eligible) review.append(el('p',v.gateReason,'muted'));
        for (const quote of v.evidence || []) review.append(el('blockquote',quote));
      } else review.textContent = 'Chưa có kết quả';
      message.append(el('span', labels[l.state] || l.state,'badge '+l.state));
      if (l.error) message.append(el('p',l.error));
      if (l.message) { const details = el('details'); details.append(el('summary','Xem nội dung lời mời'),el('p',l.message)); message.append(details); }
      tr.append(customer,review,message); $('rows').append(tr);
    }
    clearTimeout(timer);
    if (['queued','running'].includes(c.state)) timer = setTimeout(async () => { try { render(await api(`/api/ctv/campaigns/${c.id}`)); } catch(e) { notice(e); } },2500);
  }
  async function history() {
    const campaigns = await api('/api/ctv/campaigns'); $('campaigns').replaceChildren();
    for (const c of campaigns.reverse()) { const b = el('button',`${new Date(c.createdAt).toLocaleString('vi-VN')} · ${c.leads.length} khách · ${labels[c.state] || c.state}`,'secondary'); b.onclick=async()=>{try{render(await api(`/api/ctv/campaigns/${c.id}`));notice('');}catch(e){notice(e);}}; $('campaigns').append(b); }
    if (!campaigns.length) $('campaigns').append(el('p','Chưa có chiến dịch.','muted'));
  }
  $('urls').oninput = () => { $('count').textContent = `${links($('urls').value).length} link khác nhau`; };
  $('file').onchange = async () => { try { const f = $('file').files[0]; if(!f)return; if(f.size>1000000)throw new Error('File vượt quá 1 MB'); $('urls').value = await f.text(); $('urls').oninput(); } catch(e){notice(e);} };
  $('create').onclick = async () => {
    $('create').disabled = true;
    try { const urls = links($('urls').value); if (!urls.length) throw new Error('Chưa tìm thấy link Facebook https trong dữ liệu'); render(await api('/api/ctv/campaigns','POST',{profile:$('profile').value,urls,mode:$('mode').value,template:$('template').value})); notice('Đã tạo. Kiểm tra danh sách và chế độ trước khi bấm Bắt đầu chiến dịch.'); await history(); } catch(e){notice(e);} finally{$('create').disabled=false;}
  };
  $('start').onclick=async()=>{if(!selected)return; $('start').disabled=true; try{render(await api(`/api/ctv/campaigns/${selected.id}/start`,'POST',{}));notice('');}catch(e){notice(e);}};
  $('stop').onclick=async()=>{if(!selected)return; try{render(await api(`/api/ctv/campaigns/${selected.id}/stop`,'POST',{}));notice('Đã yêu cầu dừng. Tin đã bấm gửi không thể thu hồi tại đây.');}catch(e){notice(e);}};
  (async()=>{try{
    const p = await api('/api/accounts'); $('profile').replaceChildren(el('option','Chọn Facebook cá nhân')); $('profile').firstChild.value='';
    for (const a of p.facebook || []) { const o=el('option',a.name || a.key);o.value=a.key;$('profile').append(o); }
    await history();
  }catch(e){notice(e);}})();
})();
