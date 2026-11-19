const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const extract = require('./src/playwright/product-price');
function price(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  return dom.window.eval('(' + extract.toString() + ')()');
}
test('Macy selling price wins over original and unrelated prices', () => {
  assert.equal(price('<nav><span class="price">$5.00</span></nav><main><div class="price">Orig. $79.50 Now $39.75 50% off</div></main>'), 'Sale $39.75 Orig. $79.50 50% off');
});
test('visible sale wins over hidden and original prices', () => {
  assert.equal(price('<main><div hidden><span class="price-sales">$10.00</span></div><span class="price-original">$79.50</span><span class="price-sale">$39.75</span></main>'), '$39.75');
});
test('does not interpret percentage or instalment count as a price', () => {
  assert.equal(price('<main><div class="price">50% off</div></main>'), null);
});
