const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { send, profileMessageButton, waitForMessageComposer } = require('./src/ctv/browser');

const target = 'https://www.facebook.com/customer';
const image = {name:'photo.png', dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='};
function fixture({fullPage = false, wrongHeader = false, notFriends = false, redirect = false, draft = '', missingButton = false, changeAfterFill = false, receipt = true, imageReceipt = true, uploadFails = false, wrongAfterUpload = false, pendingImage = false, loseImageAfterFill = false, postSendBoxGlitch = false} = {}) {
  const actions = []; let url = target, text = draft, submitted = false, headerWrong = wrongHeader;
  let imageAttached = false, imageSent = false;
  const conversation = {
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async fn => fn.name === 'conversationHeaderLinks' ? (notFriends ? [] : [headerWrong ? 'https://www.facebook.com/999' : target])
      : fn.name === 'conversationHeaderDebug' ? {role: 'dialog', composerCount: 1, allLinkCount: 1, sampleLinks: [headerWrong ? 'https://www.facebook.com/999' : target]}
      : fn.toString().includes('setAttribute') ? undefined : (imageAttached ? 1 : 0),
    locator: selector => selector.startsWith('[contenteditable') ? box : selector.startsWith('input') ? {count:async()=>1,setInputFiles:async files=>{actions.push('attach');assert.equal(files[0].mimeType,'image/png');assert.ok(Buffer.isBuffer(files[0].buffer));if(uploadFails)throw Error('upload failed');imageAttached=true;if(wrongAfterUpload)headerWrong=true;}}
      : selector === '[role="row"]' ? {evaluateAll:async(_,text)=>text===undefined ? (imageSent && imageReceipt ? 1 : 0) : (submitted && receipt ? 1 : 0)}
      : {count:async()=>pendingImage ? 1 : 0},
  };
  const box = {count: async () => (postSendBoxGlitch && submitted) ? 0 : 1, isVisible: async () => true, locator: () => conversation,
    scrollIntoViewIfNeeded: async () => {},
    getAttribute: async () => 'Write to Khách', isEditable: async () => true,
    innerText: async () => text, fill: async value => {actions.push('fill'); text = value; if (changeAfterFill) headerWrong = true; if (loseImageAfterFill) imageAttached = false;},
    press: async key => {actions.push(key); submitted = true; if(imageAttached){imageSent=true;actions.push('image sent');}},
  };
  const page = {
    goto: async value => {actions.push(value); url = redirect ? 'https://www.facebook.com/other' : value;},
    url: () => url, isClosed: () => false, waitForTimeout: async () => {},
    evaluate: async fn => fn.name === 'pageNotFriendsPreview' ? (notFriends ? 'Linh Thảo US\nCác bạn không phải là bạn bè trên Facebook' : null)
      : fn.name === 'newThreadSentReceipt' ? submitted : undefined,
    waitForFunction: async fn => {
      assert.equal(fn, profileMessageButton);
      if (missingButton) throw Error('Message button timeout');
      return {asElement: () => ({click: async () => {actions.push('click Message'); if (fullPage) url = 'https://www.facebook.com/messages/t/123';}}), dispose: async () => {}};
    },
    locator: selector => selector.startsWith('[data-xeko') || selector === 'body' ? conversation : selector === '[role="dialog"], [role="main"], [role="complementary"], [data-xeko-chat-root]' ? {count:async()=>1,nth:()=>conversation} : {count: async () => 0, evaluateAll: async () => false},
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
test('a benign DOM change right after sending (e.g. preview becoming a real thread) does not abort confirmation', async () => {
  const f = fixture({postSendBoxGlitch:true, image:true});
  const result = await send(f.page,{url:target,recipientId:'123'},'Hello',f.submit,()=>false,[image]);
  assert.equal(result.state,'sent');
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
test('a Messenger \'not friends\' preview fails fast with a specific reason instead of a generic timeout', async () => {
  const f = fixture({notFriends:true});
  await assert.rejects(send(f.page,{actualUrl:target,recipientId:'123'},'Hello',f.submit), /chưa là bạn bè/);
  assert.ok(!f.actions.includes('fill')); assert.ok(!f.actions.includes('reserve'));
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
test('timed-out header match includes a diagnostic summary of what was actually found, for troubleshooting', async () => {
  const f = fixture({wrongHeader: true});
  await assert.rejects(send(f.page, {actualUrl:target,recipientId:'123'}, 'Hello', f.submit),
    /Chẩn đoán.*allLinkCount.*999/s);
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
  await waitForMessageComposer(page,{count:async()=>1,isVisible:async()=>true,getAttribute:async()=> 'Write to Khách',isEditable:async()=>true},()=>false,1000,true);
  assert.equal(waits,2);
});
test('Lexical composer waits for a stable recipient label and editable state',async()=>{
  let phase=0;
  const page={isClosed:()=>false,url:()=>target,locator:()=>({evaluateAll:async()=>false}),waitForTimeout:async()=>{phase++;}};
  const box={count:async()=>1,isVisible:async()=>true,isEditable:async()=>phase>=2,getAttribute:async()=>phase===0?'Write to previous customer':'Write to Khách'};
  await waitForMessageComposer(page,box,()=>false,1000,true);
  assert.equal(phase,3);
});
test('stop during composer stabilization cannot proceed to attachment or text',async()=>{
  let stopped=false;
  const page={isClosed:()=>false,url:()=>target,locator:()=>({evaluateAll:async()=>false}),waitForTimeout:async()=>{stopped=true;}};
  const box={count:async()=>1,isVisible:async()=>true,isEditable:async()=>true,getAttribute:async()=> 'Write to Khách'};
  await assert.rejects(waitForMessageComposer(page,box,()=>stopped,1000,true),/Đã dừng/);
});



test('send reports progress milestones for a quiet step-by-step log', async () => {
  const f = fixture();
  const events = [];
  await send(f.page, {actualUrl:target,recipientId:'123'}, 'Hello', f.submit, ()=>false, [], event => events.push(event.stage));
  assert.deepEqual(events, ['open','message_button','message_click','composer','typing','sending','confirming','sent']);
});
test('a Messenger "not friends" preview still sends when the recipient display name matches the scanned lead', async () => {
  const f = fixture({notFriends:true});
  const result = await send(f.page, {actualUrl:target,recipientId:'123',name:'Linh Thảo US'}, 'Hello', f.submit);
  assert.equal(result.state,'sent');
  assert.ok(f.actions.includes('fill'));
});
test('a Messenger "not friends" preview is still refused when the display name does not match the scanned lead', async () => {
  const f = fixture({notFriends:true});
  await assert.rejects(send(f.page,{actualUrl:target,recipientId:'123',name:'Người Khác'},'Hello',f.submit), /không khớp tên hồ sơ/);
  assert.ok(!f.actions.includes('fill'));
});
test('a Messenger "not friends" preview is refused when no scanned name is available to compare', async () => {
  const f = fixture({notFriends:true});
  await assert.rejects(send(f.page,{actualUrl:target,recipientId:'123'},'Hello',f.submit), /không khớp tên hồ sơ/);
  assert.ok(!f.actions.includes('fill'));
});
test('a "not friends" preview scopes the conversation to a tagged container, not the whole page body', async () => {
  const f = fixture({notFriends:true});
  const selectors = [];
  const originalLocator = f.page.locator;
  f.page.locator = selector => { selectors.push(selector); return originalLocator(selector); };
  const result = await send(f.page, {actualUrl:target,recipientId:'123',name:'Linh Thảo US'}, 'Hello', f.submit, ()=>false, [image]);
  assert.equal(result.state,'sent');
  assert.ok(!selectors.includes('body'));
  assert.ok(selectors.some(s => s.startsWith('[data-xeko-recipient-chat=')));
});
