const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createGroupPostPacer, readGap } = require('./src/utils/zalo-group-pacing');
function setup(options = {}) {
  let clock = 1000;
  const waits = [];
  const pace = createGroupPostPacer({ now: () => clock, pause: async ms => { waits.push(ms); clock += ms; }, ...options });
  return { pace, waits, now: () => clock, advance: ms => { clock += ms; } };
}

test('same group waits 60 seconds after a long attempt, even with another account', async () => {
  const h = setup();
  const starts = [];
  await h.pace('Group A', async () => { starts.push(h.now()); h.advance(120000); return 'A'; });
  assert.equal(await h.pace(' Group A ', () => { starts.push(h.now()); return 'B'; }), 'B');
  assert.deepEqual(starts, [1000, 181000]);
  assert.equal(h.waits.reduce((a,b) => a+b,0), 60000);
});

test('queued same-group jobs serialize; different groups can run', async () => {
  const h = setup(); const events = [];
  let release;
  const hold = new Promise(r => { release = r; });
  const a = h.pace('A', async () => { events.push('A'); await hold; });
  const b = h.pace('A', () => events.push('A2'));
  await h.pace('B', () => events.push('B'));
  assert.deepEqual(events, ['A','B']);
  release(); await Promise.all([a,b]);
  assert.deepEqual(events, ['A','B','A2']);
  assert.equal(h.now(),61000);
});

test('failures preserve gap and do not block later jobs', async () => {
  const h = setup({gapMs:30000});
  await assert.rejects(h.pace('A', () => { throw Error('upload unknown'); }), /unknown/);
  await h.pace('A', () => 'next');
  assert.equal(h.now(),31000);
});

test('cancel during wait stops within a one-second slice without resetting gap', async () => {
  const h=setup(); await h.pace('A',()=>{});
  const result=await h.pace('A',()=>assert.fail('must not open browser'),()=>h.now()>=2000);
  assert.equal(result.cancelled,true); assert.equal(h.now(),2000);
  await h.pace('A',()=>{}); assert.equal(h.now(),61000);
});

test('no extra wait after gap has elapsed; zero and invalid config handled', async () => {
  const h=setup(); await h.pace('A',()=>{});h.advance(70000);await h.pace('A',()=>{});
  assert.deepEqual(h.waits,[]);
  for(const value of [undefined,'',' ','bad',-1,Infinity]) assert.equal(readGap(value),60000);
  assert.equal(readGap('120000'),120000);assert.equal(readGap('0'),0);
});

test('posting entry point applies group gap inside account lock before browser work', async () => {
  const events=[];
  const c={module:{exports:{}},__dirname,Buffer,process:{env:{}},require:name=>{
    if(name==='fs')return fs;
    if(name==='path')return path;
    if(name.endsWith('/logger'))return {info(){},warn(){},error(){}};
    if(name.endsWith('/zalo-group-pacing'))return {withGroupPostGap:async(group,fn,cancel)=>{
      events.push(group);assert.equal(cancel(),false);return fn();
    }};
    return {};
  }};
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'src/playwright/salework.js'),'utf8'),c);
  vm.runInContext('_postToZaloGroupImpl = async () => ({success:true});',c);
  assert.equal((await c.module.exports.postToZaloGroup({accountKey:'A',groupName:'G',shouldCancel:()=>false})).success,true);
  assert.deepEqual(events,['G']);
});
