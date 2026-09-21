const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { profileUrl, recipientId, classify, renderMessage } = require('./src/ctv/rules');
const { evaluateProfile } = require('./src/ctv/ai');
const { CtvService } = require('./src/ctv/service');
const { mountCtv } = require('./src/ctv/routes');

test('canonicalizes profile links and rejects unrelated destinations', () => {
  assert.equal(profileUrl('https://m.facebook.com/Example/?ref=x'),'https://www.facebook.com/example');
  assert.equal(recipientId('https://facebook.com/profile.php?id=123&ref=x'),'123');
  for (const url of ['https://facebook.com.evil.test/a','http://facebook.com/a','https://facebook.com/groups/a','https://facebook.com/a/posts/1','https://facebook.com/share/1','https://facebook.com:8080/a','https://u:p@facebook.com/a','https://facebook.com/profile.php?id=x']) assert.throws(()=>profileUrl(url));
});
const snapshot = { personalEvidence:true, pageEvidence:false, posts:['Our shop has stock. Shipping to USA. Order today.'] };
test('market qualification requires actual sales and US evidence together',()=>{
  assert.equal(classify(snapshot).eligible,true);
  for (const s of [{...snapshot,blocked:'locked'},{...snapshot,pageEvidence:true},{...snapshot,personalEvidence:false},{...snapshot,posts:['I live in USA.','Order today for $20.']},{...snapshot,posts:['Nhận order hàng Mỹ về Việt Nam']}]) assert.equal(classify(s).eligible,false);
  assert.throws(()=>renderMessage('Chào {brand}','A'));
  assert.equal(renderMessage('Chào {name}','$&'),'Chào $&');
});
test('AI must provide grounded evidence and pass confidence/DOM gates',async()=>{
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY='test-only';
  const response = result => async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]})});
  const good={profileType:'personal',sellerUS:'yes',confidence:.95,reason:'Bán cho Mỹ',evidence:[snapshot.posts[0]]};
  try {
    assert.equal((await evaluateProfile(snapshot,response(good))).eligible,true);
    assert.equal((await evaluateProfile(snapshot,response({...good,evidence:['fabricated seller US evidence']}))).eligible,false);
    assert.equal((await evaluateProfile(snapshot,response({...good,confidence:.7}))).eligible,false);
    assert.equal((await evaluateProfile({...snapshot,pageEvidence:true},response(good))).eligible,false);
    await assert.rejects(()=>evaluateProfile(snapshot,response({...good,confidence:'high'})));
  } finally { if(old === undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old; }
});
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'xeko-ctv-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=[];
  const browser={withPage:async(p,fn)=>fn({}),inspect:async(_,url)=>({url,actualUrl:url,name:'Test',eligible:true,recipientId:'123'}),send:async(_,a,m,reserve)=>{reserve();sent.push(a.recipientId);return {state:'sent'};},...overrides};
  return {s:new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}}),sent,browser,dir};
}
const input = mode => ({profile:'test',mode,template:'Chào {name}',urls:['https://facebook.com/123']});
test('only eligible leads send; analyze mode never sends',async t=>{
  const {s,sent}=setup(t);const a=s.create(input('analyze'),'owner');s.start(a.id,'owner');await Promise.all(s.running);assert.equal(sent.length,0);assert.equal(a.leads[0].state,'qualified');
  const b=s.create(input('auto'),'owner');s.start(b.id,'owner');await Promise.all(s.running);assert.equal(sent.length,1);
  const c=s.create(input('auto'),'owner');s.start(c.id,'owner');await Promise.all(s.running);assert.equal(sent.length,1);assert.equal(c.leads[0].state,'duplicate');
  assert.throws(()=>s.start(b.id,'owner'));assert.throws(()=>s.get(b.id,'other'));
});
test('unqualified leads and unknown recipients do not send',async t=>{
  for (const result of [{eligible:false,recipientId:'123'},{eligible:true,recipientId:null}]) {
    const {s,sent}=setup(t,{inspect:async()=>result});const c=s.create(input('auto'),'owner');s.start(c.id,'owner');await Promise.all(s.running);assert.equal(sent.length,0);assert.equal(c.leads[0].state,'review');
  }
});
test('cancel while inspecting prevents the subsequent send',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const {s,sent}=setup(t,{inspect:async()=>{await wait;return {eligible:true,recipientId:'123'};}});
  const c=s.create(input('auto'),'owner');s.start(c.id,'owner');s.stop(c.id,'owner');release();await Promise.all(s.running);assert.equal(sent.length,0);assert.equal(c.state,'cancelled');
});
test('submission errors keep durable reservations across restarts',async t=>{
  const {s,browser,dir}=setup(t,{send:async(_,a,m,reserve)=>{reserve();throw new Error('connection lost after Enter');}});
  const c=s.create(input('auto'),'owner');s.start(c.id,'owner');await Promise.all(s.running);assert.equal(c.leads[0].state,'unconfirmed');assert.equal(c.state,'needs_attention');
  const restarted=new CtvService({file:path.join(dir,'campaigns.json'),browser,pause:async()=>{}});assert.ok(restarted.data.reservations['123']);
  const d=restarted.create(input('auto'),'owner');restarted.start(d.id,'owner');await Promise.all(restarted.running);assert.equal(d.leads[0].state,'duplicate');
});
test('AI failure stops campaign without sending',async t=>{
  const {s,sent}=setup(t,{inspect:async()=>{throw new Error('AI unavailable');}});const c=s.create(input('auto'),'owner');s.start(c.id,'owner');await Promise.all(s.running);assert.equal(c.state,'needs_attention');assert.equal(sent.length,0);
});
test('cloud route rejects missing identity and unauthorized profile before work',async()=>{
  let handler;mountCtv({all:(p,h)=>handler=h},{remote:true,permissions:{getAllowedProfileKeys:()=>['allowed']}});
  const res={code:200,status(n){this.code=n;return this;},json(d){this.data=d;return this;}};
  await handler({path:'/api/ctv/campaigns',method:'POST',body:{},headers:{}},res);assert.equal(res.code,401);
  // A configured worker keeps this check from initializing local storage/browser.
  mountCtv({all:(p,h)=>handler=h},{remote:true,getLocalUrl:()=> 'https://worker.invalid',permissions:{getAllowedProfileKeys:()=>['allowed']}});
  await handler({path:'/api/ctv/campaigns',method:'POST',body:{profile:'forbidden'},user:{email:'owner'},headers:{}},res);assert.equal(res.code,403);
});
