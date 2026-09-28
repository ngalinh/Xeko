// Run with: node --test test-ctv-header-dom.js (after installing Chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readProfileSnapshot } = require('./src/ctv/browser');

const bio = '🇯🇵CHỦ SHOP SỐNG TẠI NHẬT. CHUYÊN SĂN SALE HÀNG NHẬT GIÁ TỐT. NHẬN FULL SỈ-CTV SLL GIÁ TỐT🇻🇳';
const fixture = (title = '<span dir="auto" class="name">Hai Phuong</span>') => `
<style>
body { margin:0; font-family:Arial; }
.header { margin:50px 80px; width:1100px; }
.name { display:block; font-size:36px; font-weight:bold; margin:0; }
.controls { position:absolute; top:50px; left:650px; }
.bio { font-size:20px; margin-top:16px; width:1000px; }
.tabs { margin-top:70px; } img { width:20px; height:20px; }
</style>
<!-- Feed is deliberately before the header, in a separate main root. -->
<main style="position:absolute;top:600px"><div role="feed"><article>
  <h1>Wrong post author</h1><span dir="auto" style="font-size:48px">Wrong large caption</span>
</article></div></main>
<nav><h1>Facebook</h1></nav>
<section class="header">
  <div>${title}</div>
  <div class="controls"><button>Nhắn tin</button><button>Theo dõi</button><button>Thêm bạn bè</button></div>
  <div><a>3,6K người theo dõi</a> · <a>1,2K đang theo dõi</a></div>
  <div class="bio"><span dir="auto"><img alt="🇯🇵"><span>CHỦ SHOP SỐNG TẠI NHẬT.</span> CHUYÊN SĂN SALE HÀNG NHẬT GIÁ TỐT. <span>NHẬN FULL SỈ-CTV SLL GIÁ TỐT</span><img alt="🇻🇳"></span></div>
  <div><svg width="16" height="16"></svg><span>Người sáng tạo nội dung số</span> <svg width="16" height="16"></svg><a>Ota-shi, Gunma</a> <span>university</span></div>
  <div class="tabs"><a role="tab">Tất cả</a> <a role="tab">Giới thiệu</a></div>
</section>`;

test('profile header extraction in Chromium', async t => {
  const browser = await chromium.launch({headless:true, ...(process.env.CTV_TEST_BROWSER_CHANNEL ? {channel:process.env.CTV_TEST_BROWSER_CHANNEL} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1523,height:900}});
  for (const [label, title] of [
    ['plain styled span', '<span dir="auto" class="name">Hai Phuong</span>'],
    ['heading without aria-level', '<div role="heading" class="name">Hai Phuong</div>'],
    ['semantic heading', '<h1 class="name">Hai Phuong</h1>'],
  ]) {
    await t.test(label + ': reads exact name and nested emoji bio outside main', async () => {
      await page.setContent(fixture(title));
      for (const requireHeader of [true, false]) {
        const snapshot = await page.evaluate(readProfileSnapshot, requireHeader);
        assert.equal(snapshot.name, 'Hai Phuong');
        assert.equal(snapshot.headerBio, bio);
        assert.equal(snapshot.personalEvidence, true);
      }
    });
  }
  await t.test('preserves explicit line breaks without duplicating nested spans', async () => {
    await page.setContent(fixture().replace(' CHUYÊN SĂN', '<br>CHUYÊN SĂN'));
    const snapshot = await page.evaluate(readProfileSnapshot, true);
    assert.equal(snapshot.headerBio, bio.replace(' CHUYÊN SĂN', '\nCHUYÊN SĂN'));
  });
  await t.test('does not treat large post text as a missing profile title', async () => {
    await page.setContent(fixture(''));
    assert.equal(await page.evaluate(readProfileSnapshot, true), false);
    assert.equal((await page.evaluate(readProfileSnapshot, false)).name, '');
  });
  await t.test('does not infer a name from generic large text without profile controls', async () => {
    await page.setContent(fixture().replace('<button>Thêm bạn bè</button>', ''));
    assert.equal(await page.evaluate(readProfileSnapshot, true), false);
  });
});
