const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ctv.js'), 'utf8');
const context = {element: (tag, text, cls) => ({tag, text, cls, children:[], append(...nodes) {this.children.push(...nodes);}})};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function renderAssessment('), source.indexOf('  const urlsFrom')), context);

test('scan log shows elapsed time and preserves expansion on polling', () => {
  const lead = {id:'lead-1', scanLog:[{elapsedMs:1250, message:'<img onerror=alert(1)>'}]};
  const rendered = context.renderScanLog(lead);
  assert.equal(rendered.children[0].text, '1s · <img onerror=alert(1)>');
  const details = rendered.children[1];
  assert.equal(details.open, false);
  details.open = true; details.ontoggle();
  assert.equal(context.renderScanLog(lead).children[1].open, true);
  assert.equal(context.renderScanLog({id:'legacy'}).children.length, 0);
});
test('preview defaults to a seller verdict and closed native details containing five sections', () => {
  const preview = context.renderAssessmentPreview({sellerUS:'yes',type:'page',confidence:1});
  assert.equal(preview.children[0].text, 'Seller bán sản phẩm trên website Mỹ: Có');
  const details = preview.children[1];
  assert.equal(details.tag, 'details'); assert.notEqual(details.open, true);
  assert.equal(details.children[0].tag, 'summary');
  assert.deepEqual(details.children[0].children.map(n=>n.text), ['Xem chi tiết','Thu gọn']);
  assert.equal(details.children[1].children.length, 5);
});
test('unselectable Fanpage explains the personal-profile gate, not seller confidence', () => {
  assert.match(context.selectionExplanation({assessment:{eligible:false,type:'page',sellerUS:'yes',confidence:1}}), /Fanpage.*chỉ cho chọn profile cá nhân/);
  assert.equal(context.selectionExplanation({assessment:{eligible:true},selectionBlockedReason:'Đã liên hệ'}), 'Đã liên hệ');
});
test('assessment renders five distinct numbered sections as text, including multiline captions', () => {
  const v = {type:'page',sellerUS:'yes',confidence:.97,name:'<img src=x onerror=alert(1)>',bio:'Bio gốc',brands:['Nike','Coach'],captionAnalysis:'Bài 1: bán giày.\nBài 2: bán túi.'};
  const list = context.renderAssessment(v);
  assert.equal(list.tag, 'ol'); assert.equal(list.children.length, 5);
  const values = list.children.map(item => item.children[1].text);
  assert.deepEqual(values, ['Fanpage - Bán sản phẩm có trên website Mỹ - Có - 97%',v.name,v.bio,'Nike, Coach',v.captionAnalysis]);
  assert.ok(list.children.every(item => item.tag === 'li' && item.children[0].tag === 'strong'));
});
test('legacy assessment shows missing fields honestly and retains the previous analysis', () => {
  const list = context.renderAssessment({type:'group',sellerUS:'unknown',confidence:null,reason:'Phân tích cũ'});
  const values = list.children.map(item => item.children[1].text);
  assert.match(values[0], /^Group.*Chưa rõ.*Chưa đủ dữ liệu$/);
  assert.equal(values[1], 'Chưa đọc được tên Facebook');
  assert.equal(values[2], 'Chưa có dữ liệu bio');
  assert.equal(values[3], 'Chưa xác định được thương hiệu');
  assert.equal(values[4], 'Phân tích cũ');
});

test('wholesale exclusion shows a warning and the grounded recruitment quote', () => {
 const quote='Tuyển đại lý toàn quốc, nhận hàng sỉ bán lại';
 const v={sellerUS:'yes',wholesaleRecruitment:{excluded:true,reason:'Loại do tuyển mạng lưới bán hàng',evidence:[quote]}};
 const preview=context.renderAssessmentPreview(v);
 assert.match(preview.children[1].text,/Đã loại/);
 const list=context.renderAssessment(v);
 assert.match(list.children.at(-1).children[1].text,/Tuyển đại lý toàn quốc/);
});


test('caption review highlights source text safely and displays uncertain aliases', () => {
  const review=context.renderAssessment({provider:'keywords',reason:'Không AI',captionReviews:[{text:'<script>CK</script>',spans:[{start:8,end:10,kind:'brand',label:'Calvin Klein',certainty:'possible'}]}]});
  const caption=review.children[3];
  const paragraph=caption.children[1];
  assert.equal(paragraph.children[0].text,'<script>');
  assert.equal(paragraph.children[1].tag,'mark');assert.equal(paragraph.children[1].text,'CK');
  assert.equal(paragraph.children[2].text,'</script>');
  assert.match(caption.children[2].text,/Có thể là: Calvin Klein/);
  assert.equal(context.renderAssessmentPreview({provider:'keywords',suggestion:'Cần kiểm tra'}).children[0].text,'Cần kiểm tra');
});


test('inline brand form captures selected caption text and sends canonical name without scanning',async t=>{
 const original=context.element;t.after(()=>{context.element=original;});
 context.element=(tag,text,cls)=>({tag,text,cls,children:[],value:'',append(...nodes){this.children.push(...nodes);},setAttribute(){},focus(){}});
 const node={};const content={contains:n=>n===node};
 context.window={getSelection:()=>({anchorNode:node,focusNode:node,toString:()=> 'Hermès'})};
 context.selected={id:'campaign-1',state:'analysis_review'};context.busy=false;context.uncertain=false;context.epoch=1;context.ACTIVE=['analyzing'];
 context.updateControls=()=>{};context.notice=()=>{};context.document={querySelectorAll:()=>[]};
 let request,rendered;context.api=async(...args)=>{request=args;return {id:'campaign-1'};};context.render=value=>{rendered=value;};
 const box=context.captionBrandEditor(content,'Hermès Un Jardin','lead-1');
 content.onmouseup();box.children[0].onclick();
 const form=box.children[1],alias=form.children[0].children[0],name=form.children[1].children[0];
 assert.equal(form.hidden,false);assert.equal(alias.value,'Hermès');name.value='Hermès';
 await form.onsubmit({preventDefault(){}});
 assert.equal(request[0],'/api/ctv/campaigns/campaign-1/add-brand');assert.equal(request[2].leadId,'lead-1');assert.equal(request[2].alias,'Hermès');assert.equal(rendered.id,'campaign-1');
 request=null;alias.value='Not in caption';await form.onsubmit({preventDefault(){}});assert.equal(request,null);
});


test('highlight editor submits exact saved span for hide and replacement',async t=>{
 const original=context.element;t.after(()=>{context.element=original;});
 context.element=(tag,text,cls)=>({tag,text,cls,children:[],value:'',append(...nodes){this.children.push(...nodes);},setAttribute(){}});
 context.selected={id:'campaign',state:'analysis_review'};context.busy=false;context.uncertain=false;context.epoch=1;context.ACTIVE=['sending'];
 context.updateControls=()=>{};context.notice=()=>{};context.render=()=>{};context.document={querySelectorAll:()=>[]};context.window={confirm:()=>true};
 let request;context.api=async(...args)=>{request=args;return {id:'campaign'};};
 const span={start:0,end:17,text:'Hermès Un Jardin',label:'Hermès Un Jardin',kind:'brand'};
 const form=context.highlightEditor(span,{text:'Hermès Un Jardin'},0,'lead',()=>{});
 await form.children.find(e=>e.text==='Bỏ highlight lần này').onclick();
 assert.equal(request[0],'/api/ctv/campaigns/campaign/update-highlight');assert.equal(request[2].operation,'hide');assert.equal(request[2].start,0);assert.equal(request[2].captionText,'Hermès Un Jardin');
 form.children[1].children[0].value='Hermès';form.children[2].children[0].value='Hermès';
 await form.children.find(e=>e.text==='Lưu sửa brand').onclick();assert.equal(request[2].operation,'edit');assert.equal(request[2].alias,'Hermès');
});
