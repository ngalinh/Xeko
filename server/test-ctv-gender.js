const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readSelfDeclaredGender, readGenderField, sameProfile } = require('./src/ctv/gender');

function dom(rows) {
  const root = {};
  root.querySelectorAll = () => rows.map(r => ({
    innerText: r.label, getClientRects: () => r.hidden ? [] : [1], closest: () => r.article ? {} : null,
    parentElement: { innerText: r.text, parentElement: root, getClientRects: () => [1], closest: () => null },
  }));
  return vm.runInNewContext('('+readGenderField.toString()+')()', { document: {querySelectorAll:()=>[root]}, getComputedStyle:()=>({visibility:'visible'}) });
}
test('reads only explicit visible gender field, in either row order',()=>{
  assert.equal(dom([{label:'Giới tính',text:'Nữ\nGiới tính'}]).value,'Nữ');
  assert.equal(dom([{label:'Gender',text:'Gender\nMale'}]).value,'Male');
  assert.equal(dom([{label:'Gender',text:'Gender\nNon-binary'}]).value,'Non-binary');
});
test('ignores names, pronouns, hidden fields, feed and ambiguous layout',()=>{
  for(const rows of [[],[{label:'She/her',text:'She/her\nFemale'}],[{label:'Gender',text:'Gender\nFemale',hidden:true}],[{label:'Gender',text:'Gender\nMale',article:true}],[{label:'Gender',text:'Gender\nFemale\nOther fields'}],[{label:'Gender',text:'Gender\nEdit'}],[{label:'Gender',text:'Gender\nFemale'},{label:'Gender',text:'Gender\nMale'}]]) assert.equal(dom(rows),null);
});
function page(found, options={}) {
  let url='',closed=0;
  const tab={goto:async value=>{url=value;if(options.error)throw Error('unavailable');},url:()=>options.redirect || url,evaluate:async()=>found,waitForTimeout:async()=>{},close:async()=>{closed++;}};
  return {page:{context:()=>({newPage:async()=>tab})},closed:()=>closed,url:()=>url};
}
test('stores raw value and evidence with source/time, closes only temporary tab',async()=>{
  const p=page({value:'Nữ',evidence:'Nữ\nGiới tính'});
  const result=await readSelfDeclaredGender(p.page,'https://facebook.com/example');
  assert.equal(result.status,'self_declared');assert.equal(result.value,'Nữ');assert.equal(result.evidence,'Nữ\nGiới tính');assert.match(result.sourceUrl,/example\/about_contact_and_basic_info$/);assert.ok(Date.parse(result.checkedAt));assert.equal(p.closed(),1);
});
test('supports numeric profiles and rejects other profiles and login redirects',async()=>{
  assert.equal(sameProfile('https://www.facebook.com/profile.php?id=123&sk=about_contact_and_basic_info','https://www.facebook.com/profile.php?id=123'),true);
  for(const redirect of ['https://www.facebook.com/other/about_contact_and_basic_info','https://www.facebook.com/login','https://evil.test/example']){
    const p=page({value:'Female'},{redirect});assert.equal((await readSelfDeclaredGender(p.page,'https://facebook.com/example')).status,'unknown');assert.equal(p.closed(),1);
  }
});
test('missing/private/load-error values stay unknown without failing profile scan',async()=>{
  for(const options of [{},{error:true}]){const p=page(null,options);const r=await readSelfDeclaredGender(p.page,'https://facebook.com/profile.php?id=123');assert.equal(r.value,null);assert.equal(r.status,'unknown');assert.equal(p.closed(),1);assert.match(p.url(),/id=123&sk=/);}
});
test('cancellation propagates and closes temporary tab',async()=>{
  const p=page(null);let checks=0;
  await assert.rejects(readSelfDeclaredGender(p.page,'https://facebook.com/example',{check:()=>{if(++checks>1)throw Error('cancelled');}}),/cancelled/);
  assert.equal(p.closed(),1);
});
