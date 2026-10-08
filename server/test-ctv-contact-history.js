const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { contactHistory } = require('./src/ctv/contact-history');
const { CtvService } = require('./src/ctv/service');
const url = name => 'https://www.facebook.com/' + name;
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-dedupe-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return new CtvService({file:path.join(dir,'data.json'),browser:{},pause:async()=>{}});
}
test('joins known URL aliases and UID; unknown profiles remain available', () => {
  const data = {customers:{a:{url:url('alice'),assessment:{recipientId:'123',actualUrl:url('alice.new')},sent:true},b:{url:url('alias'),uid:'123'}},reservations:{456:{}}};
  const history=contactHistory(data);
  for (const value of [url('alice'),url('alice.new'),url('alias'),'https://m.facebook.com/profile.php?id=123&ref=abc',url('456')]) assert.equal(history.has({url:value}),true);
  assert.equal(history.has({url:url('new')}),false);
  assert.equal(history.key({url:url('alias')}),history.key({url:url('123')}));
});
test('import filters sent and uncertain across sending accounts, even after deletion and restart', t => {
  let s=setup(t);
  const c=s.create({profile:'first',urls:[url('alice'),url('bob')]},'owner');
  c.leads[0].state='sent'; c.leads[0].assessment={recipientId:'123',actualUrl:url('alice.new')};
  c.leads[1].state='unconfirmed'; s.save(); s.deleteCampaign(c.id,'owner');
  s=new CtvService({file:s.file,browser:{}});
  const next=s.create({profile:'second',urls:[url('alice'),url('123'),url('bob'),url('new'),url('new')+'?ref=1']},'owner');
  assert.deepEqual(next.leads.map(l=>l.url),[url('new')]);
  assert.equal(next.previouslyContacted.length,2); assert.equal(next.duplicateCount,2);
  assert.ok(s.listCustomers('owner').filter(r=>r.url!==url('new')).every(r=>r.sendBlocked));
});
test('known unsent aliases are merged without deleting customer data', t => {
  const s=setup(t);
  s.data.customers={a:{url:url('alice'),uid:'123'},b:{url:url('alias'),uid:'123'}};
  const c=s.create({profile:'first',urls:[url('alice'),url('alias'),url('123')]},'owner');
  assert.equal(c.leads.length,1); assert.equal(c.duplicateCount,2); assert.equal(c.previouslyContacted.length,0);
  assert.ok(s.data.customers.a && s.data.customers.b);
});
test('a newly discovered UID is blocked at approval even when original alias was unknown', t => {
  const s=setup(t); s.data.reservations['123']={campaignId:'old'};
  const c=s.create({profile:'first',urls:[url('unknown.alias')]},'owner');
  c.state='analysis_review';c.approvals.import={};
  c.leads[0].assessment={recipientId:'123',criteriaVersion:'us-website-products-v2'};
  assert.throws(()=>s.approveAnalysis(c.id,'owner',[c.leads[0].id]),/liên hệ/);
});
test('history changed while browser opens is rechecked before submit', async t => {
  const s=setup(t), c=s.create({profile:'first',urls:[url('alice')]},'owner'), lead=c.leads[0];
  lead.assessment={recipientId:'123',actualUrl:url('alice'),criteriaVersion:'us-website-products-v2'};
  c.messagePreview={images:[],messages:[{leadId:lead.id,recipientId:'123',message:'Hi'}]};
  let submitted=false;
  s.browser={withPage:async(_,fn)=>fn({}),send:async(_,assessment,message,reserve)=>{
    s.data.customers.other={url:url('alice'),sent:true};
    reserve(); submitted=true; return {state:'sent'};
  }};
  await s.send(c);
  assert.equal(submitted,false);assert.equal(c.state,'needs_attention');
});
test('manual retry may bypass its own uncertain reservation but never confirmed delivery or another campaign', () => {
  const data={customers:{a:{url:url('alice'),uid:'123',state:'unconfirmed',campaignId:'same'}},reservations:{123:{campaignId:'same'}}};
  assert.equal(contactHistory(data,{retryCampaignId:'same'}).has({url:url('alice')}),false);
  data.customers.a.sent=true;
  assert.equal(contactHistory(data,{retryCampaignId:'same'}).has({url:url('alice')}),true);
  data.customers.a.sent=false;data.reservations['123'].campaignId='other';
  assert.equal(contactHistory(data,{retryCampaignId:'same'}).has({url:url('alice')}),true);
});
