// Exercise the real fetch handler with a stale cache, without network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
function worker(offline = false) {
  const handlers = {}, requests = [];
  let cacheReads = 0;
  vm.runInNewContext(source, {
    self: { location: { origin: 'https://xeko.test' }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    URL, Request, Response,
    caches: { match: async () => { cacheReads++; return new Response('old UI'); } },
    fetch: async request => { requests.push(request); if (offline) throw new Error('offline'); return new Response('new UI'); },
  });
  return {
    requests, get cacheReads() { return cacheReads; },
    async get(url, headers = {}) {
      let response;
      handlers.fetch({ request: new Request(url, { headers }), respondWith: value => { response = value; } });
      return response;
    },
  };
}
for (const prefix of ['', '/b/test-bot']) {
  for (const asset of ['ctv.js', 'ctv.css', 'app.mjs?version=1']) {
    test(`reopening ${prefix}/${asset} ignores stale cached UI`, async () => {
      const sw = worker();
      for (let reopen = 0; reopen < 2; reopen++) {
        assert.equal(await (await sw.get(`https://xeko.test${prefix}/${asset}`)).text(), 'new UI');
      }
      assert.equal(sw.cacheReads, 0);
      assert.equal(sw.requests.length, 2);
      assert.ok(sw.requests.every(request => request.cache === 'no-store'));
    });
  }
}
test('offline code fetch does not silently restore old UI', async () => {
  const sw = worker(true);
  await assert.rejects(sw.get('https://xeko.test/ctv.js'), /offline/);
  assert.equal(sw.cacheReads, 0);
});
test('icons retain static caching', async () => {
  const sw = worker();
  assert.equal(await (await sw.get('https://xeko.test/favicon.svg')).text(), 'old UI');
  assert.equal(sw.requests.length, 0);
});
test('HTML and API still bypass cached responses', async () => {
  const sw = worker();
  for (const url of ['/b/test/ctv.html', '/b/test/api/ctv/campaigns']) {
    const headers = url.endsWith('.html') ? { accept: 'text/html' } : {};
    assert.equal(await (await sw.get(`https://xeko.test${url}`, headers)).text(), 'new UI');
  }
  assert.equal(sw.cacheReads, 0);
  assert.ok(sw.requests.every(request => request.cache === 'no-store'));
});
