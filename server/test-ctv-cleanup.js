const test = require('node:test');
const assert = require('node:assert/strict');
const { CtvService } = require('./src/ctv/service');
const { createBrowserAdapter } = require('./src/ctv/browser');

for (const outcome of ['success', 'failure', 'cancelled']) {
  test(`analysis closes its profile browser after ${outcome}`, async () => {
    const closed = [];
    const service = Object.create(CtvService.prototype);
    service.save = () => {};
    service.wait = async () => {};
    service.browser = {
      withPage: async (_, fn) => fn({}),
      inspect: async () => {
        if (outcome === 'failure') throw Error('AI failed');
        return {eligible:false};
      },
      closeInspection: async profile => closed.push(profile),
    };
    const campaign = {profile:'account-a',cancelled:outcome==='cancelled',leads:[{url:'https://facebook.com/123'}]};
    await service.analyze(campaign);
    assert.deepEqual(closed,['account-a']);
    assert.equal(campaign.state,'analysis_review');
    if (outcome === 'failure') assert.equal(campaign.error,'AI failed');
  });
}

test('adapter closes only the inspected context and recreates the inspection tab', async () => {
  let closed=0, created=0;
  const context = {close:async()=>{closed++;},newPage:async()=>{
    created++;
    return {isClosed:()=>false,context:()=>context};
  }};
  const adapter = createBrowserAdapter({profileExists:()=>true,getBrowser:async()=>context});
  await adapter.withPage('a',async()=>{}, {keepOpen:true});
  await adapter.closeInspection('other-account');
  assert.equal(closed,0);
  await adapter.closeInspection('a');
  await adapter.closeInspection('a');
  assert.equal(closed,1);
  await adapter.withPage('a',async()=>{}, {keepOpen:true});
  assert.equal(created,2);
});

test('context is tracked for cleanup even if newPage fails', async () => {
  let closed=false;
  const adapter=createBrowserAdapter({profileExists:()=>true,getBrowser:async()=>({
    newPage:async()=>{throw Error('tab failed');},close:async()=>{closed=true;},
  })});
  await assert.rejects(adapter.withPage('a',async()=>{}, {keepOpen:true}),/tab failed/);
  await adapter.closeInspection('a');
  assert.equal(closed,true);
});
