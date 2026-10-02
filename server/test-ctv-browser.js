const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { inspect, readProfileSnapshot, collectProfilePosts, readPostMedia } = require('./src/ctv/browser');
test('cleanup closes the inspected context only, including newPage failure', async () => {
  const {createBrowserAdapter}=require('./src/ctv/browser');
  const closed=[], contexts=new Map();
  for(const key of ['first','other','broken']) {
    const context={close:async()=>closed.push(key),newPage:async()=>{
      if(key==='broken') throw Error('newPage failed');
      return {isClosed:()=>false,context:()=>context};
    }};
    contexts.set(key,context);
  }
  const adapter=createBrowserAdapter({profileExists:()=>true,getBrowser:async key=>contexts.get(key)});
  const page=await adapter.withPage('first',async p=>p,{keepOpen:true});
  await adapter.withPage('other',async p=>p,{keepOpen:true});
  await adapter.closeInspection('first'); await adapter.closeInspection('first');
  assert.deepEqual(closed,['first']);
  assert.notEqual(await adapter.withPage('first',async p=>p,{keepOpen:true}),page);
  await assert.rejects(adapter.withPage('broken',async()=>{}, {keepOpen:true}),/newPage failed/);
  await adapter.closeInspection('broken'); assert.deepEqual(closed,['first','broken']);
});

test('album title is retained alongside message caption without unrelated article text', async () => {
  const mock = mediaPage(() => ['placeholder']);
  const locate = mock.page.locator;
  mock.page.locator = selector => {
    const result = locate(selector);
    const nth = result.nth;
    result.nth = i => {
      const article = nth(i);
      article.evaluate = async fn => fn.toString().includes('getBoundingClientRect') ? true : fn({
        innerText: 'Unrelated comments and controls',
        querySelectorAll: selector => selector.includes('data-ad-preview')
          ? [{innerText: 'Short C.K mẫu hiếm mới s🅰️le'}]
          : [{innerText: 'QUẦN ÁO TOMMY, CK authentic 100%'}],
      });
      return article;
    };
    return result;
  };
  const records = await readPostMedia(mock.page);
  assert.equal(records[0].caption, 'QUẦN ÁO TOMMY, CK authentic 100%\nShort C.K mẫu hiếm mới s🅰️le');
});

function snapshot({level = 1, hidden = false, friend = true, text = '', article = false, feed = false, header = false, name = 'Linh Thảo'} = {}) {
  const element = (innerText, extra = {}) => ({innerText, getClientRects: () => [1], getAttribute: () => null, ...extra});
  const heading = element(name, {
    getClientRects: () => hidden ? [] : [1], closest: () => article ? {} : null,
    matches: () => level === 1,
    ...(header ? {getBoundingClientRect: () => ({left:240,top:320,bottom:350})} : {}),
  });
  const root = element(text, {cloneNode: () => ({innerText: text, querySelectorAll: () => []}), querySelectorAll(selector) {
    if (selector === '[role="tab"], a') return [element('All', {getBoundingClientRect:()=>({top:480})})];
    if (selector === 'span, div, a') return [
      ['20K followers · 1.9K following',355], ['GROUP SĂN SALE',375],
      ['https://www.facebook.com/groups/388088742359273/',390],
      ['Digital creator',405], ['lananhtruong_authentic',420],
      ['Message',430], ['Caption bán hàng không phải bio',550],
    ].map(([value,top]) => element(value,{children:[],closest:()=>null,getBoundingClientRect:()=>({left:240,top,bottom:top+12})}));
    if (selector.startsWith('h1')) return [heading];
    if (selector.startsWith('[role="feed"]')) return feed ? [element('Bài viết')] : [];
    if (selector.includes('button')) return friend ? [element('Thêm bạn bè')] : [];
    return [];
  }});
  return vm.runInNewContext(`(${readProfileSnapshot.toString()})()`, {
    document: {querySelectorAll: () => [root]}, getComputedStyle: () => ({visibility: 'visible'}),
  });
}

test('reads primary and alternative profile headings', () => {
  assert.equal(snapshot().name, 'Linh Thảo');
  assert.equal(snapshot({level: 2, header:true}).name, 'Linh Thảo');
  assert.equal(snapshot({level: 2, header:true}).personalEvidence, true);
});
test('ignores hidden headings, post headings and unverified secondary headings', () => {
  assert.equal(snapshot({hidden: true}), false);
  assert.equal(snapshot({article: true}), false);
  assert.equal(snapshot({level: 2, friend: false}), false);
});
test('section headings are never Facebook names even with friend controls', () => {
  for (const name of ['Thông tin cá nhân','Công việc','Personal details','Facebook']) {
    assert.equal(snapshot({name,header:true,level:2}),false);
  }
  assert.equal(snapshot({name:'Ryna Lê (Mẹ Sún)',header:true}).name,'Ryna Lê (Mẹ Sún)');
});
test('two repeated posts stop scrolling and reach Gemini with the saved header', async t => {
  const originalFetch = global.fetch, originalKey = process.env.GEMINI_API_KEY;
  t.after(() => { global.fetch = originalFetch; if(originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey; });
  process.env.GEMINI_API_KEY = 'test-only';
  const bio = 'Fb : https://www.facebook.com/share/g/1BbpL4chHb/?mibextid=wwXIfr\nZalo : https://zalo.me/g/urqnio877';
  const mock = mediaPage(() => ['Bán túi DKNY giá 1499k', 'Bán đồng hồ Michael Kors giá 1800k']);
  mock.page.goto = async () => {};
  mock.page.waitForFunction = async () => ({jsonValue:async()=>({name:'Ryna Lê (Mẹ Sún)',headerBio:bio,bio,personalEvidence:true,messageLinks:[]}),dispose:async()=>{}});
  let calls = 0;
  global.fetch = async (_, options) => {
    calls++;
    const data = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    assert.equal(data.name,'Ryna Lê (Mẹ Sún)');assert.equal(data.headerBio,bio);assert.equal(data.posts.length,2);
    return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({profileType:'personal',sellerUS:'unknown',confidence:0,reason:'Chỉ đọc được hai bài bán hàng',evidence:[data.posts[0]],bio,brands:['DKNY'],captionAnalysis:'Hai bài bán túi và đồng hồ.'})}]}}]})};
  };
  const result = await inspect(mock.page,'https://facebook.com/123');
  assert.equal(calls,1);assert.equal(mock.scrolls(),3);
  assert.equal(result.name,'Ryna Lê (Mẹ Sún)');assert.equal(result.bio,bio);
  assert.equal(result.reviewedPostCount,2);assert.equal(result.insufficientData,true);
});
test('recognizes unavailable profiles without waiting for a name', () => {
  assert.match(snapshot({hidden: true, text: "This content isn't available"}).blocked, /không xem được/);
});
function pageMock({checkpoint = false, timeout = true, actual = 'https://www.facebook.com/123'} = {}) {
  let checks = 0;
  return {
    goto: async () => {}, url: () => actual,
    evaluate: async () => false,
    locator: () => ({count: async () => checkpoint && ++checks > 1 ? 1 : 0}),
    waitForFunction: async () => {
      if (timeout) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      return {jsonValue: async () => ({name: '', blocked: 'Hồ sơ bị khóa hoặc không xem được', messageLinks: []}), dispose: async () => {}};
    },
  };
}
test('timeout explains unreadable profile and rechecks delayed login prompts', async () => {
  await assert.rejects(inspect(pageMock(), 'https://facebook.com/123'), /Chưa đọc được tên Facebook sau 30 giây/);
  await assert.rejects(inspect(pageMock({checkpoint: true}), 'https://facebook.com/123'), /Cần đăng nhập/);
});
test('blocked profile remains ineligible and redirects remain rejected', async () => {
  const result = await inspect(pageMock({timeout: false}), 'https://facebook.com/123');
  assert.equal(result.eligible, false);
  await assert.rejects(inspect(pageMock({timeout: false, actual: 'https://www.facebook.com/456'}), 'https://facebook.com/123'), /hồ sơ khác/);
});


test('reads bio beneath the profile header', () => {
  assert.equal(snapshot({text: 'Công việc'}).bio, '');
});
test('reads header bio above tabs, retaining group link and category but excluding counters and posts', () => {
  const result = snapshot({header:true});
  assert.equal(result.headerBio, 'GROUP SĂN SALE\nhttps://www.facebook.com/groups/388088742359273/\nDigital creator\nlananhtruong_authentic');
});
function mediaPage(batches, images = []) {
  let scrolls = 0, expanded = 0;
  const page = {
    url: () => 'https://www.facebook.com/123',
    waitForTimeout: async () => {},
    evaluate: async fn => { if (fn.name === 'scrollProfileFeed') scrolls++; else return []; },
    locator: selector => selector.startsWith('input') ? {count: async () => 0} : {
      count: async () => batches(scrolls).length,
      nth: i => ({
        isVisible: async () => true,
        getByRole: () => ({count: async () => 1, nth: () => ({evaluate: async () => { expanded++; }})}),
        evaluate: async fn => fn.toString().includes('getBoundingClientRect') ? true : batches(scrolls)[i],
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
  assert.equal(mock.scrolls(), 3);
  assert.equal(result.posts.length, 1);
});

test('reads viewport posts after the first ten off-screen feed entries', async () => {
  const mock = mediaPage(() => Array.from({length: 15}, (_, i) => `Bán sản phẩm ${i}`));
  const locate = mock.page.locator;
  mock.page.locator = selector => {
    const result = locate(selector);
    if (selector.startsWith('input')) return result;
    const nth = result.nth;
    result.nth = i => {
      const article = nth(i), evaluate = article.evaluate;
      article.evaluate = async fn => fn.toString().includes('getBoundingClientRect') ? i >= 10 : evaluate(fn);
      return article;
    };
    return result;
  };
  const result = await readPostMedia(mock.page);
  assert.equal(result.length, 5);
  assert.equal(result[0].caption, 'Bán sản phẩm 10');
});

test('repeated captions reuse captured images across scrolls', async () => {
  const mock = mediaPage(() => ['Bán sản phẩm'], ['photo']);
  const locate = mock.page.locator;
  let captures = 0;
  mock.page.locator = selector => {
    const result = locate(selector);
    if (selector.startsWith('input')) return result;
    const nth = result.nth;
    result.nth = i => {
      const article = nth(i), images = article.locator;
      article.locator = () => {
        const result = images(), nth = result.nth;
        result.nth = j => { const image = nth(j), screenshot = image.screenshot; image.screenshot = async () => { captures++; return screenshot(); }; return image; };
        return result;
      };
      return article;
    };
    return result;
  };
  const events = [];
  const result = await collectProfilePosts(mock.page, {}, { report: (stage, message) => events.push({stage, message}) });
  assert.equal(captures, 1);
  assert.equal(result.postMedia[0].images.length, 1);
  assert.match(events.at(-1).message, /Không có bài mới sau 3 lượt/);
});

test('cancellation between batches stops further scrolling', async () => {
  const mock = mediaPage(n => [`Bán sản phẩm ${n}`]);
  let stopped = false;
  await assert.rejects(collectProfilePosts(mock.page, {}, {
    report: stage => { if (stage === 'batch') stopped = true; },
    check: () => { if (stopped) throw Error('cancelled'); },
  }), /cancelled/);
  assert.equal(mock.scrolls(), 0);
});

test('scan budget preserves partial captions and reports timeout', async t => {
  const now = Date.now;
  let elapsed = 0;
  Date.now = () => elapsed;
  t.after(() => { Date.now = now; });
  const mock = mediaPage(() => ['Bán sản phẩm']);
  const events = [];
  const result = await collectProfilePosts(mock.page, {}, { report: (stage, message) => {
    events.push({stage, message});
    if (stage === 'post') elapsed = 60001;
  } });
  assert.equal(result.posts.length, 1);
  assert.equal(mock.scrolls(), 0);
  assert.match(events.at(-1).message, /60 giây/);
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

 test('inspection retains and reuses its own page after success or AI failure', async () => {
  const { createBrowserAdapter } = require('./src/ctv/browser');
  let created = 0;
  const context = {newPage: async () => {
    created++;
    let closed = false;
    return {isClosed: () => closed, context: () => context, close: async () => {closed = true;}};
  }};
  const adapter = createBrowserAdapter({profileExists: () => true, getBrowser: async () => context});
  const page = await adapter.withPage('test', async p => p, {keepOpen:true});
  assert.equal(page.isClosed(),false);
  await assert.rejects(adapter.withPage('test', async p => {
    assert.equal(p,page); throw new Error('AI failed');
  }, {keepOpen:true}), /AI failed/);
  assert.equal(page.isClosed(),false);
  assert.equal(created,1);
  await page.close();
  const next = await adapter.withPage('test', async p => p, {keepOpen:true});
  assert.notEqual(next,page);
  const sending = await adapter.withPage('test', async p => p);
  assert.equal(sending.isClosed(),true);
  assert.equal(next.isClosed(),false);
 });

function scrollingFixture({ nested = false, atEnd = false } = {}) {
  const { scrollProfileFeed } = require('./src/ctv/browser');
  const element = (extra = {}) => ({getClientRects: () => [1], overflowY: 'visible',
    scrollTop: 0, scrollHeight: 3000, clientHeight: 800, querySelectorAll: () => [], ...extra});
  const windowRoot = element();
  const root = element({overflowY: nested ? 'auto' : 'visible', parentElement: windowRoot});
  if (atEnd) root.scrollTop = 2200;
  const article = element({parentElement: root});
  root.querySelectorAll = selector => selector === '*' ? [article] : [article];
  const result = vm.runInNewContext(`(${scrollProfileFeed.toString()})()`, {
    document: {querySelectorAll: () => [root], scrollingElement: windowRoot},
    getComputedStyle: e => ({visibility: 'visible', overflowY: e.overflowY}),
  });
  return {result, root, windowRoot};
}
test('scrolls nested Facebook feed instead of the stationary window', () => {
  const {result, root, windowRoot} = scrollingFixture({nested: true});
  assert.equal(result.moved, true);
  assert.equal(root.scrollTop, 640);
  assert.equal(windowRoot.scrollTop, 0);
});
test('uses document scrolling for ordinary profile layouts', () => {
  const {result, windowRoot} = scrollingFixture();
  assert.equal(result.moved, true);
  assert.equal(windowRoot.scrollTop, 640);
});
test('continues through outer scroller when inner feed reaches its end', () => {
  const {root, windowRoot} = scrollingFixture({nested: true, atEnd: true});
  assert.equal(root.scrollTop, 2200);
  assert.equal(windowRoot.scrollTop, 640);
});

 test('keeps readable captions without sales keywords or accessible images', async () => {
  const mock = mediaPage(() => ['Bộ sưu tập mới hôm nay', 'Một ngày vui']);
  const result = await collectProfilePosts(mock.page, {});
  assert.deepEqual(result.posts, ['Bộ sưu tập mới hôm nay', 'Một ngày vui']);
  assert.equal(result.postMedia.length, 2);
 });

 test('expands remaining see-more buttons after earlier buttons disappear', async () => {
  const mock = mediaPage(() => ['Caption đầy đủ']);
  const locate = mock.page.locator;
  let remaining = 2;
  mock.page.locator = selector => {
    const result = locate(selector);
    if (selector.startsWith('input')) return result;
    const nth = result.nth;
    result.nth = index => {
      const article = nth(index);
      article.getByRole = () => ({count: async () => remaining, nth: i => ({
        evaluate: async () => {
          if (i >= remaining) throw Error('button disappeared');
          remaining--;
        },
      })});
      return article;
    };
    return result;
  };
  await readPostMedia(mock.page);
  assert.equal(remaining, 0);
 });

 test('visible feed permits scanning without a readable name; navigation alone does not', () => {
  assert.equal(snapshot({hidden: true, feed: true}).name, '');
  assert.equal(snapshot({level: 2, friend: false, feed: true}).name, '');
  assert.equal(snapshot({hidden: true, feed: false}), false);
 });
 test('closed tab reports actionable error before querying locators', async () => {
  const page = pageMock();
  page.isClosed = () => true;
  page.locator = () => { throw Error('must not query closed page'); };
  await assert.rejects(inspect(page, 'https://facebook.com/123'), /Tab Facebook đã đóng/);
 });
 test('original browser failure is not masked by session recheck', async () => {
  const page = pageMock();
  let calls = 0;
  page.locator = () => { if (++calls > 1) throw Error('secondary locator error'); return {count: async () => 0}; };
  page.waitForFunction = async () => { throw Error('browser disconnected'); };
  await assert.rejects(inspect(page, 'https://facebook.com/123'), /browser disconnected/);
 });
 test('delayed header bio is saved before scrolling the feed', async () => {
  const mock = mediaPage(() => []);
  const header = {name:'Lan Anh Trường',messageLinks:[],bio:'',headerBio:''};
  mock.page.goto = async () => {};
  mock.page.waitForFunction = async (_, requireHeader) => {
    assert.equal(requireHeader,true);
    return {jsonValue:async()=>header,dispose:async()=>{}};
  };
  const evaluate = mock.page.evaluate;
  let headerReads = 0;
  mock.page.evaluate = async (fn, arg) => {
    if (fn.name === 'readProfileSnapshot') {
      assert.equal(mock.scrolls(),0);assert.equal(arg,true);
      return ++headerReads === 1 ? false : {...header,headerBio:'GROUP SĂN SALE\nDigital creator'};
    }
    assert.equal(headerReads,2);
    return evaluate(fn);
  };
  const result = await inspect(mock.page,'https://facebook.com/123');
  assert.equal(result.name,'Lan Anh Trường');
  assert.equal(result.bio,'GROUP SĂN SALE\nDigital creator');
  assert.ok(mock.scrolls() > 0);
 });
 test('inspection does not scroll before the profile name is captured', async () => {
  const mock = mediaPage(() => []);
  mock.page.goto = async () => {};
  mock.page.waitForFunction = async () => ({jsonValue: async () => ({name: '', messageLinks: [], bio: ''}), dispose: async () => {}});
  await assert.rejects(inspect(mock.page, 'https://facebook.com/123'), /Chưa đọc được tên Facebook/);
  assert.equal(mock.scrolls(), 0);
 });

function unlockFixture() {
  let blocked = true, waits = 0;
  const page = {
    isClosed: () => false, url: () => 'https://www.facebook.com/messages/t/123',
    locator: () => ({count: async () => blocked ? 1 : 0}),
    waitForTimeout: async () => { waits++; blocked = false; },
  };
  const box = {count: async () => 1, isVisible: async () => true};
  return {page, box, waits: () => waits};
}
test('sending waits for unlock even when composer is visible behind dialog', async () => {
  const {waitForMessageComposer} = require('./src/ctv/browser');
  const f = unlockFixture();
  await waitForMessageComposer(f.page, f.box, () => false);
  assert.equal(f.waits(), 1);
});
test('unlock wait supports stop, closed page and actionable timeout', async () => {
  const {waitForMessageComposer} = require('./src/ctv/browser');
  const f = unlockFixture();
  await assert.rejects(waitForMessageComposer(f.page, f.box, () => true), /Đã dừng/);
  await assert.rejects(waitForMessageComposer(f.page, f.box, () => false, 0), /Chưa gửi tin/);
  f.page.isClosed = () => true;
  await assert.rejects(waitForMessageComposer(f.page, f.box, () => false), /Tab gửi tin Facebook đã đóng/);
});
test('failed send retains its tab without replacing inspection tab; successful reuse closes it', async () => {
  const {createBrowserAdapter} = require('./src/ctv/browser');
  const context = {newPage: async () => {
    let closed = false;
    return {isClosed: () => closed, context: () => context, close: async () => {closed = true;}};
  }};
  const adapter = createBrowserAdapter({profileExists: () => true, getBrowser: async () => context});
  const inspection = await adapter.withPage('test', async p => p, {keepOpen: true});
  let sending;
  await assert.rejects(adapter.withPage('test', async p => {sending = p; throw Error('unlock timeout');}, {keepOnError: true}), /unlock timeout/);
  assert.notEqual(sending, inspection);
  assert.equal(sending.isClosed(), false);
  await adapter.withPage('test', async p => assert.equal(p, sending), {keepOnError: true});
  assert.equal(sending.isClosed(), true);
  assert.equal(inspection.isClosed(), false);
});
test('header timeout scans a visible feed but blocks sending without a verified name', async t => {
  const originalFetch = global.fetch, originalKey = process.env.GEMINI_API_KEY;
  t.after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey; });
  process.env.GEMINI_API_KEY = 'test-only';
  const captions = Array.from({length: 5}, (_, i) => `Bán túi mua từ Amazon.com mẫu ${i}`);
  const mock = mediaPage(n => captions.slice(0, Math.min(n + 1, 5)));
  mock.page.goto = async () => {};
  mock.page.waitForFunction = async () => { const e = new Error('header timeout'); e.name = 'TimeoutError'; throw e; };
  const evaluate = mock.page.evaluate;
  mock.page.evaluate = async (fn, arg) => fn.name === 'readProfileSnapshot'
    ? (arg ? false : {name: '', headerBio: '', personalEvidence: true, feedReady: true, messageLinks: []})
    : evaluate(fn);
  let calls = 0;
  global.fetch = async (_, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    assert.deepEqual(input.posts, captions);
    return {ok: true, json: async () => ({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({profileType: 'personal', sellerUS: 'yes', confidence: 0.99, reason: 'Đủ bằng chứng', evidence: [captions[0]], bio: '', brands: [], captionAnalysis: 'Năm bài bán hàng'})}]}}]})};
  };
  const result = await inspect(mock.page, 'https://facebook.com/123');
  assert.equal(mock.scrolls(), 4);
  assert.equal(calls, 1);
  assert.equal(result.reviewedPostCount, 5);
  assert.equal(result.name, '');
  assert.equal(result.eligible, false);
  assert.match(result.gateReason, /chưa xác minh được tên Facebook/);
});

test('header timeout does not scan a feed redirected to another profile', async () => {
  const mock = mediaPage(() => []);
  mock.page.goto = async () => {};
  mock.page.url = () => 'https://www.facebook.com/456';
  mock.page.waitForFunction = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
  mock.page.evaluate = async fn => {
    assert.equal(fn.name, 'readProfileSnapshot');
    return {name: '', headerBio: '', feedReady: true, messageLinks: []};
  };
  await assert.rejects(inspect(mock.page, 'https://facebook.com/123'), /hồ sơ khác/);
  assert.equal(mock.scrolls(), 0);
});
