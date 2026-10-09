'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { resolvePostSurface } = require('./src/playwright/fb-composer');
const source = fs.readFileSync(require.resolve('./src/playwright/post'), 'utf8');
function extract(name) {
  const start = source.indexOf('async function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 2;
  return source.slice(start, end);
}
function flow() {
  const context = {
    resolvePostSurface, pendingImageChecks: new WeakMap(),
    logger: { info() {}, warn() {} }, randomDelay: async () => {},
    _qpLog: async () => {}, _qpScreenshot: async () => 'fixture.png',
    saveDebugShot: async () => 'fixture.png', openCreatePost: async () => true,
    verifyImagesBeforeSubmit: async () => {}, _qpCloseShareGroupsDialog: async () => true,
    listenForPostUrl: () => ({ arm() {}, promise: Promise.resolve('https://www.facebook.com/example/posts/1') }),
    require: () => ({ fillComposerCaption: async (_page, editor, text) => {
      await editor.fill(text);
      return await editor.innerText() === text;
    } })
  };
  vm.createContext(context);
  for (const name of ['qpStep1OpenComposer', '_attachImagesImpl', 'typeMessage', 'qpStep3ClickNext', 'qpStep6Submit']) {
    vm.runInContext(extract(name), context);
  }
  return context;
}
function fixture(tag, next = false) {
  return '<style>[contenteditable]{width:300px;height:80px}</style>' +
    '<div role="dialog"><h2>Messenger</h2><div role="textbox" contenteditable="true">Other chat</div><input type="file" accept="image/*"></div>' +
    '<' + tag + ' id="composer"><h2>Tạo bài viết</h2><div role="textbox" contenteditable="true"></div>' +
    '<input id="photos" type="file" accept="image/*" multiple><div role="button">Chia sẻ lên nhóm</div>' +
    (next ? '<button id="next" onclick="this.remove();document.querySelector(\'#composer h2\').textContent=\'Cài đặt bài viết\';document.querySelector(\'#post\').hidden=false">Tiếp</button>' : '') +
    '<button id="post" ' + (next ? 'hidden' : '') + ' onclick="window.sends=(window.sends||0)+1;document.querySelector(\'#composer\').remove()">Đăng</button></' + tag + '>';
}
test('Facebook dialog and full-page posting flow', async t => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const variant of [{ tag: 'main', next: false }, { tag: 'div role="dialog"', next: true }]) {
      await t.test(variant.next ? 'dialog with Next' : 'full-page with direct Post', async () => {
        const page = await browser.newPage();
        // Use a valid closing tag for the dialog fixture.
        await page.setContent(fixture(variant.tag, variant.next).replace('</div role="dialog">', '</div>'));
        const api = flow();
        assert.equal(await api.qpStep1OpenComposer(page, []), true);
        const surface = await resolvePostSurface(page);
        const images = [{ name: 'one.png', mimeType: 'image/png', buffer: Buffer.from('fixture') },
          { name: 'two.png', mimeType: 'image/png', buffer: Buffer.from('fixture') }];
        assert.equal(await api._attachImagesImpl(page, images), true);
        assert.equal(await page.locator('#photos').evaluate(el => el.files.length), 2);
        assert.equal(await api.typeMessage(page, 'Nội dung Linh Duong'), true);
        assert.equal(await page.locator('[role="dialog"]').first().getByRole('textbox').innerText(), 'Other chat');
        assert.equal(await page.locator('[role="dialog"]').first().locator('input').evaluate(el => el.files.length), 0);
        assert.equal(await surface.isVisible(), true, 're-resolving keeps the image guard locator attached');
        assert.equal(await api.qpStep3ClickNext(page, []), true);
        assert.equal(await page.evaluate(() => window.sends || 0), 0, 'Next never submits early');
        const result = await api.qpStep6Submit(page, []);
        assert.equal(result.success, true);
        assert.equal(await page.evaluate(() => window.sends), 1);
        await page.close();
      });
    }
    await t.test('ambiguous composers fail closed', async () => {
      const page = await browser.newPage();
      await page.setContent(fixture('main') + '<div role="dialog"><h2>Create post</h2><div role="textbox" contenteditable="true"></div><button>Post</button></div>');
      await assert.rejects(resolvePostSurface(page, { timeout: 200 }));
      await page.close();
    });
    await t.test('submit that leaves the form open is not confirmed', async () => {
      const page = await browser.newPage();
      await page.setContent(fixture('main'));
      await page.locator('#post').evaluate(el => el.onclick = () => {});
      const surface = await resolvePostSurface(page);
      await page.locator('#post').click();
      await assert.rejects(surface.waitFor({ state: 'hidden', timeout: 200 }));
      await page.close();
    });
  } finally { await browser.close(); }
});
