const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { collectAllColorImages } = require('./src/playwright/product-images');
const source = fs.readFileSync(require.resolve('./src/playwright/product-images'), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(source + '\nmodule.exports.selector = SWATCHES;', context);
const dom = new JSDOM(`
<button class="swatch" id="self">Navy</button>
<div class="swatches"><button id="child">Red</button><input id="radio" type="radio" value="Cream"></div>
<button id="cart">Add to bag</button><input id="size" type="radio" value="M">
`);
assert.deepEqual([...dom.window.document.querySelectorAll(context.module.exports.selector)].map(el => el.id),
  ['self', 'child', 'radio']);
dom.window.close();

(async () => {
  let pending = false;
  let ticks = 0;
  const labels = ['Red', 'Broken'];
  const page = {
    evaluate: async () => pending && ticks >= 8 ? ['red-front', 'red-back'] : ['navy-front', 'navy-back'],
    waitForTimeout: async () => { ticks++; },
    locator: selector => selector.includes('swatch') ? {
      count: async () => labels.length,
      nth: i => ({
        getAttribute: async name => name === 'aria-label' ? labels[i] : null,
        isVisible: async () => true,
        click: async () => { if (i === 0) pending = true; },
      }),
    } : { count: async () => 0 },
  };
  const result = await collectAllColorImages(page);
  assert.deepEqual(result.images, ['navy-front', 'navy-back', 'red-front', 'red-back']);
  assert.deepEqual(result.colors.map(c => c.label), [null, 'Red']);
  assert.deepEqual(result.gallery.colorAttempts, [
    { label: 'Red', status: 'collected' },
    { label: 'Broken', status: 'unchanged-or-timeout' },
  ]);
  assert.ok(ticks >= 11, 'Wait beyond 1.2 seconds for delayed gallery');
  console.log('Color selector and delayed/unchanged gallery checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
