const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { inspect, readProfileSnapshot, collectProfilePosts, readPostMedia } = require('./src/ctv/browser');

function snapshot({level = 1, hidden = false, friend = true, text = '', article = false} = {}) {
  const element = (innerText, extra = {}) => ({innerText, getClientRects: () => [1], getAttribute: () => null, ...extra});
  const heading = element('Linh Thảo', {
    getClientRects: () => hidden ? [] : [1], closest: () => article ? {} : null,
    matches: () => level === 1,
  });
  const root = element(text, {cloneNode: () => ({innerText: text, querySelectorAll: () => []}), querySelectorAll(selector) {
    if (selector.startsWith('h1')) return [heading];
    if (selector.includes('button')) return friend ? [element('Thêm bạn bè')] : [];
    return [];
  }});
  return vm.runInNewContext(`(${readProfileSnapshot.toString()})()`, {
    document: {querySelectorAll: () => [root]}, getComputedStyle: () => ({visibility: 'visible'}),
  });
}

test('reads primary and alternative profile headings', () => {
  assert.equal(snapshot().name, 'Linh Thảo');
  assert.equal(snapshot({level: 2}).name, 'Linh Thảo');
  assert.equal(snapshot({level: 2}).personalEvidence, true);
});
test('ignores hidden headings, post headings and unverified secondary headings', () => {
  assert.equal(snapshot({hidden: true}), false);
  assert.equal(snapshot({article: true}), false);
  assert.equal(snapshot({level: 2, friend: false}), false);
});
test('recognizes unavailable profiles without waiting for a name', () => {
  assert.match(snapshot({hidden: true, text: "This content isn't available"}).blocked, /không xem được/);
});
function pageMock({checkpoint = false, timeout = true, actual = 'https://www.facebook.com/123'} = {}) {
  let checks = 0;
  return {
    goto: async () => {}, url: () => actual,
    locator: () => ({count: async () => checkpoint && ++checks > 1 ? 1 : 0}),
    waitForFunction: async () => {
      if (timeout) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      return {jsonValue: async () => ({name: '', blocked: 'Hồ sơ bị khóa hoặc không xem được', messageLinks: []}), dispose: async () => {}};
    },
  };
}
test('timeout explains unreadable profile and rechecks delayed login prompts', async () => {
  await assert.rejects(inspect(pageMock(), 'https://facebook.com/123'), /Không đọc được tên hồ sơ Facebook sau 30 giây/);
  await assert.rejects(inspect(pageMock({checkpoint: true}), 'https://facebook.com/123'), /Cần đăng nhập/);
});
test('blocked profile remains ineligible and redirects remain rejected', async () => {
  const result = await inspect(pageMock({timeout: false}), 'https://facebook.com/123');
  assert.equal(result.eligible, false);
  await assert.rejects(inspect(pageMock({timeout: false, actual: 'https://www.facebook.com/456'}), 'https://facebook.com/123'), /hồ sơ khác/);
});


test('reads bio beneath the profile header', () => {
  assert.equal(snapshot({text: 'Nhận order sản phẩm từ website Mỹ'}).bio, 'Nhận order sản phẩm từ website Mỹ');
});
function mediaPage(batches, images = []) {
  let scrolls = 0, expanded = 0;
  const page = {
    url: () => 'https://www.facebook.com/123',
    waitForTimeout: async () => {},
    evaluate: async () => { scrolls++; },
    locator: selector => selector.startsWith('input') ? {count: async () => 0} : {
      count: async () => batches(scrolls).length,
      nth: i => ({
        isVisible: async () => true,
        getByRole: () => ({count: async () => 1, nth: () => ({click: async () => { expanded++; }})}),
        evaluate: async () => batches(scrolls)[i],
        locator: () => ({count: async () => images.length, nth: j => ({
          evaluate: async () => images[j] !== 'small', isVisible: async () => true,
          screenshot: async () => { if (images[j] === 'broken') throw Error('detached'); return Buffer.from(images[j]); },
        })}),
      }),
    },
  };
  return {page, scrolls: () => scrolls, expanded: () => expanded};
}
test('scrolls and accumulates five distinct captions across virtualized batches', async () => {
  const mock = mediaPage(n => ['Nhật ký hôm nay', 'Bán sản phẩm Amazon.com số ' + n]);
  const result = await collectProfilePosts(mock.page, {bio: 'Bio'});
  assert.equal(result.posts.length, 5);
  assert.equal(mock.scrolls(), 4);
  assert.equal(result.bio, 'Bio');
});
test('bounds scrolling and deduplicates repeated captions', async () => {
  const mock = mediaPage(() => ['Bán một sản phẩm']);
  const result = await collectProfilePosts(mock.page, {});
  assert.equal(mock.scrolls(), 12);
  assert.equal(result.posts.length, 1);
});
test('expands captions, skips avatars and broken images, captures at most two photos', async () => {
  const mock = mediaPage(() => ['Bán sản phẩm'], ['small','broken','photo1','photo2','photo3']);
  const result = await readPostMedia(mock.page);
  assert.equal(mock.expanded(), 1);
  assert.equal(result[0].caption, 'Bán sản phẩm');
  assert.deepEqual(result[0].images.map(i => Buffer.from(i.data, 'base64').toString()), ['photo1','photo2']);
});
test('retains photo-only posts as supplementary context', async () => {
  const mock = mediaPage(() => [''], ['photo']);
  const result = await collectProfilePosts(mock.page, {});
  assert.equal(result.postMedia.length, 1);
  assert.equal(result.postMedia[0].images.length, 1);
});
