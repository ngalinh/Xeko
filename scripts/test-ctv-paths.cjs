// Routing regression tests. No network, AI calls or Facebook messages.
// Run: node --test scripts/test-ctv-paths.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const index = read('index.html'), html = read('ctv.html'), js = read('ctv.js');
const baseDeclaration = source => source.match(/const BASE_URL = [^\n]+/)[0];
const click = index.match(/<button[^>]+onclick="([^"]+)"[^>]+id="navCtv"/)[1];
const apiSource = js.slice(js.indexOf('  async function api('), js.indexOf('  function badge('));

for (const prefix of ['', '/b/test-bot']) {
  test(`CTV menu, assets and return links stay in ${prefix || 'root'}`, () => {
    for (const entry of [`${prefix}/`, `${prefix}/index.html`]) {
      const location = { pathname: entry, href: `https://xeko.test${entry}?page=dashboard` };
      vm.runInNewContext(`${baseDeclaration(index)}\n${click}`, { window: { location }, location });
      assert.equal(location.href, `${prefix}/ctv.html`);
    }
    const pageUrl = `https://xeko.test${prefix}/ctv.html`;
    for (const asset of ['ctv.css', 'ctv.js']) {
      const ref = html.match(new RegExp(`(?:href|src)="([^"]*${asset.replace('.', '\\.')}[^\"]*)"`))[1];
      assert.equal(new URL(ref, pageUrl).pathname, `${prefix}/${asset}`);
    }
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(m => m[1]);
    assert.ok(links.some(href => href.includes('page=dashboard')));
    for (const href of links.filter(href => !href.startsWith('#'))) {
      const resolved = new URL(href, pageUrl);
      assert.equal(resolved.origin, 'https://xeko.test');
      assert.equal(resolved.pathname, href.includes('ctv.html') ? `${prefix}/ctv.html` : `${prefix}/`);
    }
  });

  test(`CTV GET and POST requests stay in ${prefix || 'root'}`, async () => {
    const requests = [];
    const context = {
      window: { location: { pathname: `${prefix}/ctv.html` } },
      AbortController, setTimeout, clearTimeout,
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; },
    };
    vm.createContext(context);
    vm.runInContext(`${baseDeclaration(js)}\n${apiSource}\nglobalThis.request = api;`, context);
    const endpoints = ['/api/accounts', '/api/ctv/campaigns', '/api/ctv/campaigns/test-id'];
    for (const endpoint of endpoints) await context.request(endpoint);
    for (const action of ['approve-import', 'approve-analysis', 'review-analysis', 'prepare-messages', 'send', 'stop']) {
      endpoints.push(`/api/ctv/campaigns/test-id/${action}`);
      await context.request(endpoints.at(-1), 'POST', { previewToken: 'test-only' });
    }
    assert.deepEqual(requests.map(r => r.url), endpoints.map(endpoint => prefix + endpoint));
    for (const { options } of requests.slice(3)) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { previewToken: 'test-only' });
    }
  });
}
