const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const extract = require('./src/playwright/product-brand');

function brand(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  return dom.window.eval('(' + extract.toString() + ')()');
}

test('reads brand.name from a top-level JSON-LD Product node', () => {
  assert.equal(brand(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Jacket', brand: { '@type': 'Brand', name: 'Tommy Hilfiger' },
  })}</script>`), 'Tommy Hilfiger');
});

test('reads a plain string brand', () => {
  assert.equal(brand(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Jacket', brand: 'Tommy Hilfiger',
  })}</script>`), 'Tommy Hilfiger');
});

test('finds the Product node nested under "@graph"', () => {
  assert.equal(brand(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'BreadcrumbList' },
      { '@type': 'Product', name: 'Jacket', brand: { name: 'Tommy Hilfiger' } },
    ],
  })}</script>`), 'Tommy Hilfiger');
});

test('finds the Product node nested under WebPage.mainEntity (not just "@graph")', () => {
  assert.equal(brand(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'WebPage',
    mainEntity: { '@type': 'Product', name: 'Jacket', brand: { name: 'Tommy Hilfiger' } },
  })}</script>`), 'Tommy Hilfiger');
});

test('falls back to meta[property="product:brand"] when there is no JSON-LD brand', () => {
  assert.equal(brand('<meta property="product:brand" content="Tommy Hilfiger">'), 'Tommy Hilfiger');
});

test('returns empty string when no brand is found anywhere', () => {
  assert.equal(brand('<script type="application/ld+json">{"@type":"Product","name":"Jacket"}</script>'), '');
});
