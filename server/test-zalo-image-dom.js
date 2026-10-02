const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

test('image confirmation reads only the active thread, excludes old album and outside previews', async () => {
  const c = vm.createContext({
    module: { exports: {} }, __dirname,
    require: name => ['path', 'fs'].includes(name) ? require(name) : {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/playwright/salework.js'), 'utf8'), c);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://cdn.test/**', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" />' }));
    await page.setContent(`<style>img {width:50px;height:50px} textarea {width:200px;height:40px}</style>
      <aside><img src="https://cdn.test/avatar"></aside>
      <div class="chat-messages-area"><img src="https://cdn.test/first-album"></div>
      <div id="composer"><textarea class="msg-textarea"></textarea><button class="send-btn">Send</button>
      <img src="https://cdn.test/preview"></div>`);
    const before = await c._imageThreadState(page);
    assert.deepEqual(before.threadSources, ['https://cdn.test/first-album']);
    assert.deepEqual(before.composerSources, ['https://cdn.test/preview']);
    await page.locator('#composer img').evaluate(el => el.remove());
    // Clearing the second draft or adding a sidebar image must not release caption.
    await page.locator('aside').evaluate(el => el.insertAdjacentHTML('beforeend', '<img src="https://cdn.test/unrelated">'));
    assert.equal(c._imageDeliveryReady(before, await c._imageThreadState(page)), false);
    await page.locator('.chat-messages-area').evaluate(el => {
      el.innerHTML = '<img src="https://cdn.test/second-album">'; // virtualized history, same count
    });
    assert.equal(c._imageDeliveryReady(before, await c._imageThreadState(page)), true);
  } finally { await browser.close(); }
});
