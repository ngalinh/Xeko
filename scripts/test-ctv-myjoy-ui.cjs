const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','ctv.js'),'utf8');
const handlers = source.slice(source.indexOf("  $('assessmentMode').onchange"),source.indexOf("  $('urls').oninput="));
function setup(api) {
  const nodes = new Map();
  const $ = id => {if (!nodes.has(id)) nodes.set(id,{textContent:'',children:[],replaceChildren(...children){this.children=children;},append(node){this.children.push(node);}});return nodes.get(id);};
  const context = { $, api, selected:null, busy:false, myjoyLoading:false, epoch:0, updateControls(){}, element:(tag,text)=>({tag,text}) };
  vm.createContext(context); vm.runInContext(handlers,context);
  return { $, context };
}
test('backend discovery selects the first available AI and drops the placeholder', async () => {
  let calls=0;
  const { $ } = setup(async route => { calls++; assert.equal(route,'/api/ctv/myjoy/backends'); return {backends:[{id:'model',label:'My AI',available:true},{id:'cli',label:'Gemini',available:false,reason:'Không hỗ trợ'}]}; });
  assert.equal(calls,0);
  await $('myjoyConnect').onclick();
  assert.equal(calls,1); assert.equal($('myjoyBackend').children.length,2);
  assert.equal($('myjoyBackend').children[0].value,'model'); assert.equal($('myjoyBackend').children[1].disabled,true);
  assert.equal($('myjoyBackend').value,'model');
  assert.match($('myjoyStatus').textContent,/không tự chuyển sang Gemini API/);
});
test('backend discovery with no available AI keeps a placeholder to choose', async () => {
  const { $ } = setup(async () => ({backends:[{id:'cli',label:'Gemini',available:false,reason:'Không hỗ trợ'}]}));
  await $('myjoyConnect').onclick();
  assert.equal($('myjoyBackend').children.length,2);
  assert.equal($('myjoyBackend').children[0].value,''); assert.equal($('myjoyBackend').children[1].value,'cli');
  assert.match($('myjoyStatus').textContent,/chưa có AI hỗ trợ/);
});
test('stale response cannot overwrite the AI of a selected campaign', async () => {
  let resolve;
  const { $,context }=setup(()=>new Promise(r=>{resolve=r;}));
  const pending=$('myjoyConnect').onclick();
  context.epoch++;context.selected={id:'saved'};
  $('myjoyBackend').replaceChildren({value:'saved-model'});
  resolve({backends:[{id:'new-model',label:'New',available:true}]});
  await pending;
  assert.equal($('myjoyBackend').children[0].value,'saved-model');assert.equal(context.myjoyLoading,false);
});
test('failed discovery leaves no selectable model and does not retry', async () => {
  let calls=0;
  const {$,context}=setup(async()=>{calls++;throw new Error('Chưa cấu hình tài khoản');});
  await $('myjoyConnect').onclick();
  assert.equal(calls,1);assert.equal($('myjoyBackend').children.length,1);assert.equal($('myjoyBackend').children[0].value,'');
  assert.match($('myjoyStatus').textContent,/Chưa cấu hình/);assert.equal(context.myjoyLoading,false);
});

test('usage UI distinguishes absent, partial and zero usage', () => {
  const code=source.slice(source.indexOf('  function myjoyUsageText('),source.indexOf('  const ACTIVE ='));
  const context=vm.createContext({});vm.runInContext(code,context);
  assert.equal(context.myjoyUsageText(undefined),'Chưa có thông tin usage');
  assert.equal(context.myjoyUsageText({inputTokens:0,outputTokens:2}),'0 token vào · 2 token ra');
  assert.equal(context.myjoyUsageText({inputTokens:12}),'12 token vào');
  assert.equal(context.myjoyUsageText({inputTokens:-1,outputTokens:'20'}),'Chưa có thông tin usage');
});

function setupRetry(api) {
  const nodes = new Map();
  const $ = id => {if (!nodes.has(id)) nodes.set(id,{textContent:'',children:[],value:'',disabled:false,replaceChildren(...children){this.children=children;},append(node){this.children.push(node);}});return nodes.get(id);};
  const slice = source.slice(source.indexOf("  async function loadRetryBackends"), source.indexOf("  $('approveImport').onclick"));
  const context = { $, api, selected:null, busy:false, epoch:0, retryMyjoyLoading:false, retryBackendCampaignId:null,
    picks: new Set(), canRetry: () => true, window: { confirm: () => true }, action: () => {},
    updateControls(){}, element:(tag,text)=>({tag,text,value:'',disabled:false}) };
  vm.createContext(context); vm.runInContext(slice,context);
  return { $, context };
}
test('retry backend picker preselects the campaign current AI from the live list', async () => {
  const { $, context } = setupRetry(async route => { assert.equal(route,'/api/ctv/myjoy/backends'); return {backends:[{id:'model-a',label:'A',available:true},{id:'model-b',label:'B',available:true}]}; });
  context.selected = { id:'c1', myjoyBackend:'model-b' };
  await context.loadRetryBackends(context.selected);
  assert.equal($('retryMyjoyBackend').children.length,2);
  assert.equal($('retryMyjoyBackend').value,'model-b');
});
test('retry backend picker keeps the current AI selectable even if MyJoy no longer lists it', async () => {
  const { $, context } = setupRetry(async () => ({backends:[{id:'model-a',label:'A',available:true}]}));
  context.selected = { id:'c1', myjoyBackend:'model-old' };
  await context.loadRetryBackends(context.selected);
  assert.equal($('retryMyjoyBackend').children.length,2);
  assert.equal($('retryMyjoyBackend').children[0].value,'model-old');
  assert.equal($('retryMyjoyBackend').value,'model-old');
});
test('clicking Quét lại sends the selected MyJoy backend only in myjoy mode', () => {
  const calls = [];
  const { $, context } = setupRetry(async () => ({backends:[]}));
  context.action = (name,body) => calls.push({name,body});
  context.selected = { id:'c1', assessmentMode:'myjoy' };
  $('retryMyjoyBackend').value = 'model-x';
  $('retryAnalysis').onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'retry-analysis');
  assert.equal(calls[0].body.myjoyBackend,'model-x');
});
test('clicking Quét lại omits the backend field for non-MyJoy campaigns', () => {
  const calls = [];
  const { $, context } = setupRetry(async () => ({backends:[]}));
  context.action = (name,body) => calls.push({name,body});
  context.selected = { id:'c1', assessmentMode:'keywords' };
  $('retryAnalysis').onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'retry-analysis');
  assert.equal(calls[0].body,undefined);
});
