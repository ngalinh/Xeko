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
  assert.equal(price('<main><div hidden><span class="price-sales">$10.00</span></div><span class="price-original">$79.50</span><span class="price-sale">$39.75</span></main>'), 'Sale $39.75 Orig. $79.50');
});
test('does not interpret percentage or instalment count as a price', () => {
  assert.equal(price('<main><div class="price">50% off</div></main>'), null);
});

test('collects original from a separate labelled element', () => {
  assert.equal(price('<main><div class="price">Now $39.75</div><div class="price">Orig. $79.50</div></main>'), 'Sale $39.75 Orig. $79.50');
});
test('collects struck original but excludes hidden and recommended originals', () => {
  assert.equal(price('<main><div hidden><s>$150.00</s></div><div class="recommend"><s>$200.00</s></div><s>$79.50</s><span data-auto="price-sales">$39.75</span></main>'), 'Sale $39.75 Orig. $79.50');
});
test('does not invent an original for a sale-only product', () => {
  assert.equal(price('<main><span class="price">Now $39.75</span></main>'), 'Sale $39.75');
});
test('extracts sale/original from a promo banner without a sale/orig label', () => {
  assert.equal(price('<main><div class="price">BLACK FRIDAY DEAL$39.75 (50% off)$79.50Details</div></main>'), 'Sale $39.75 Orig. $79.50 50% off');
});
