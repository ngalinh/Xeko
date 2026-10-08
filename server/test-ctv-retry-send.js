const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { CtvService } = require('./src/ctv/service');
const { mountCtv } = require('./src/ctv/routes');
function setup(t, uncertain = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ctv-retry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=[], browser={withPage:async(_,fn)=>fn({}),send:async(_,lead,text,reserve,cancel,images)=>{reserve();sent.push({id:lead.recipientId,text,images});return {state:'sent'};}};
  const s=new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}});
  const c=s.create({profile:'test',urls:['https://facebook.com/123','https://facebook.com/456']},'owner');
  c.state='needs_attention';c.leads.forEach((l,i)=>{l.assessment={recipientId:i?'456':'123',criteriaVersion:'us-website-products-v2'};l.state=i?'sent':uncertain?'unconfirmed':'review';});
  c.leads[0].error='Target browser has been closed';c.approvals={import:{},analysis:{leadIds:c.leads.map(l=>l.id)},send:{token:'approved'}};
  c.messagePreview={token:'approved',images:[],messages:c.leads.map(l=>({leadId:l.id,recipientId:l.assessment.recipientId,url:l.url,message:'Hello '+l.assessment.recipientId}))};
  s.data.reservations['456']={campaignId:c.id,at:'previous'};
  if(uncertain)s.data.reservations['123']={campaignId:c.id,at:'uncertain'};
  s.save();
  const request=(extra={})=>({leadId:c.leads[0].id,previewToken:'approved',requestId:crypto.randomUUID(),...extra});
  return {s,c,browser,sent,request};
}
const settle=s=>Promise.all([...s.running]);
test('retry sends only requested recipient, preserving approved text/images and successful leads',async t=>{
  const {s,c,sent,request}=setup(t);c.messagePreview.images=[{name:'image',dataUrl:'approved image'}];
  const req=request();assert.equal(s.view(c).leads[0].retryAvailable,true);assert.equal(s.view(c).leads[1].retryAvailable,false);
  s.retrySend(c.id,'owner',req);s.retrySend(c.id,'owner',req);await settle(s);s.retrySend(c.id,'owner',req);
  assert.equal(sent.length,1);assert.equal(sent[0].id,'123');assert.equal(sent[0].text,'Hello 123');assert.deepEqual(sent[0].images,c.messagePreview.images);
  assert.equal(c.leads[1].state,'sent');assert.equal(c.state,'completed');assert.equal(c.leads[0].retryHistory.length,1);
  assert.throws(()=>s.retrySend(c.id,'owner',request()));
});
test('uncertain retry requires explicit no-delivery confirmation and holds reservation while queued',async t=>{
  const {s,c,request,sent}=setup(t,true),old=s.data.reservations['123'];
  assert.equal(s.view(c).leads[0].retryNeedsConfirmation,true);
  assert.throws(()=>s.retrySend(c.id,'owner',request()),/kiểm tra Messenger/);
  assert.throws(()=>s.retrySend(c.id,'owner',request({confirmedNotReceived:'true'})));
  s.retrySend(c.id,'owner',request({confirmedNotReceived:true}));assert.equal(s.data.reservations['123'],old);
  await settle(s);assert.equal(sent.length,1);assert.equal(c.leads[0].state,'sent');
  assert.equal(c.leads[0].retryHistory[0].previousState,'unconfirmed');
});
test('retry gates owner, token, recipient, active state and other campaign reservations',t=>{
  const {s,c,request}=setup(t);
  assert.throws(()=>s.retrySend(c.id,'other',request()));assert.throws(()=>s.retrySend(c.id,'owner',request({previewToken:'stale'})));
  assert.throws(()=>s.retrySend(c.id,'owner',request({leadId:'missing'})));assert.throws(()=>s.retrySend(c.id,'owner',request({requestId:'bad'})));
  c.leads[0].assessment.recipientId='999';assert.throws(()=>s.retrySend(c.id,'owner',request()));c.leads[0].assessment.recipientId='123';
  c.state='sending';assert.throws(()=>s.retrySend(c.id,'owner',request()));c.state='needs_attention';
  s.data.reservations['123']={campaignId:'another',at:'other'};
  assert.equal(s.view(c).leads[0].retryAvailable,false);assert.throws(()=>s.retrySend(c.id,'owner',request({confirmedNotReceived:true})),/chiến dịch khác/);
});
test('changed reservation while queued prevents retry without removing the newer reservation',async t=>{
  const {s,c,request,sent}=setup(t,true);
  s.retrySend(c.id,'owner',request({confirmedNotReceived:true}));
  s.data.reservations['123']={campaignId:'another',at:'new'};await settle(s);
  assert.equal(sent.length,0);assert.equal(s.data.reservations['123'].campaignId,'another');
});
test('failed retry after submission stays uncertain and requires a fresh manual confirmation',async t=>{
  const {s,c,browser,request}=setup(t);let calls=0;
  browser.send=async(_,lead,text,reserve)=>{calls++;reserve();throw Error('connection lost');};
  const req=request();s.retrySend(c.id,'owner',req);await settle(s);
  assert.equal(c.leads[0].state,'unconfirmed');assert.ok(s.data.reservations['123']);
  s.retrySend(c.id,'owner',req);await settle(s);assert.equal(calls,1);
  assert.throws(()=>s.retrySend(c.id,'owner',request()),/kiểm tra Messenger/);
});
test('stopping queued retry and restarting cannot automatically resend',async t=>{
  const {s,c,browser,request,sent}=setup(t,true),req=request({confirmedNotReceived:true});
  s.retrySend(c.id,'owner',req);s.stop(c.id,'owner');await settle(s);assert.equal(sent.length,0);assert.equal(c.state,'cancelled');
  c.state='send_queued';s.save();const restored=new CtvService({file:s.file,browser});
  assert.equal(restored.get(c.id,'owner').state,'interrupted');assert.equal(restored.running.size,0);assert.ok(restored.data.reservations['123']);
});
test('retrying one lead does not mark a campaign complete when another approved lead remains',async t=>{
  const {s,c,request,sent}=setup(t);c.leads[1].state='qualified';delete s.data.reservations['456'];
  // This scenario needs a never-sent second lead, including its durable snapshot.
  delete s.data.customers[`${c.id}:${c.leads[1].id}`];
  s.retrySend(c.id,'owner',request());await settle(s);
  assert.equal(sent.length,1);assert.equal(c.state,'needs_attention');assert.equal(s.view(c).leads[1].retryAvailable,true);
});
test('retry API returns accepted, checks owner and rejects cloud profile spoofing',async t=>{
  const {s,c,request}=setup(t);let handler;
  mountCtv({all:(_,h)=>handler=h},{service:s});
  const response=()=>({code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
  const req={path:`/api/ctv/campaigns/${c.id}/retry-send`,method:'POST',body:request(),headers:{'x-ctv-owner':'other'}};
  let res=response();await handler(req,res);assert.equal(res.code,404);
  req.headers['x-ctv-owner']='owner';res=response();await handler(req,res);assert.equal(res.code,202);await settle(s);
  let forwarded=0;
  mountCtv({all:(_,h)=>handler=h},{remote:true,getLocalUrl:()=> 'https://worker.invalid',permissions:{getAllowedProfileKeys:()=>['forbidden']},fetchFn:async()=>{forwarded++;return {ok:true,json:async()=>({profile:'test'})};}});
  res=response();await handler({...req,user:{email:'owner'},body:{...request(),profile:'forbidden'}},res);
  assert.equal(res.code,403);assert.equal(forwarded,1);
});
