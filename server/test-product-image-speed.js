const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { collectAllColorImages } = require('./src/playwright/product-images');

(async () => {
  for (const markup of [
    '<input type="radio" checked aria-label="Navy">',
    '<button aria-checked="true" aria-label="Navy"></button>',
    '<button aria-pressed="true" aria-label="Navy"></button>',
    '<button aria-selected="true" aria-label="Navy"></button>',
    '<button class="selected" aria-label="Navy"></button>',
  ]) {
    const dom = new JSDOM(markup);
    const element = dom.window.document.body.firstElementChild;
    const explicit = !element.className;
    let clicks = 0;
    let waited = 0;
    const page = {
      evaluate: async () => ['navy-front', 'navy-back'],
      waitForTimeout: async ms => { waited += ms; },
      locator: selector => ({
        count: async () => selector.includes('swatch') ? 1 : 0,
        nth: () => ({
          getAttribute: async name => element.getAttribute(name),
          evaluate: async fn => fn(element),
          click: async () => { clicks++; },
        }),
      }),
    };
    const result = await collectAllColorImages(page);
    assert.deepEqual(result.images, ['navy-front', 'navy-back']);
    assert.equal(clicks, explicit ? 0 : 1);
    assert.equal(waited, explicit ? 0 : 6000);
    assert.equal(result.colors[0].label, explicit ? 'Navy' : null);
    assert.equal(result.gallery.colorAttempts[0].status,
      explicit ? 'already-selected' : 'unchanged-or-timeout');
    dom.window.close();
  }
  console.log('Selected color skips 6000ms; ambiguous state keeps full fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
