const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { queuePost, getQueuedProfile } = require('./src/utils/post-queue');
const { CtvService } = require('./src/ctv/service');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const tick = () => new Promise(r => setImmediate(r));

test('same account is FIFO, different accounts overlap, failures release the slot', async () => {
  const hold = deferred(), events = [];
  const a = queuePost(async () => { events.push('A:start'); await hold.promise; events.push('A:end'); }, 'A');
  const next = queuePost(() => events.push('A:next'), 'A');
  const b = queuePost(() => events.push('B'), 'B');
  await b;
  assert.deepEqual(events, ['A:start', 'B']);
  hold.resolve(); await Promise.all([a, next]);
  assert.deepEqual(events, ['A:start', 'B', 'A:end', 'A:next']);
  await assert.rejects(queuePost(() => { throw Error('failed'); }, 'A'), /failed/);
  assert.equal(await queuePost(() => getQueuedProfile(), 'A'), 'A');
  assert.equal(getQueuedProfile(), null);
});

test('real CTV campaign waits behind a post on A, while campaign B can scan', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeko-account-queue-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const hold = deferred(), scans = [];
  const posting = queuePost(() => hold.promise, 'CTV-A');
  const s = new CtvService({file:path.join(dir,'campaigns.json'), queue:queuePost, pause:async()=>{}, browser:{
    withPage:async (profile, fn) => { assert.equal(getQueuedProfile(), profile); return fn({profile}); },
    inspect:async page => { scans.push(page.profile); return {eligible:false}; },
  }});
  const a = s.create({profile:'CTV-A', urls:['https://facebook.com/123']}, 'owner');
  const b = s.create({profile:'CTV-B', urls:['https://facebook.com/456']}, 'owner');
  s.approveImport(a.id,'owner'); s.approveImport(b.id,'owner');
  await tick();
  assert.deepEqual(scans, ['CTV-B']);
  assert.equal(a.state, 'analysis_queued');
  s.stop(a.id,'owner');
  hold.resolve(); await posting; await Promise.all([...s.running]);
  assert.deepEqual(scans, ['CTV-B']);
});

function loadModule(file, overrides, globals = {}) {
  const filename = path.join(__dirname,file), mod = {exports:{}};
  const sandbox = {module:mod, exports:mod.exports, __dirname:path.dirname(filename), Buffer, URL, AbortSignal,
    process:{env:{LOCAL_API_KEY:'test-only', PLAYWRIGHT_LOCAL_URL:'https://worker.test'}},
    setTimeout, clearTimeout, console,
    require:name => Object.hasOwn(overrides,name) ? overrides[name] : require(name), ...globals};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), sandbox, {filename});
  return mod.exports;
}

test('browser selection stays bound to each job across awaits and UI profile changes', async () => {
  const launched = [], hold = deferred();
  const post = loadModule('src/playwright/post.js', {
    '../utils/playwright-launch':{safeLaunchPersistentContext:async dir => { launched.push(path.basename(dir)); return {once:()=>{}}; }},
    '../utils/post-queue':{getQueuedProfile}, '../utils/clipboard-queue':require('./src/utils/clipboard-queue'),
    fs:{existsSync:()=>true}, '../../config/default':{playwright:{}},
    '../utils/logger':{info:()=>{}}, '../utils/delay':{}, '../utils/fun-messages':{},
    '../utils/proxy':{getFbProxyForProfile:()=>null},
    '../utils/device-fingerprint':{getProfileDeviceFingerprint:()=>({})}, '../utils/proxy-health':{},
  });
  post.setProfile('UI');
  const a = queuePost(async () => {
    post.setProfile('browser-A'); await hold.promise;
    assert.equal(post.getActiveProfile().key,'browser-A');
    await post.getBrowser();
    assert.throws(() => post.setProfile('browser-B'), /đổi tài khoản/);
  },'browser-A');
  const b = queuePost(async () => { await post.getBrowser(); }, 'browser-B');
  await b; post.setProfile('UI-new'); hold.resolve(); await a;
  assert.deepEqual(launched,['browser-B','browser-A']);
  assert.equal(post.getActiveProfile().key,'UI-new');
});

test('proxy sends explicit account for every posting target without changing worker selection', async () => {
  const requests = [];
  const proxy = loadModule('playwright-proxy.js', {
    'form-data':class {}, './src/utils/post-queue':{getQueuedProfile}, './src/utils/api-key':{assertConfigured:()=>{}},
  }, {fetch:async (url, options) => { requests.push({url, data:JSON.parse(options.body)}); return {text:async()=>'{"success":true}'}; }});
  await Promise.all(['proxy-A','proxy-B'].map(profile => queuePost(async () => {
    await proxy.setProfile(profile);
    await proxy.postToPersonal('hello'); await proxy.postToGroup('123','hello');
    await proxy.postToPage('456','hello'); await proxy.postPersonalAndShareToGroups('hello');
    await proxy.quickPostToPersonalAndGroups('hello'); await proxy.scrapePost('https://facebook.com/123');
    await proxy.postComment({postUrl:'https://facebook.com/123',message:'hello',profile});
  },profile)));
  assert.equal(requests.length,14);
  assert.ok(requests.every(r => !r.url.endsWith('/api/profile')));
  for (const profile of ['proxy-A','proxy-B']) assert.equal(requests.filter(r=>r.data.profile===profile).length,7);
});

test('proxy keeps polling through a long worker queue without spending execution timeout', async () => {
  let now=0, polls=0;
  const proxy=loadModule('playwright-proxy.js',{
    'form-data':class {}, './src/utils/post-queue':{getQueuedProfile}, './src/utils/api-key':{assertConfigured:()=>{}},
  },{
    Date:{now:()=>now}, setTimeout:fn=>{now+=60000;fn();},
    fetch:async url=>({text:async()=>JSON.stringify(url.endsWith('/api/post') ? {jobId:'test'} :
      ++polls<=12 ? {status:'pending',queued:true} : {status:'done',result:{success:true}})}),
  });
  const result=await queuePost(()=>proxy.postToPersonal('hello'),'poll-account');
  assert.equal(result.success,true);assert.equal(polls,13);assert.ok(now>10*60000);
});

test('clipboard write and paste are atomic across independent accounts', async () => {
  const { fillComposerCaption } = require('./src/playwright/fb-caption');
  let clipboard='';
  function editorFor(message) {
    let value='';
    return {page:{evaluate:async(_,text)=>{clipboard=text;await tick();},waitForTimeout:async()=>{}}, editor:{
      scrollIntoViewIfNeeded:async()=>{}, innerText:async()=>value, click:async()=>{},
      press:async key=>{if(key==='ControlOrMeta+v')value=clipboard;},
      fill:async()=>{throw Error('wrong paste for '+message);},
    }};
  }
  const a=editorFor('Caption A'),b=editorFor('Caption B');
  assert.deepEqual(await Promise.all([
    queuePost(()=>fillComposerCaption(a.page,a.editor,'Caption A'),'caption-A'),
    queuePost(()=>fillComposerCaption(b.page,b.editor,'Caption B'),'caption-B'),
  ]),[true,true]);
});

test('worker HTTP post shares account queue with scans and cancels before browser work', async () => {
  const source=fs.readFileSync(path.join(__dirname,'local-server.js'),'utf8');
  const start=source.indexOf("app.post('/api/post',"), end=source.indexOf('// ===== DO-COMMENT',start);
  const helper=source.slice(source.indexOf('function queueWorkerJob('),source.indexOf('function setJobResult('));
  const jobs=new Map(), calls=[], timers=[], running=[], cleaned=[];let handler, counter=0;
  const cancelled=new Set();
  const context={
    app:{post:(_url,_upload,fn)=>{handler=fn;}},upload:{array:()=>{}},
    queuePost:(fn,profile)=>{const p=queuePost(fn,profile);running.push(p);return p;},
    postJobs:jobs, cancelledFbJobIds:cancelled,
    playwright:{profileExists:()=>true, getActiveProfile:()=>({key:'wrong-default'}),postToPersonal:async()=>{calls.push(getQueuedProfile());return {success:true};}},
    rateLimit:{check:()=>({ok:true})},cleanupFiles:files=>cleaned.push(files),
    createJob:()=>{const id=String(++counter);jobs.set(id,{status:'pending'});return id;},
    setJobResult:(id,result)=>jobs.set(id,{status:'done',result}),setJobError:(id,error)=>jobs.set(id,{status:'failed',error}),
    setTimeout:()=>{timers.push(getQueuedProfile());return timers.length;},clearTimeout:()=>{},
    require:()=>({}),logger:{info:()=>{},error:()=>{}},Date,
  };
  vm.runInNewContext(helper+'\n'+source.slice(start,end),context);
  const hold=deferred(), scan=queuePost(()=>hold.promise,'worker-A');
  const response={json:()=>{},status(){return this;},setHeader:()=>{}};
  await handler({body:{profile:'worker-A',message:'A'},files:[]},response);
  await handler({body:{profile:'worker-B',message:'B'},files:[]},response);
  await tick();
  assert.deepEqual(calls,['worker-B']);assert.deepEqual(timers,['worker-B']);
  assert.equal(jobs.get('1').queued,true);
  cancelled.add('1');hold.resolve();await scan;await Promise.all(running);
  assert.deepEqual(calls,['worker-B']);assert.equal(jobs.get('1').result.cancelled,true);
  assert.equal(cleaned.length,2);
});
