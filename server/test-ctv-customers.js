const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CtvService } = require('./src/ctv/service');
const { mountCtv } = require('./src/ctv/routes');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-customers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CtvService({ file: path.join(dir, 'data.json'), browser: {} });
}
const create = (s, owner = 'owner', profile = 'account') => s.create({ name: 'Saved campaign', profile, urls: ['https://facebook.com/example.customer'] }, owner);
test('customer information survives retry clearing, campaign deletion and restart', t => {
  const s = setup(t), c = create(s), lead = c.leads[0];
  lead.assessment = { name: 'Saved name', bio: 'Saved bio', recipientId: '123', eligible: true };
  s.save(); delete lead.assessment; s.save();
  assert.equal(s.listCustomers('owner')[0].assessment.bio, 'Saved bio');
  s.deleteCampaign(c.id, 'owner');
  const restored = new CtvService({ file: s.file, browser: {} });
  assert.equal(restored.data.campaigns.length, 0);
  assert.equal(restored.listCustomers('owner')[0].assessment.recipientId, '123');
});
test('groups repeat imports by URL and account, isolates owners and preserves sent fact', t => {
  const s = setup(t), first = create(s); first.leads[0].state = 'sent'; s.save();
  create(s); create(s, 'owner', 'other'); create(s, 'someone-else');
  const rows = s.listCustomers('owner');
  assert.equal(rows.length, 2);
  const row = rows.find(r => r.profile === 'account');
  assert.equal(row.campaigns.length, 2); assert.equal(row.sent, true);
  assert.equal(s.listCustomers('someone-else').length, 1);
  assert.equal(s.listCustomers('unknown').length, 0);
});
test('unconfirmed sends are never counted as sent and unchanged saves retain timestamps', t => {
  const s = setup(t), c = create(s); c.leads[0].state = 'unconfirmed'; s.save();
  const before = s.listCustomers('owner')[0]; s.save();
  assert.equal(before.sent, false); assert.equal(s.listCustomers('owner')[0].updatedAt, before.updatedAt);
});
test('existing campaigns backfill on startup without contacting a browser', t => {
  const s = setup(t), c = create(s); delete s.data.customers;
  fs.writeFileSync(s.file, JSON.stringify(s.data));
  const restored = new CtvService({ file: s.file, browser: {} });
  assert.equal(restored.listCustomers('owner')[0].campaigns[0].id, c.id);
});
async function request(options, req = {}) {
  let handler; mountCtv({ all: (_, h) => { handler = h; } }, options);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ path: '/api/ctv/customers', method: 'GET', headers: { 'x-ctv-owner': 'owner' }, ...req }, res);
  return res;
}
test('customer endpoint enforces authentication, owner and allowed account in direct mode', async t => {
  const s = setup(t); create(s); create(s, 'owner', 'forbidden'); create(s, 'other');
  assert.equal((await request({ service: s }, { headers: {} })).code, 401);
  assert.equal((await request({ service: s }, { method: 'PUT' })).code, 405);
  const res = await request({ service: s, remote: true, permissions: { getAllowedProfileKeys: () => ['account'] } }, { user: { email: 'owner' } });
  assert.equal(res.body.length, 1); assert.equal(res.body[0].profile, 'account');
});
test('cloud forwarding propagates owner and filters forbidden accounts', async () => {
  let captured;
  const res = await request({ remote: true, getLocalUrl: () => 'https://worker.test', apiKey: 'test', permissions: { getAllowedProfileKeys: () => ['allowed'] },
    fetchFn: async (url, options) => { captured = { url, options }; return { status: 200, json: async () => [{ profile: 'allowed' }, { profile: 'forbidden' }] }; } }, { user: { email: 'owner' } });
  assert.equal(captured.url, 'https://worker.test/api/ctv/customers');
  assert.equal(captured.options.headers['x-ctv-owner'], 'owner');
  assert.deepEqual(res.body, [{ profile: 'allowed' }]);
});

test('manual customers persist without campaign, assessment, send or browser side effects', t => {
  const s=setup(t), input={profile:'account',url:'https://facebook.com/New.Customer',name:'Tên mới',uid:'1000123456',notes:'Ghi chú',sent:true,assessment:{eligible:true},owner:'intruder'};
  const row=s.addCustomer(input,'owner');assert.equal(row.manual,true);assert.equal(row.name,'Tên mới');assert.equal(row.sent,false);assert.equal(row.assessment,undefined);assert.equal(row.campaigns.length,0);assert.equal(s.data.campaigns.length,0);
  const restored=new CtvService({file:s.file,browser:{}});assert.equal(restored.listCustomers('owner')[0].notes,'Ghi chú');assert.equal(restored.listCustomers('intruder').length,0);
  assert.throws(()=>s.addCustomer({...input,url:'https://www.facebook.com/new.customer/?ref=test'},'owner'),/đã có/);
  assert.throws(()=>s.addCustomer({...input,url:'https://facebook.com/another'},'owner'),/đã có/);
  assert.doesNotThrow(()=>s.addCustomer(input,'other'));
});
test('manual validation rejects invalid profile, URL, UID and oversized text', t=>{
  const s=setup(t), input={profile:'account',url:'https://facebook.com/new.customer'};
  for(const patch of [{profile:''},{profile:'../bad'},{url:'https://evil.test/a'},{uid:'abc'},{uid:'1234'},{name:'x'.repeat(151)},{notes:'x'.repeat(2001)}])assert.throws(()=>s.addCustomer({...input,...patch},'owner'));
  assert.equal(s.listCustomers('owner').length,0);
});
test('manual POST enforces owner/profile directly and before cloud forwarding',async t=>{
  const s=setup(t),body={profile:'account',url:'https://facebook.com/new.customer',name:'New'};
  const direct=await request({service:s},{method:'POST',body});assert.equal(direct.code,201);assert.equal(direct.body.name,'New');
  assert.equal((await request({service:s},{method:'POST',body})).code,409);
  let calls=0;const options={remote:true,getLocalUrl:()=> 'https://worker.test',permissions:{getAllowedProfileKeys:()=>['account']},fetchFn:async(url,opts)=>{calls++;assert.equal(opts.headers['x-ctv-owner'],'owner');assert.equal(JSON.parse(opts.body).profile,'account');return {status:201,json:async()=>({name:'New'})};}};
  assert.equal((await request(options,{method:'POST',body:{...body,profile:'forbidden'},user:{email:'owner'}})).code,403);assert.equal(calls,0);
  assert.equal((await request(options,{method:'POST',body,user:{email:'owner'}})).code,201);assert.equal(calls,1);
});
