const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readPostMedia } = require('./src/ctv/browser');

test('a growing feed reads later viewport posts and never scrolls back for old photos', async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1000,height:700}});
  await page.setContent(`<style>body{margin:0}article{height:300px}img{width:160px;height:160px}</style>
    <main><div role="feed">${Array.from({length:20}, (_, i) => `<article>
      <div data-ad-preview="message">Bán sản phẩm số ${i}</div><img id="img${i}"></article>`).join('')}</div></main>`);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160;
    for (const img of document.images) { img.src = canvas.toDataURL(); await img.decode(); }
    window.scrollTo(0, 3300);
  });
  const top = await page.evaluate(() => scrollY);
  const cache = new Map();
  const records = await readPostMedia(page, {cache});
  assert.equal(records[0].caption, 'Bán sản phẩm số 11');
  assert.equal(records[0].images.length, 1);
  assert.ok(records.every(p => !/số [0-9]$/.test(p.caption)));
  assert.equal(await page.evaluate(() => scrollY), top);
  await readPostMedia(page, {cache});
  assert.equal(await page.evaluate(() => scrollY), top);
});
