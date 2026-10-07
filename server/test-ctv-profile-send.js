const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { send, profileMessageButton, waitForMessageComposer } = require('./src/ctv/browser');

const target = 'https://www.facebook.com/customer';
const image = {name:'photo.png', dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='};
function fixture({fullPage = false, wrongHeader = false, redirect = false, draft = '', missingButton = false, changeAfterFill = false, receipt = true, imageReceipt = true, uploadFails = false, wrongAfterUpload = false, pendingImage = false, loseImageAfterFill = false} = {}) {
  const actions = []; let url = target, text = draft, submitted = false, headerWrong = wrongHeader;
  let imageAttached = false, imageSent = false;
  const conversation = {
    count: async () => 1,
    evaluate: async (_, count) => count === undefined ? [headerWrong ? 'https://www.facebook.com/999' : target] : imageAttached,
    locator: selector => selector.startsWith('input') ? {count:async()=>1,setInputFiles:async files=>{actions.push('attach');assert.equal(files[0].mimeType,'image/png');assert.ok(Buffer.isBuffer(files[0].buffer));if(uploadFails)throw Error('upload failed');imageAttached=true;if(wrongAfterUpload)headerWrong=true;}}
      : selector === '[role="row"]' ? {evaluateAll:async(_,text)=>text===undefined ? (imageSent && imageReceipt ? 1 : 0) : (submitted && receipt ? 1 : 0)}
      : {count:async()=>pendingImage ? 1 : 0},
  };
  const box = {count: async () => 1, isVisible: async () => true, locator: () => conversation,
    innerText: async () => text, fill: async value => {actions.push('fill'); text = value; if (changeAfterFill) headerWrong = true; if (loseImageAfterFill) imageAttached = false;},
    press: async key => {actions.push(key); submitted = true; if(imageAttached){imageSent=true;actions.push('image sent');}},
  };
  const page = {
    goto: async value => {actions.push(value); url = redirect ? 'https://www.facebook.com/other' : value;},
    url: () => url, isClosed: () => false, waitForTimeout: async () => {},
    waitForFunction: async fn => {
      assert.equal(fn, profileMessageButton);
      if (missingButton) throw Error('Message button timeout');
      return {asElement: () => ({click: async () => {actions.push('click Message'); if (fullPage) url = 'https://www.facebook.com/messages/t/123';}}), dispose: async () => {}};
    },
    locator: selector => selector.startsWith('[contenteditable') ? box : {count: async () => 0, evaluateAll: async () => false},
  };
  return {page, actions, submit: () => actions.push('reserve')};
}
for (const fullPage of [false, true]) test(`opens profile and clicks Message before sending (${fullPage ? 'full page' : 'popup'})`, async () => {
  const f = fixture({fullPage});
  const result = await send(f.page, {actualUrl:target,recipientId:'123'}, 'Hello', f.submit);
  assert.deepEqual(f.actions, [target,'click Message','fill','reserve','Enter']);
  assert.equal(result.state,'sent');
});
test('attaches image, fills text, then submits once and reserves exactly once', async () => {
  const f=fixture();
  const result=await send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]);
  assert.equal(result.state,'sent');
  assert.deepEqual(f.actions,[target,'click Message','attach','fill','reserve','Enter','image sent']);
});
test('unconfirmed image keeps combined submission uncertain and never retries', async () => {
  const f=fixture({imageReceipt:false});
  const result=await send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]);
  assert.equal(result.state,'unconfirmed');assert.match(result.reason,/chưa xác nhận đầy đủ/);
  assert.equal(f.actions.filter(a=>a==='Enter').length,1);assert.ok(f.actions.includes('fill'));
});
for(const options of [{uploadFails:true},{wrongAfterUpload:true},{pendingImage:true}]) test('image preparation failure cannot submit: '+JSON.stringify(options),async()=>{
  const f=fixture(options);
  await assert.rejects(send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]));
  assert.ok(!f.actions.includes('reserve'));assert.ok(!f.actions.includes('Enter'));assert.ok(!f.actions.includes('fill'));
});
test('cancellation after combined submission never retries',async()=>{
  const f=fixture();
  const result=await send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>f.actions.includes('image sent'),[image]);
  assert.equal(result.state,'unconfirmed');assert.equal(f.actions.filter(a=>a==='Enter').length,1);
});
test('cancellation after attachment and before text does not submit',async()=>{
  const f=fixture();
  await assert.rejects(send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>f.actions.includes('attach'),[image]),/Đã dừng/);
  assert.ok(!f.actions.includes('fill'));assert.ok(!f.actions.includes('reserve'));assert.ok(!f.actions.includes('Enter'));
});
test('text receipt without image receipt and image receipt without text receipt remain uncertain',async()=>{
  const f=fixture({receipt:false});
  assert.equal((await send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image])).state,'unconfirmed');
  assert.equal(f.actions.filter(a=>a==='Enter').length,1);
});
test('recipient change after filling caption cannot submit attachments',async()=>{
  const f=fixture({changeAfterFill:true});
  await assert.rejects(send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]),/tiêu đề hội thoại/);
  assert.ok(!f.actions.includes('reserve'));assert.ok(!f.actions.includes('Enter'));
});
test('lost image after filling caption cannot submit a text-only message',async()=>{
  const f=fixture({loseImageAfterFill:true});
  await assert.rejects(send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]),/Ảnh trong ô soạn/);
  assert.ok(!f.actions.includes('reserve'));assert.ok(!f.actions.includes('Enter'));
});
for (const [options, error] of [
  [{wrongHeader:true}, /tiêu đề hội thoại/], [{redirect:true}, /hồ sơ khác/],
  [{draft:'existing draft'}, /bản nháp/], [{missingButton:true}, /timeout/],
  [{changeAfterFill:true}, /tiêu đề hội thoại/],
]) test(`does not submit when ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  await assert.rejects(send(f.page, {actualUrl:target,recipientId:'123'}, 'Hello', f.submit), error);
  assert.ok(!f.actions.includes('reserve')); assert.ok(!f.actions.includes('Enter'));
});
test('cancellation before navigation and missing receipts never imply sent', async () => {
  const f = fixture();
  await assert.rejects(send(f.page,{actualUrl:target,recipientId:'123'},'Hello',f.submit,()=>true),/Đã dừng/);
  assert.equal(f.actions.length,0);
  const uncertain = fixture({receipt:false});
  assert.equal((await send(uncertain.page,{url:target,recipientId:'123'},'Hello',uncertain.submit)).state,'unconfirmed');
});
test('profile action picker excludes posts, hidden/disabled controls and ambiguity', () => {
  const button = (label, extra={}) => ({innerText:label,getAttribute:()=>null,getClientRects:()=>[1],closest:()=>null,...extra});
  const pick = elements => vm.runInNewContext(`(${profileMessageButton.toString()})()`, {document:{querySelectorAll:()=>elements},getComputedStyle:()=>({visibility:'visible'})});
  for(const label of ['Message','Send message','Nhắn tin','Gửi tin nhắn']) {
    const wanted = button(label);
    assert.equal(pick([wanted,button('Message',{closest:()=>({})}),button('Message',{getClientRects:()=>[]}),button('Message',{disabled:true})]),wanted);
  }
  assert.equal(pick([button('Message'),button('Nhắn tin')]),false);
  assert.equal(pick([]),false);
});
test('composer wait allows chat dialog but waits for a separate PIN dialog', async () => {
  let locked = true, waits = 0;
  const chat = {matches:()=>false,querySelector:()=>({})};
  const pin = {matches:()=>false,querySelector:()=>null};
  const page = {isClosed:()=>false,url:()=>target,locator:()=>({evaluateAll:async fn=>fn(locked ? [chat,pin] : [chat])}),waitForTimeout:async()=>{waits++;locked=false;}};
  await waitForMessageComposer(page,{count:async()=>1,isVisible:async()=>true},()=>false,1000,true);
  assert.equal(waits,1);
});

