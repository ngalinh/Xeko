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
test('backend discovery is explicit, keeps placeholder and disables unavailable AI', async () => {
  let calls=0;
  const { $ } = setup(async route => { calls++; assert.equal(route,'/api/ctv/myjoy/backends'); return {backends:[{id:'model',label:'My AI',available:true},{id:'cli',label:'Gemini',available:false,reason:'Không hỗ trợ'}]}; });
  assert.equal(calls,0);
  await $('myjoyConnect').onclick();
  assert.equal(calls,1); assert.equal($('myjoyBackend').children[0].value,'');
  assert.equal($('myjoyBackend').children[1].value,'model'); assert.equal($('myjoyBackend').children[2].disabled,true);
  assert.match($('myjoyStatus').textContent,/không tự chuyển sang Gemini API/);
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
