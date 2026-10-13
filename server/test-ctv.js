const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { profileUrl, recipientId, classify, renderMessage } = require('./src/ctv/rules');
const { evaluateProfile } = require('./src/ctv/ai');
const { CtvService } = require('./src/ctv/service');
const { mountCtv } = require('./src/ctv/routes');
const input = urls => ({profile:'test',name:'Test workflow',urls:urls || ['https://facebook.com/123','https://facebook.com/456']});
function setup(t, overrides = {}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xeko-ctv-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=[],inspected=[];
  const browser={closeInspection:async()=>{},withPage:async(p,fn)=>fn({}),inspect:async(_,url)=>{inspected.push(url);return {url,actualUrl:url,name:'Khách '+recipientId(url),criteriaVersion:'us-website-products-v2',eligible:true,recipientId:recipientId(url)};},send:async(_,a,m,reserve)=>{reserve();sent.push({id:a.recipientId,message:m});return {state:'sent'};},...overrides};
  const s=new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}});
  return {s,sent,inspected,browser,dir};
}
const settle = s => Promise.all([...s.running]);
const sampleImage={name:'photo.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='};
test('images are fixed in preview, restored and forwarded only after approval',async t=>{
  const {s,browser}=setup(t),c=await analyzed(s);prepared(s,c);
  const inputImages=[{...sampleImage}];s.prepareMessages(c.id,'owner','Hi {name}',inputImages);
  const token=c.messagePreview.token;inputImages[0].dataUrl='changed';
  assert.equal(c.messagePreview.images[0].dataUrl,sampleImage.dataUrl);
  const restored=new CtvService({file:s.file,browser}).get(c.id,'owner');
  assert.equal(restored.messagePreview.images[0].dataUrl,sampleImage.dataUrl);
  s.prepareMessages(c.id,'owner','Hi {name}',[]);
  assert.throws(()=>s.sendApproved(c.id,'owner',token));
  s.prepareMessages(c.id,'owner','Hi {name}',[sampleImage]);let calls=0;
  browser.send=async(_,lead,message,reserve,cancelled,images)=>{calls++;assert.equal(images[0].dataUrl,sampleImage.dataUrl);reserve();return {state:'sent'};};
  assert.equal(calls,0);s.sendApproved(c.id,'owner',c.messagePreview.token);await settle(s);assert.equal(calls,2);
});
test('invalid and oversized attachments cannot replace a valid preview',async t=>{
  const {s}=setup(t),c=await analyzed(s);const token=prepared(s,c);
  for(const images of [null,{},Array(6).fill(sampleImage),[{name:'x',dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}],[{name:'x',dataUrl:'data:image/png;base64,YWJj'}],[{name:'x',dataUrl:'data:image/png;base64,'+Buffer.alloc(2*1024*1024+1).toString('base64')}]]){
    assert.throws(()=>s.prepareMessages(c.id,'owner','Hello',images));assert.equal(c.messagePreview.token,token);
  }
});
test('image submission failure retains reservation and blocks a second attempt',async t=>{
  const {s,browser}=setup(t),c=await analyzed(s);prepared(s,c);s.prepareMessages(c.id,'owner','Hi',[sampleImage]);
  browser.send=async(_,lead,message,reserve)=>{reserve();throw Error('Chưa xác nhận ảnh đã gửi');};
  s.sendApproved(c.id,'owner',c.messagePreview.token);await settle(s);
  assert.equal(c.state,'needs_attention');assert.equal(c.leads[0].state,'unconfirmed');assert.ok(s.data.reservations['123']);
  s.sendApproved(c.id,'owner',c.messagePreview.token);assert.equal(s.running.size,0);
});

test('UID lookup preserves AI, invalidates approvals and runs in account queue without sending', async t => {
  const {s,browser,sent,inspected}=setup(t);
  const c=await analyzed(s); const oldToken=prepared(s,c);
  const lead=c.leads[0], previous={...lead.assessment};
  let queuedProfile, calls=0;
  s.queue=async(fn,profile)=>{queuedProfile=profile;return fn();};
  browser.resolveUid=async()=>{calls++;return {recipientId:'999',uidStatus:'resolved'};};
  s.resolveUids(c.id,'owner',lead.id);
  assert.equal(c.state,'uid_queued');assert.equal(c.messagePreview,undefined);assert.equal(c.approvals.analysis,undefined);
  assert.throws(()=>s.sendApproved(c.id,'owner',oldToken));
  assert.throws(()=>s.resolveUids(c.id,'owner',lead.id));
  assert.throws(()=>s.deleteCampaign(c.id,'owner'));
  await settle(s);
  assert.equal(queuedProfile,'test');assert.equal(calls,1);assert.equal(sent.length,0);assert.equal(inspected.length,2);
  assert.equal(c.state,'analysis_review');assert.equal(lead.assessment.recipientId,'999');
  assert.equal(lead.assessment.name,previous.name);assert.equal(lead.assessment.eligible,previous.eligible);
  prepared(s,c);assert.equal(c.messagePreview.messages[0].recipientId,'999');
});
test('missing UID batch skips resolved and skipped profiles and supports stop before opening browser', async t => {
  const {s,browser}=setup(t);const c=await analyzed(s);
  c.leads[0].assessment.recipientId=null;
  let calls=0, closed=0;
  browser.resolveUid=async()=>{calls++;return {recipientId:'111',uidStatus:'resolved'};};
  browser.closeInspection=async()=>{closed++;};
  s.resolveUids(c.id,'owner');s.stop(c.id,'owner');await settle(s);
  assert.equal(calls,0);assert.equal(closed,1);assert.equal(c.leads[0].uidLookup.state,'unresolved');
  s.resolveUids(c.id,'owner');await settle(s);assert.equal(calls,1);
  c.leads[0].state='skipped';c.leads[0].assessment.recipientId=null;
  assert.throws(()=>s.resolveUids(c.id,'owner'));
});
test('failed UID refresh clears stale recipient and closes browser; lookup is owner and stage scoped', async t => {
  const {s,browser}=setup(t);const c=await analyzed(s);let closed=0;
  browser.resolveUid=async()=>{throw Error('checkpoint');};browser.closeInspection=async()=>{closed++;};
  assert.throws(()=>s.resolveUids(c.id,'other',c.leads[0].id));
  assert.throws(()=>s.resolveUids(c.id,'owner','unknown'));
  assert.throws(()=>s.resolveUids(c.id,'owner',{}));
  s.resolveUids(c.id,'owner',c.leads[0].id);await settle(s);
  assert.equal(closed,1);assert.equal(c.leads[0].assessment.recipientId,null);
  assert.match(c.leads[0].uidLookup.reason,/checkpoint/);
  assert.match(s.reasonBlocked(c.leads[0]),/Tìm UID/);
  c.approvals.send={token:'old'};assert.throws(()=>s.resolveUids(c.id,'owner',c.leads[0].id));
});
test('UID lookup restart cannot resume or retain in-progress status', async t => {
  const {s,browser}=setup(t);const c=await analyzed(s);
  c.state='resolving_uid';c.leads[0].uidLookup={state:'checking'};c.leads[0].assessment.recipientId=null;s.save();
  const restored=new CtvService({file:s.file,browser}).get(c.id,'owner');
  assert.equal(restored.state,'interrupted');assert.equal(restored.leads[0].uidLookup.state,'unresolved');
});
test('resolve-uids API returns accepted and enforces permissions for cloud forwarding', async t => {
  const {s,browser}=setup(t);const c=await analyzed(s);
  browser.resolveUid=async()=>({recipientId:'999',uidStatus:'resolved'});
  let handler;mountCtv({all:(_,h)=>{handler=h;}},{service:s});
  const req={path:`/api/ctv/campaigns/${c.id}/resolve-uids`,method:'POST',body:{leadId:c.leads[0].id},headers:{'x-ctv-owner':'owner'}};
  const res=response();await handler(req,res);assert.equal(res.code,202);await settle(s);
  let forwarded=0;
  mountCtv({all:(_,h)=>{handler=h;}},{remote:true,getLocalUrl:()=> 'http://local',permissions:{getAllowedProfileKeys:()=>['other']},
    fetchFn:async()=>{forwarded++;return {ok:true,json:async()=>({profile:'test'})};}});
  const forbidden=response();await handler({...req,user:{email:'owner'},body:{profile:'other'}},forbidden);
  assert.equal(forbidden.code,403);assert.equal(forwarded,1);
});
test('analysis closes once after all links and closes again on retry', async t => {
  const events = [];
  const {s} = setup(t, {
    inspect:async (_, url)=>{events.push(url); return {eligible:false};},
    closeInspection:async profile=>{assert.equal(profile,'test'); events.push('close');},
  });
  const c = await analyzed(s);
  const expected = [...c.leads.map(l=>l.url),'close'];
  assert.deepEqual(events,expected);
  s.retryAnalysis(c.id,'owner'); await settle(s);
  assert.deepEqual(events,[...expected,...expected]);
  assert.equal(c.leads.at(-1).scanLog.at(-1).stage,'browser_closed');
});
test('cleanup runs after failure or stop and preserves scan errors', async t => {
  let closed=0;
  const {s,browser,inspected} = setup(t,{closeInspection:async()=>{closed++;}});
  const c=s.create(input(),'owner');
  s.pause=async()=>s.stop(c.id,'owner');
  s.approveImport(c.id,'owner'); await settle(s);
  assert.equal(inspected.length,1); assert.equal(closed,1);
  browser.inspect=async()=>{throw Error('AI unavailable');};
  const d=await analyzed(s);
  assert.equal(closed,2); assert.equal(d.state,'analysis_review'); assert.match(d.error,/AI unavailable/);
  browser.closeInspection=async()=>{throw Error('close failed');};
  const e=await analyzed(s);
  assert.equal(e.state,'needs_attention'); assert.match(e.error,/AI unavailable.*close failed/);
  assert.equal(e.leads[0].scanLog.at(-1).stage,'browser_close_error');
});
test('review and retry stay locked until context close resolves', async t => {
  let release, closing;
  const entered=new Promise(resolve=>{closing=resolve;});
  const {s}=setup(t,{closeInspection:async()=>{closing(); await new Promise(resolve=>{release=resolve;});}});
  const c=s.create(input(['https://facebook.com/123']),'owner');
  s.approveImport(c.id,'owner'); await entered;
  assert.equal(c.state,'analyzing');
  assert.throws(()=>s.retryAnalysis(c.id,'owner'));
  assert.throws(()=>s.approveAnalysis(c.id,'owner',[c.leads[0].id]));
  release(); await settle(s); assert.equal(c.state,'analysis_review');
});
test('scan events are bounded, persisted during work, and retain failure context', async t => {
  const { s, browser } = setup(t);
  browser.inspect = async (_, url, { onProgress, cancelled }) => {
    assert.equal(cancelled(), false);
    for (let i = 0; i < 105; i++) onProgress({stage: 'batch', message: `Lượt ${i}`});
    const persisted = JSON.parse(fs.readFileSync(s.file, 'utf8')).campaigns[0].leads[0];
    assert.equal(persisted.state, 'checking');
    assert.equal(persisted.scanLog.length, 100);
    assert.equal(persisted.scanLog.at(-1).message, 'Lượt 104');
    throw Error('browser disconnected');
  };
  const c = await analyzed(s, ['https://facebook.com/123']);
  assert.equal(c.leads[0].scanLog.find(e=>e.stage === 'error').stage, 'error');
  assert.equal(c.leads[0].scanLog.find(e=>e.stage === 'error').message, 'browser disconnected');
  assert.equal(c.state, 'analysis_review');
  const restored = new CtvService({file:s.file,browser});
  assert.equal(restored.view(restored.get(c.id, 'owner')).leads[0].scanLog.find(e=>e.stage === 'error').stage, 'error');
});
async function analyzed(s,urls){const c=s.create(input(urls),'owner');s.approveImport(c.id,'owner');await settle(s);return c;}
function prepared(s,c){s.approveAnalysis(c.id,'owner',c.leads.map(l=>l.id));s.prepareMessages(c.id,'owner','Chào {name}, mời bạn hợp tác CTV.');return c.messagePreview.token;}

test('canonical URLs reject external, non-profile and malformed links',()=>{
  assert.equal(profileUrl('https://m.facebook.com/Example/?ref=x'),'https://www.facebook.com/example');assert.equal(recipientId('https://facebook.com/profile.php?id=123&ref=x'),'123');
  for(const url of ['https://facebook.com.evil.test/a','http://facebook.com/a','https://facebook.com/groups/a','https://facebook.com/a/posts/1','https://facebook.com/share/1','https://facebook.com:8080/a','https://u:p@facebook.com/a','https://facebook.com/profile.php?id=x'])assert.throws(()=>profileUrl(url));
});
const snapshot={personalEvidence:true,pageEvidence:false,bio:'Nhận order từ Amazon.com về Việt Nam',posts:['Nhận order máy pha cà phê từ Amazon.com về Việt Nam.', 'Bán giày từ website Mỹ nike.com, nhận đặt hàng.', 'Chốt đơn mỹ phẩm từ sephora.com Mỹ.']};
test('qualification requires at least three sales posts, independent of buyer market',()=>{
  assert.equal(classify(snapshot).eligible,true);
  for(const s of [{...snapshot,blocked:'locked'},{...snapshot,pageEvidence:true},{...snapshot,personalEvidence:false},{...snapshot,posts:['I live in USA.','Order today for $20.']},{...snapshot,posts:['Nhận order hàng Mỹ về Việt Nam']}])assert.equal(classify(s).eligible,false);
  assert.throws(()=>renderMessage('Chào {brand}','A'));assert.equal(renderMessage('Chào {name}','$&'),'Chào $&');
});
test('AI must ground evidence and pass confidence and DOM gates',async()=>{
  const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test-only';
  const response=result=>async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]})});
  const good={profileType:'personal',sellerUS:'yes',confidence:.95,reason:'Bán sản phẩm trên website Mỹ cho khách Việt Nam',evidence:[snapshot.posts[0]]};
  try{assert.equal((await evaluateProfile(snapshot,response(good))).eligible,true);
    for(const patch of [{evidence:['fabricated seller US evidence']},{confidence:.7}])assert.equal((await evaluateProfile(snapshot,response({...good,...patch}))).eligible,false);
    assert.equal((await evaluateProfile({...snapshot,pageEvidence:true},response(good))).eligible,false);
    assert.equal((await evaluateProfile({...snapshot,posts:snapshot.posts.slice(0,2)},response(good))).eligible,false);
    assert.equal((await evaluateProfile(snapshot,response({...good,sellerUS:'unknown'}))).eligible,false);
    assert.equal((await evaluateProfile(snapshot,response({...good,evidence:[snapshot.bio]}))).eligible,true);
    const capture = async (url, options) => {
      const payload = JSON.parse(options.body);
      assert.match(payload.systemInstruction.parts[0].text, /không phải thị trường khách hàng Mỹ/);
      assert.match(payload.systemInstruction.parts[0].text, /Ít hơn 3 bài bán hàng: unknown/);
      assert.equal(JSON.parse(payload.contents[0].parts[0].text).bio, snapshot.bio);
      return response(good)();
    };
    await evaluateProfile(snapshot,capture);
    const imageSnapshot = {...snapshot, postMedia: [{caption: snapshot.posts[0], images: [{mimeType:'image/jpeg',data:'cGhvdG8='}]}]};
    const visualResult = await evaluateProfile(imageSnapshot, async (url, options) => {
      const parts = JSON.parse(options.body).contents[0].parts;
      assert.equal(JSON.parse(parts[0].text).postMedia, undefined);
      assert.match(parts[1].text, /Bài viết 1, caption:/);
      assert.deepEqual(parts[2], {inline_data:{mime_type:'image/jpeg',data:'cGhvdG8='}});
      return response({...good,evidence:['Chữ tự suy đoán từ hình ảnh']})();
    });
    assert.equal(visualResult.reviewedImageCount, 1);
    assert.equal(visualResult.eligible, false);
    await assert.rejects(()=>evaluateProfile(snapshot,response({...good,confidence:'high'})));
  }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
test('import returns valid, duplicate and rejected results with zero browser effects',async t=>{
  const {s,sent,inspected}=setup(t);const c=s.create(input(['https://facebook.com/123','https://m.facebook.com/123?ref=x','https://evil.test/abc']),'owner');
  await settle(s);assert.equal(c.state,'import_review');assert.equal(c.leads.length,1);assert.equal(c.duplicateCount,1);assert.equal(c.rejected.length,1);assert.equal(inspected.length,0);assert.equal(sent.length,0);
  const empty=s.create(input(['https://evil.test/a']),'owner');assert.throws(()=>s.approveImport(empty.id,'owner'));
});
test('both review boundaries reject premature transitions and never auto-send',async t=>{
  const {s,sent,inspected}=setup(t);const c=s.create(input(),'owner');
  assert.throws(()=>s.approveAnalysis(c.id,'owner',[c.leads[0].id]));assert.throws(()=>s.prepareMessages(c.id,'owner','Hello'));assert.throws(()=>s.sendApproved(c.id,'owner','fake'));
  s.approveImport(c.id,'owner');s.approveImport(c.id,'owner');await settle(s);
  assert.equal(inspected.length,2);assert.equal(c.state,'analysis_review');assert.equal(sent.length,0);
  s.approveAnalysis(c.id,'owner',[c.leads[0].id]);assert.equal(c.state,'message_review');assert.equal(sent.length,0);assert.throws(()=>s.sendApproved(c.id,'owner','fake'));
});
test('only selected recipients receive exact approved previews; send retry is idempotent',async t=>{
  const {s,sent}=setup(t);const c=await analyzed(s);
  s.approveAnalysis(c.id,'owner',[c.leads[1].id]);s.prepareMessages(c.id,'owner','Chào {name}');const token=c.messagePreview.token;
  assert.equal(sent.length,0);s.sendApproved(c.id,'owner',token);s.sendApproved(c.id,'owner',token);await settle(s);
  assert.deepEqual(sent,[{id:'456',message:'Chào Khách 456'}]);assert.equal(c.state,'completed');
  s.sendApproved(c.id,'owner',token);await settle(s);assert.equal(sent.length,1);assert.ok(c.approvals.send.at);
});
test('changed message and changed selection invalidate old preview approval',async t=>{
  const {s,sent}=setup(t);const c=await analyzed(s);const token=prepared(s,c);
  s.prepareMessages(c.id,'owner','Nội dung mới cho {name}');assert.throws(()=>s.sendApproved(c.id,'owner',token));
  const changed=c.messagePreview.token;s.reviewAnalysis(c.id,'owner');assert.equal(c.messagePreview,undefined);assert.throws(()=>s.sendApproved(c.id,'owner',changed));assert.equal(sent.length,0);
});
test('manual selection allows reviewed profiles but preserves send checks and rejects invalid or duplicate recipients',async t=>{
  const {s}=setup(t);const c=await analyzed(s);const lead=c.leads[0];
  lead.assessment.eligible=false;lead.assessment.type='page';
  assert.equal(s.view(c).leads[0].selectionBlockedReason,'');
  s.approveAnalysis(c.id,'owner',[lead.id]);
  assert.equal(c.state,'message_review');
  s.prepareMessages(c.id,'owner','Chào {name}');
  assert.equal(c.messagePreview.messages.length,1);
  s.reviewAnalysis(c.id,'owner');lead.assessment.eligible=true;
  lead.assessment.recipientId=null;assert.throws(()=>s.approveAnalysis(c.id,'owner',['fake']));
  lead.assessment.recipientId=c.leads[1].assessment.recipientId;assert.throws(()=>s.approveAnalysis(c.id,'owner',c.leads.map(l=>l.id)));
});
test('manually approved insufficient-data lead can preview and send without changing AI result', async t => {
  const {s,sent}=setup(t); const c=await analyzed(s); const lead=c.leads[0];
  Object.assign(lead.assessment,{eligible:false,insufficientData:true,salesPostCount:0,sellerUS:'unknown',gateReason:'Chưa đủ dữ liệu'});
  lead.state='review';
  assert.equal(s.view(c).leads[0].blockedReason,'');
  s.approveAnalysis(c.id,'owner',[lead.id]);
  s.prepareMessages(c.id,'owner','Chào {name}');
  assert.equal(sent.length,0);
  s.sendApproved(c.id,'owner',c.messagePreview.token); await settle(s);
  assert.deepEqual(sent.map(item=>item.id),['123']);
  assert.equal(lead.assessment.eligible,false);
  assert.equal(lead.assessment.salesPostCount,0);
  assert.equal(c.state,'completed');
});
test('stopping queued analysis and sending prevents external operations',async t=>{
  const {s,sent,inspected}=setup(t);const c=s.create(input(),'owner');s.approveImport(c.id,'owner');s.stop(c.id,'owner');await settle(s);
  assert.equal(inspected.length,0);assert.equal(c.state,'analysis_review');
  const d=await analyzed(s);const token=prepared(s,d);s.sendApproved(d.id,'owner',token);s.stop(d.id,'owner');await settle(s);assert.equal(sent.length,0);assert.equal(d.state,'cancelled');
});
test('cancel between recipients stops remaining batch',async t=>{
  const {s,sent}=setup(t);const c=await analyzed(s);const token=prepared(s,c);s.pause=async()=>{s.stop(c.id,'owner');};
  s.sendApproved(c.id,'owner',token);await settle(s);assert.equal(sent.length,1);assert.equal(c.state,'cancelled');
});
test('unconfirmed submission reserves recipient durably and stops the batch',async t=>{
  const {s,dir,browser}=setup(t,{send:async(_,a,m,reserve)=>{reserve();throw new Error('Lost response after Enter');}});
  const c=await analyzed(s);s.sendApproved(c.id,'owner',prepared(s,c));await settle(s);assert.equal(c.leads[0].state,'unconfirmed');assert.equal(c.state,'needs_attention');
  const restored=new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}});assert.ok(restored.data.reservations['123']);
  const d=await analyzed(restored);assert.equal(d.previouslyContacted.length,1);assert.ok(d.leads.every(l=>l.assessment.recipientId!=='123'));
});
test('restart preserves review stage and approved draft but cannot resume queued sends',async t=>{
  const {s,dir,browser}=setup(t);const c=await analyzed(s);prepared(s,c);const token=c.messagePreview.token;
  const restored=new CtvService({file:path.join(dir,'campaigns.json'),browser});assert.equal(restored.get(c.id,'owner').state,'message_review');assert.equal(restored.get(c.id,'owner').messagePreview.token,token);
  c.state='send_queued';c.approvals.send={token};s.save();const interrupted=new CtvService({file:path.join(dir,'campaigns.json'),browser});assert.equal(interrupted.get(c.id,'owner').state,'interrupted');assert.equal(interrupted.running.size,0);
});
test('AI failure exposes review without generating messages; legacy workflows are read-only',async t=>{
  const {s,sent}=setup(t,{inspect:async()=>{throw new Error('AI unavailable');}});const c=await analyzed(s);assert.equal(c.state,'analysis_review');assert.match(c.error,/AI unavailable/);assert.equal(c.messagePreview,undefined);assert.equal(sent.length,0);
  delete c.workflowVersion;assert.throws(()=>s.approveImport(c.id,'owner'));assert.throws(()=>s.sendApproved(c.id,'owner','fake'));assert.throws(()=>s.get(c.id,'other'));
});
function response(){return {code:200,status(n){this.code=n;return this;},json(d){this.data=d;return this;}};}
test('cloud checks stored profile permission on every new action, ignoring body spoofing',async()=>{
  for(const action of ['approve-import','approve-analysis','review-analysis','prepare-messages','send','stop','retry-analysis','delete','skip-lead']){
    let handler,calls=0;
    mountCtv({all:(p,h)=>handler=h},{remote:true,getLocalUrl:()=> 'https://worker.invalid',permissions:{getAllowedProfileKeys:()=>['allowed']},fetchFn:async()=>{calls++;return {ok:true,json:async()=>({profile:'forbidden'})};}});
    const res=response();await handler({path:`/api/ctv/campaigns/abc/${action}`,method:'POST',body:{profile:'allowed'},user:{email:'owner'},headers:{}},res);
    assert.equal(res.code,403);assert.equal(calls,1);
  }
});
test('API enforces gates even when called without the UI and disables old /start',async t=>{
  const {s,sent}=setup(t);const c=s.create(input(),'owner');let handler;mountCtv({all:(p,h)=>handler=h},{service:s});
  for(const [action,body,status] of [['send',{previewToken:'fake'},409],['approve-analysis',{leadIds:[c.leads[0].id]},409],['start',{},404]]){
    const res=response();await handler({path:`/api/ctv/campaigns/${c.id}/${action}`,method:'POST',body,headers:{'x-ctv-owner':'owner'}},res);assert.equal(res.code,status);
  }
  const unauth=response();await handler({path:'/api/ctv/campaigns',method:'GET',headers:{}},unauth);assert.equal(unauth.code,401);assert.equal(sent.length,0);
});

test('import preserves account keys with Vietnamese, spaces and punctuation', t => {
  const {s} = setup(t);
  for (const profile of ['Linh Thảo US', 'Linh Thảo US'.normalize('NFD'), 'linh.thao', 'legacy_123-test']) {
    const c = s.create({...input(), profile}, 'owner');
    assert.equal(c.profile, profile);
    assert.equal(c.state, 'import_review');
  }
});
test('import rejects missing, malformed and unsafe account keys', t => {
  const {s} = setup(t);
  for (const profile of [undefined, null, '']) {
    assert.throws(() => s.create({...input(), profile}, 'owner'), /Cần chọn tài khoản Facebook/);
  }
  for (const profile of [' ', '.', '..', '../other', '/tmp/account', 'a\\b', 'a\u0000b', 'a\nb', 123, {}, ['test'], 'a'.repeat(256)]) {
    assert.throws(() => s.create({...input(), profile}, 'owner'), /Mã tài khoản Facebook không hợp lệ/);
  }
  assert.equal(s.data.campaigns.length, 0);
});

 test('old criteria cannot approve recipients or send an existing preview', async t => {
  const {s,sent}=setup(t); const c=await analyzed(s);
  const token=prepared(s,c);
  delete c.leads[0].assessment.criteriaVersion;
  assert.match(s.reasonBlocked(c.leads[0]), /tiêu chí cũ/);
  assert.throws(()=>s.sendApproved(c.id,'owner',token));
  s.reviewAnalysis(c.id,'owner');
  assert.throws(()=>s.approveAnalysis(c.id,'owner',[c.leads[0].id]));
  assert.equal(sent.length,0);
});


test('retry clears stale results and approvals, rereads profiles and never sends', async t => {
  const {s, inspected, sent}=setup(t); const c=await analyzed(s);
  const token=prepared(s,c); c.leads[0].error='old error'; c.error='old failure'; c.cancelled=true;
  s.retryAnalysis(c.id,'owner');
  assert.equal(c.state,'analysis_queued'); assert.equal(c.cancelled,false);
  assert.equal(c.approvals.analysis,undefined); assert.equal(c.messagePreview,undefined);
  assert.equal(c.leads[0].assessment,undefined); assert.equal(c.leads[0].error,undefined);
  assert.throws(()=>s.retryAnalysis(c.id,'owner'));
  assert.throws(()=>s.deleteCampaign(c.id,'owner'));
  assert.throws(()=>s.sendApproved(c.id,'owner',token));
  await settle(s); assert.equal(inspected.length,4); assert.equal(sent.length,0);
  assert.equal(c.state,'analysis_review'); assert.equal(c.error,undefined);
});
test('failed and interrupted analysis can retry, but sent campaigns cannot', async t => {
  const {s,browser}=setup(t,{inspect:async()=>{throw new Error('AI unavailable');}});
  const c=await analyzed(s); assert.ok(c.error);
  browser.inspect=async()=>({eligible:false,criteriaVersion:'us-website-products-v2'});
  c.state='interrupted'; s.retryAnalysis(c.id,'owner'); await settle(s);
  assert.equal(c.error,undefined); assert.equal(c.leads[0].error,undefined);
  c.approvals.send={token:'sent'};
  assert.throws(()=>s.retryAnalysis(c.id,'owner'));
});
test('delete is owner scoped and persists removal without clearing send reservations', async t => {
  const {s,browser,dir}=setup(t); const c=await analyzed(s);
  s.sendApproved(c.id,'owner',prepared(s,c)); await settle(s);
  assert.throws(()=>s.deleteCampaign(c.id,'other'));
  assert.throws(()=>s.retryAnalysis(c.id,'other'));
  s.deleteCampaign(c.id,'owner'); assert.throws(()=>s.get(c.id,'owner'));
  const restored=new CtvService({file:path.join(dir,'campaigns.json'),browser});
  assert.equal(restored.data.campaigns.length,0); assert.ok(restored.data.reservations['123']);
  const d=restored.create(input(),'owner');
  assert.equal(d.leads.length,0); assert.equal(d.previouslyContacted.length,2);
  assert.throws(()=>restored.approveImport(d.id,'owner'));
});
test('retry and delete API actions enforce ownership and state', async t => {
  const {s}=setup(t); const c=await analyzed(s); let handler;
  mountCtv({all:(p,h)=>handler=h},{service:s});
  const request=async(action,owner='owner')=>{const res=response();await handler({path:`/api/ctv/campaigns/${c.id}/${action}`,method:'POST',body:{},headers:{'x-ctv-owner':owner}},res);return res;};
  assert.equal((await request('retry-analysis','other')).code,404);
  assert.equal((await request('delete','other')).code,404);
  assert.equal((await request('retry-analysis')).code,202);
  await settle(s);
  assert.equal((await request('delete')).code,200);
  assert.equal((await request('delete')).code,404);
});


test('skip persists, blocks approval and is excluded from retries and sending', async t => {
  const {s, browser, inspected, sent} = setup(t);
  const c = await analyzed(s);
  const [skip, keep] = c.leads;
  skip.assessment.eligible = false;
  s.skipLead(c.id, 'owner', skip.id);
  s.skipLead(c.id, 'owner', skip.id);
  assert.equal(skip.state, 'skipped');
  assert.equal(skip.skippedBy, 'owner');
  assert.ok(skip.skippedAt);
  const restored = new CtvService({file:s.file,browser,pause:async()=>{}});
  assert.equal(restored.get(c.id,'owner').leads[0].state,'skipped');
  skip.assessment.eligible = true;
  assert.throws(()=>s.approveAnalysis(c.id,'owner',[skip.id]));
  s.retryAnalysis(c.id,'owner'); await settle(s);
  assert.equal(skip.state,'skipped');
  assert.equal(inspected.filter(url=>url===skip.url).length,1);
  s.approveAnalysis(c.id,'owner',[keep.id]);
  s.prepareMessages(c.id,'owner','Chào {name}');
  s.sendApproved(c.id,'owner',c.messagePreview.token); await settle(s);
  assert.deepEqual(sent.map(item=>item.id),[keep.assessment.recipientId]);
});

test('skip API checks owner, lead and review stage and rejects qualified profiles', async t => {
  const {s} = setup(t); const c = await analyzed(s);
  const lead = c.leads[0];
  assert.throws(()=>s.skipLead(c.id,'other',lead.id));
  assert.throws(()=>s.skipLead(c.id,'owner','missing'));
  assert.throws(()=>s.skipLead(c.id,'owner',lead.id));
  lead.assessment.eligible=false;
  let handler; mountCtv({all:(p,h)=>handler=h},{service:s});
  const res=response();
  await handler({path:`/api/ctv/campaigns/${c.id}/skip-lead`,method:'POST',body:{leadId:lead.id},headers:{'x-ctv-owner':'owner'}},res);
  assert.equal(res.code,200); assert.equal(res.data.leads[0].state,'skipped');
  for(const state of ['analyzing','message_review','send_queued','sending','completed']) {
    c.state=state; assert.throws(()=>s.skipLead(c.id,'owner',lead.id));
  }
  c.state='analysis_review'; c.leads[1].assessment.eligible=false;
  s.skipLead(c.id,'owner',c.leads[1].id);
  assert.throws(()=>s.retryAnalysis(c.id,'owner'),/Tất cả hồ sơ/);
});

test('AI-qualified profile without recipient ID can be selected but cannot prepare or send', async t => {
  const {s,sent}=setup(t); const c=await analyzed(s); const lead=c.leads[0];
  lead.assessment.recipientId=null;
  const view=s.view(c).leads[0];
  assert.equal(view.selectionBlockedReason,'');
  assert.match(view.blockedReason,/Chưa xác minh/);
  s.approveAnalysis(c.id,'owner',[lead.id]);
  assert.equal(c.state,'message_review');
  assert.throws(()=>s.prepareMessages(c.id,'owner','Chào {name}'),/Chưa xác minh/);
  assert.throws(()=>s.sendApproved(c.id,'owner','fake'));
  assert.equal(sent.length,0);
  s.reviewAnalysis(c.id,'owner');
  lead.assessment.recipientId='123456789';
  s.approveAnalysis(c.id,'owner',[lead.id]);
  s.prepareMessages(c.id,'owner','Chào {name}');
  assert.equal(c.messagePreview.messages[0].recipientId,'123456789');
});

test('wholesale exclusion blocks manual selection and approved message sending',async t=>{
 const {s,sent}=setup(t);const c=await analyzed(s);const token=prepared(s,c);
 c.leads[0].assessment.wholesaleRecruitment={excluded:true,verdict:'yes',evidence:['Tuyển đại lý nhận hàng sỉ bán lại']};s.save();
 assert.match(s.selectionBlocked(c.leads[0]),/nguồn sỉ/);
 assert.throws(()=>s.approveAnalysis(c.id,'owner',[c.leads[0].id]));
 assert.throws(()=>s.sendApproved(c.id,'owner',token));assert.equal(sent.length,0);
});



test('caption mode persists and reaches worker without enabling automatic selection or sending', async t => {
  let mode;
  const {s,sent}=setup(t,{inspect:async(_,url,options)=>{mode=options.assessmentMode;return {...require('./src/ctv/caption-review').evaluateCaptions({personalEvidence:true,posts:['Áo CK đủ size']}),url,actualUrl:url,name:'Test',recipientId:recipientId(url)};}});
  const c=s.create({...input(['https://facebook.com/123']),assessmentMode:'keywords'},'owner');
  s.approveImport(c.id,'owner');await settle(s);
  assert.equal(mode,'keywords');assert.equal(c.assessmentMode,'keywords');assert.equal(c.leads[0].state,'review');assert.equal(sent.length,0);
  s.approveAnalysis(c.id,'owner',[c.leads[0].id]);
  assert.equal(c.state,'message_review');assert.equal(sent.length,0);
  c.leads[0].assessment.collectionBlocked=true;
  assert.match(s.selectionBlocked(c.leads[0]),/Chưa đọc được caption/);
  assert.throws(()=>s.create({...input(),assessmentMode:'invalid'},'owner'),/Chế độ/);
});


test('MyJoy campaign keeps owner/model, preserves manual approvals, and never persists credentials', async t => {
  const keys = {CTV_MYJOY_OWNER:'owner',CTV_MYJOY_USERNAME:'member',CTV_MYJOY_PASSWORD:'test-secret',CTV_MYJOY_URL:'https://myjoy.example'};
  const previous = Object.fromEntries(Object.keys(keys).map(k => [k,process.env[k]]));
  Object.assign(process.env,keys);
  t.after(() => {for (const [k,v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;});
  let received;
  const {s,sent,browser} = setup(t,{inspect:async(_,url,options) => {
    received=options;
    return {...require('./src/ctv/caption-review').evaluateCaptions({personalEvidence:true,posts:['Áo CK đủ size']}),provider:'myjoy',model:options.myjoyBackend,url,recipientId:recipientId(url)};
  }});
  const body = {...input(['https://facebook.com/123']),assessmentMode:'myjoy',myjoyBackend:'chat-model',password:'SHOULD_NOT_SAVE'};
  assert.throws(()=>s.create(body,'other'),/Chưa cấu hình/);
  assert.throws(()=>s.create({...body,myjoyBackend:''},'owner'),/Cần chọn AI/);
  const c = s.create(body,'owner');
  assert.equal(sent.length,0); assert.equal(received,undefined);
  s.approveImport(c.id,'owner'); await settle(s);
  assert.equal(received.owner,'owner'); assert.equal(received.myjoyBackend,'chat-model'); assert.equal(received.assessmentMode,'myjoy');
  assert.equal(c.leads[0].state,'review'); assert.equal(sent.length,0);
  s.approveAnalysis(c.id,'owner',[c.leads[0].id]); assert.equal(c.state,'message_review'); assert.equal(sent.length,0);
  const restored = new CtvService({file:s.file,browser}).get(c.id,'owner');
  assert.equal(restored.myjoyBackend,'chat-model');
  assert.ok(!fs.readFileSync(s.file,'utf8').includes('test-secret')); assert.ok(!JSON.stringify(c).includes('SHOULD_NOT_SAVE'));
  c.leads[0].assessment.collectionBlocked=true;
  assert.match(s.selectionBlocked(c.leads[0]),/Chưa đọc được caption/);
});

test('MyJoy backend discovery forwards owner to the worker without filtering models by Facebook profile', async () => {
  let handler, forwarded;
  mountCtv({all(_path,fn){handler=fn;}},{remote:true,getLocalUrl:()=> 'https://worker.example',apiKey:'local-test',permissions:{getAllowedProfileKeys:()=>['fb-test']},fetchFn:async(url,options)=>{
    forwarded={url,options};return {ok:true,status:200,json:async()=>({backends:[{id:'model',label:'Model',available:true}]})};
  }});
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
  await handler({path:'/api/ctv/myjoy/backends',method:'GET',user:{email:'owner'}},response);
  assert.equal(response.statusCode,200);assert.equal(response.data.backends[0].id,'model');
  assert.equal(forwarded.options.headers['x-ctv-owner'],'owner');assert.equal(forwarded.url,'https://worker.example/api/ctv/myjoy/backends');
  await handler({path:'/api/ctv/myjoy/backends',method:'POST',user:{email:'owner'}},response);assert.equal(response.statusCode,405);
  await handler({path:'/api/ctv/myjoy/backends',method:'GET'},response);assert.equal(response.statusCode,401);
});

test('adding a caption brand persists scoped aliases and re-highlights without rescan or approval changes',async t=>{
  const {s,browser,inspected,sent}=setup(t);
  const c=s.create({...input(['https://facebook.com/123']),assessmentMode:'keywords'},'owner');
  const base=require('./src/ctv/caption-review').evaluateCaptions({personalEvidence:true,posts:['Hermès Un Jardin có sẵn','PATRICK TA son mới']});
  Object.assign(c,{state:'message_review',approvals:{import:{by:'owner'},analysis:{leadIds:[c.leads[0].id]}}});
  c.leads[0].assessment={...base,name:'Test',recipientId:'123'};c.leads[0].state='review';
  const approvals=JSON.stringify(c.approvals);
  s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'Hermès',name:'Hermès'});
  s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'Hermès',name:'Hermès'});
  assert.equal(s.data.brandAliases.length,1);assert.ok(c.leads[0].assessment.brands.includes('Hermès'));
  assert.ok(c.leads[0].assessment.captionReviews[0].spans.some(x=>x.label==='Hermès'));
  assert.equal(c.leads[0].assessment.recipientId,'123');assert.equal(c.leads[0].assessment.eligible,false);
  assert.equal(c.state,'message_review');assert.equal(JSON.stringify(c.approvals),approvals);
  assert.equal(inspected.length,0);assert.equal(sent.length,0);
  const restored=new CtvService({file:s.file,browser});
  assert.equal(restored.customBrands(c).length,1);assert.equal(restored.customBrands({...c,owner:'other'}).length,0);assert.equal(restored.customBrands({...c,profile:'other'}).length,0);
  assert.ok(restored.listCustomers('owner')[0].assessment.brands.includes('Hermès'));
  assert.throws(()=>s.addBrand(c.id,'other',{leadId:c.leads[0].id,alias:'Hermès',name:'Hermès'}),/Không tìm/);
  assert.throws(()=>s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'missing',name:'Test'}),/nguyên văn/);
  assert.throws(()=>s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'Hermès',name:'Other'}),/đã thuộc/);
  assert.throws(()=>s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'Hermès',name:'<script>'}),/HTML/);
  c.state='sending';assert.throws(()=>s.addBrand(c.id,'owner',{leadId:c.leads[0].id,alias:'Hermès',name:'Hermès'}),/chờ/);
});
