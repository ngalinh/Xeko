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
  const browser={withPage:async(p,fn)=>fn({}),inspect:async(_,url)=>{inspected.push(url);return {url,actualUrl:url,name:'Khách '+recipientId(url),eligible:true,recipientId:recipientId(url)};},send:async(_,a,m,reserve)=>{reserve();sent.push({id:a.recipientId,message:m});return {state:'sent'};},...overrides};
  const s=new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}});
  return {s,sent,inspected,browser,dir};
}
const settle = s => Promise.all([...s.running]);
async function analyzed(s,urls){const c=s.create(input(urls),'owner');s.approveImport(c.id,'owner');await settle(s);return c;}
function prepared(s,c){s.approveAnalysis(c.id,'owner',c.leads.map(l=>l.id));s.prepareMessages(c.id,'owner','Chào {name}, mời bạn hợp tác CTV.');return c.messagePreview.token;}

test('canonical URLs reject external, non-profile and malformed links',()=>{
  assert.equal(profileUrl('https://m.facebook.com/Example/?ref=x'),'https://www.facebook.com/example');assert.equal(recipientId('https://facebook.com/profile.php?id=123&ref=x'),'123');
  for(const url of ['https://facebook.com.evil.test/a','http://facebook.com/a','https://facebook.com/groups/a','https://facebook.com/a/posts/1','https://facebook.com/share/1','https://facebook.com:8080/a','https://u:p@facebook.com/a','https://facebook.com/profile.php?id=x'])assert.throws(()=>profileUrl(url));
});
const snapshot={personalEvidence:true,pageEvidence:false,posts:['Our shop has stock. Shipping to USA. Order today.']};
test('qualification requires sales and US evidence, not currency or residence',()=>{
  assert.equal(classify(snapshot).eligible,true);
  for(const s of [{...snapshot,blocked:'locked'},{...snapshot,pageEvidence:true},{...snapshot,personalEvidence:false},{...snapshot,posts:['I live in USA.','Order today for $20.']},{...snapshot,posts:['Nhận order hàng Mỹ về Việt Nam']}])assert.equal(classify(s).eligible,false);
  assert.throws(()=>renderMessage('Chào {brand}','A'));assert.equal(renderMessage('Chào {name}','$&'),'Chào $&');
});
test('AI must ground evidence and pass confidence and DOM gates',async()=>{
  const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test-only';
  const response=result=>async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]})});
  const good={profileType:'personal',sellerUS:'yes',confidence:.95,reason:'Bán cho Mỹ',evidence:[snapshot.posts[0]]};
  try{assert.equal((await evaluateProfile(snapshot,response(good))).eligible,true);
    for(const patch of [{evidence:['fabricated seller US evidence']},{confidence:.7}])assert.equal((await evaluateProfile(snapshot,response({...good,...patch}))).eligible,false);
    assert.equal((await evaluateProfile({...snapshot,pageEvidence:true},response(good))).eligible,false);
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
test('unqualified, unknown recipients, nonexistent IDs and alias duplicates cannot be approved',async t=>{
  const {s}=setup(t);const c=await analyzed(s);const lead=c.leads[0];
  lead.assessment.eligible=false;assert.throws(()=>s.approveAnalysis(c.id,'owner',[lead.id]));lead.assessment.eligible=true;
  lead.assessment.recipientId=null;assert.throws(()=>s.approveAnalysis(c.id,'owner',[lead.id]));assert.throws(()=>s.approveAnalysis(c.id,'owner',['fake']));
  lead.assessment.recipientId=c.leads[1].assessment.recipientId;assert.throws(()=>s.approveAnalysis(c.id,'owner',c.leads.map(l=>l.id)));
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
  const d=await analyzed(restored);assert.throws(()=>restored.approveAnalysis(d.id,'owner',[d.leads[0].id]));
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
  for(const action of ['approve-import','approve-analysis','review-analysis','prepare-messages','send','stop']){
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
