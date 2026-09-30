const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readPostMedia } = require('./src/ctv/browser');

test('reads post captions, never nested comments, replies or pinned labels', async t => {
  const browser = await chromium.launch({headless:true,
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1200,height:900}});
  await page.setContent(`<main><div role="feed"><div data-pagelet="FeedUnit_1">
    <div role="article"><span>Bài viết đã ghim</span>
      <a href="/media/set/?set=a.123">QUẦN ÁO TOMMY, CK authentic 100%</a>
      <div data-ad-preview="message">Short C.K s🅰️le
        <button onclick="this.replaceWith('đủ size')">Xem thêm</button></div>
      <div role="article"><div data-ad-preview="message">Xin giá
        <button onclick="window.commentClicked=true">Xem thêm</button></div>
        <a href="/albums/123">Comment album</a>
        <div role="article">Gửi cho c xem mẫu Lacoste nhé</div>
        <img id="commentPhoto" width="160" height="160"></div>
      <div data-commentid="42"><div data-ad-preview="message">xin giá đôi này sz 42 ạ</div></div>
    </div></div></div></main>`);
  await page.evaluate(async () => {
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=160;
    const img=document.querySelector('img'); img.src=canvas.toDataURL(); await img.decode();
  });
  const records = await readPostMedia(page);
  assert.equal(records.length,1);
  assert.match(records[0].caption,/QUẦN ÁO TOMMY, CK/);
  assert.match(records[0].caption,/Short C.K s🅰️le/);
  assert.match(records[0].caption,/đủ size/);
  assert.doesNotMatch(records[0].caption,/Xin giá|xin giá|Lacoste|đã ghim|Comment album/);
  assert.equal(records[0].images.length,0);
  assert.equal(await page.evaluate(() => !!window.commentClicked),false);

  await page.setContent('<main><article>Bài viết đã ghim<div role="article">Xin giá</div></article></main>');
  assert.deepEqual(await readPostMedia(page),[]);
  await page.setContent('<main><div data-ad-preview="message">Caption độc lập bán quần CK</div></main>');
  assert.equal((await readPostMedia(page))[0].caption,'Caption độc lập bán quần CK');
  await page.setContent('<main><div data-pagelet="FeedUnit_2"><div data-ad-comet-preview="message">Bán áo Tommy</div><div data-commentid="2"><div data-ad-preview="message">Xin giá</div></div></div></main>');
  assert.equal((await readPostMedia(page))[0].caption,'Bán áo Tommy');
});
