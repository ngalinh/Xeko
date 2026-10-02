const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyProfile } = require('./src/ctv/uid');
const { resolveUid } = require('./src/ctv/browser');
const target = 'https://www.facebook.com/customer';
const user = (id, url = target) => ({ __typename: 'User', id, url });
const identify = (data, extra = {}) => identifyProfile({ target, actualUrl: target, scripts: [JSON.stringify(data)], ...extra });

test('finds the URL-bound user among viewer, commenter and unrelated IDs', () => {
  const result = identify({viewer:user('111','https://facebook.com/me.viewer'), userID:'222', profile_id:'333',
    comments:[user('444','https://facebook.com/commenter')], data:{profile:user('10000000000000001')}});
  assert.equal(result.recipientId,'10000000000000001');
  assert.equal(result.uidSource,'profile_data');
});
test('raw keys, same name, numeric JSON IDs and Page nodes are not identity proof', () => {
  for (const value of [{userID:'111',profile_id:'222'}, {id:'111',name:'Customer'},
    user(123), {...user('123'),__typename:'Page'}, user('123','https://facebook.com.evil.test/customer')]) {
    assert.equal(identify(value).recipientId,null);
  }
});
test('normalizes supported profile URLs and retains IDs as exact strings', () => {
  assert.equal(identify(user('123','https://m.facebook.com/Customer/?ref=profile')).recipientId,'123');
  assert.equal(identify({}, {target:'https://facebook.com/profile.php?id=123',actualUrl:'https://www.facebook.com/profile.php?id=123&ref=a'}).recipientId,'123');
});
test('conflicts, redirects, blocked profiles and malformed scripts stay unresolved', () => {
  for (const result of [identify([user('111'),user('222')]),
    identify(user('111'),{messageLinks:['https://www.facebook.com/messages/t/222']}),
    identify(user('111'),{actualUrl:'https://facebook.com/other'}),
    identify(user('111'),{blocked:'Hồ sơ không xem được'}),
    identify({}, {scripts:['window.userID = "123"','{malformed']})]) {
    assert.equal(result.recipientId,null);
    assert.ok(result.uidReason);
  }
});
test('only supported HTTPS message links can supply UID', () => {
  assert.equal(identify({}, {messageLinks:['https://www.facebook.com/messages/t/123/']}).recipientId,'123');
  for(const link of ['http://facebook.com/messages/t/123','https://facebook.com.evil.test/messages/t/123',
    'https://user:pass@facebook.com/messages/t/123','https://facebook.com:8443/messages/t/123']) {
    assert.equal(identify({}, {messageLinks:[link]}).recipientId,null);
  }
});
function mockPage({ blocked = '', checkpoint = false } = {}) {
  let disposed = 0, navigated;
  return { get disposed() {return disposed;}, get navigated() {return navigated;},
    page: { goto:async url=>{navigated=url;},url:()=>target,
      locator:()=>({count:async()=>checkpoint ? 1 : 0}),
      waitForFunction:async()=>({jsonValue:async()=>({name:'Customer',blocked,messageLinks:[]}),dispose:async()=>{disposed++;}}),
      evaluate:async()=>[JSON.stringify({viewer:user('111','https://facebook.com/viewer'),profile:user('222')})] },
  };
}
test('Playwright UID-only path reads profile without AI, feed scrolling or sending', async () => {
  const mock=mockPage();
  assert.equal((await resolveUid(mock.page,target)).recipientId,'222');
  assert.equal(mock.navigated,target); assert.equal(mock.disposed,1);
});
test('UID-only path handles checkpoint, blocked profile and cancellation', async () => {
  await assert.rejects(resolveUid(mockPage({checkpoint:true}).page,target),/đăng nhập/);
  assert.equal((await resolveUid(mockPage({blocked:'Không xem được'}).page,target)).recipientId,null);
  const mock=mockPage();
  await assert.rejects(resolveUid(mock.page,target,{cancelled:()=>true}),/Đã dừng/);
  assert.equal(mock.navigated,undefined);
});
