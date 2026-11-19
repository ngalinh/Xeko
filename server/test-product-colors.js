const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { collectAllColorImages } = require('./src/playwright/product-images');
const source = fs.readFileSync(require.resolve('./src/playwright/product-images'), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(source + '\nmodule.exports.selector = SWATCHES; module.exports.activate = activateColorControl; module.exports.summary = colorErrorSummary;', context);
const dom = new JSDOM(`
<button class="swatch" id="self">Navy</button>
<div class="swatches"><button id="child">Red</button><input id="radio" type="radio" value="Cream"></div>
<button id="cart">Add to bag</button><input id="size" type="radio" value="M">
`);
assert.deepEqual([...dom.window.document.querySelectorAll(context.module.exports.selector)].map(el => el.id),
  ['self', 'child', 'radio']);
let activated = 0;
dom.window.document.querySelector('#self').addEventListener('click', () => activated++);
context.module.exports.activate(dom.window.document.querySelector('#self'));
assert.equal(activated, 1);
dom.window.document.querySelector('#self').disabled = true;
assert.throws(() => context.module.exports.activate(dom.window.document.querySelector('#self')), /disabled/);
const summary = context.module.exports.summary(new Error('locator.click: Timeout 2000ms exceeded.\n  - waiting for locator(' + 'x'.repeat(3000) + ')\n  - element is not visible\n  - retrying click action'));
assert.ok(summary.includes('element is not visible'));
assert.ok(!summary.includes('waiting for locator'));
dom.window.close();

(async () => {
  let pending = false;
  let ticks = 0;
  const labels = ['Red', 'Broken', 'Color: Ivory is unavailable', 'Obstructed'];
  let labelClicks = 0;
  const labelControl = {
    click: async () => { labelClicks++; throw new Error('locator.click: Timeout 2000ms exceeded'); },
    evaluate: async fn => {
      assert.equal(fn.name, 'activateColorControl');
      pending = true;
    },
  };
  const page = {
    evaluate: async () => pending && ticks >= 8 ? ['red-front', 'red-back'] : ['navy-front', 'navy-back'],
    waitForTimeout: async () => { ticks++; },
    locator: selector => selector === 'label' ? { filter: () => ({ count: async () => 0 }) } : selector.startsWith('label[for=') ? { first: () => labelControl } : selector.includes('swatch') ? {
      count: async () => labels.length,
      nth: i => ({
        getAttribute: async name => name === 'aria-label' ? labels[i] : null,
        evaluate: async fn => {
          if (fn.name === 'activateColorControl') throw new Error('Color control is detached or disabled');
          return { radio: i === 0, labelFor: i === 0 ? 'red-radio' : null };
        },
        click: async () => { if (i === 3) throw new Error('Timeout: overlay intercepts pointer events'); if (i === 0) pending = true; },
      }),
    } : { count: async () => 0 },
  };
  const result = await collectAllColorImages(page);
  assert.deepEqual(result.images, ['navy-front', 'navy-back', 'red-front', 'red-back']);
  assert.deepEqual(result.colors.map(c => c.label), [null, 'Red']);
  assert.deepEqual(result.gallery.colorAttempts, [
    { label: 'Red', status: 'collected' },
    { label: 'Broken', status: 'unchanged-or-timeout' },
    { label: 'Color: Ivory is unavailable', status: 'unavailable' },
    { label: 'Obstructed', status: 'failed', stage: 'activate-control', error: 'Color control is detached or disabled' },
  ]);
  assert.equal(labelClicks, 1, 'Click associated label for hidden radio');
  assert.ok(ticks >= 11, 'Wait beyond 1.2 seconds for delayed gallery');
  console.log('Color selector and delayed/unchanged gallery checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
