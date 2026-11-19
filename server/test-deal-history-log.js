const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('history migration preserves old entries and stores independent logs for repeated URLs', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE deal_history (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, url TEXT, website TEXT, price TEXT, created_at TEXT); INSERT INTO deal_history VALUES (1, 'Old', '', '', '', '2026-01-01')");
    const module = { exports: {} };
    vm.runInNewContext(read('server/src/database/deal-history-store.js'), { module, require: () => db });
    const store = module.exports;
    assert.equal(store.getById(1).log, null);
    const log = { status: 'success', debug: { colors: [{ label: 'Navy' }], gallery: { imageCount: 4 } } };
    const first = store.create({ url: 'https://example.com/item', log });
    store.create({ url: first.url, log: { status: 'error', error: 'Timeout' } });
    assert.equal(JSON.stringify(store.getById(first.id).log), JSON.stringify(log));
    assert.equal(store.list().length, 3);
  } finally { db.close(); }
});

for (const file of ['index.html', 'get-deal-test.html']) {
  test(file + ': history renders saved logs safely and handles legacy entries', async () => {
    const dom = new JSDOM(read(file), { url: 'https://example.com/', runScripts: 'outside-only' });
    try {
      const w = dom.window;
      const log = { status: 'error', debug: { pageTitle: '<img src=x onerror=alert(1)>' }, error: 'Timeout' };
      w.fetch = async () => ({ ok: true, json: async () => [{ title: 'New', log }, { title: 'Old' }] });
      w.eval(read('product-deal.js'));
      await new Promise(resolve => setImmediate(resolve));
      const body = w.document.querySelector('[data-deal-id=history-body]');
      assert.equal(body.querySelector('pre').textContent, JSON.stringify(log, null, 2));
      assert.match(body.querySelector('summary').textContent, /Thất bại/);
      assert.match(body.textContent, /Chưa có log/);
      assert.equal(body.querySelector('img'), null);
    } finally { dom.window.close(); }
  });
}

test('each proxy outcome records exactly one history callback', async () => {
  const source = read('server/index.js');
  const helper = source.slice(source.indexOf('async function proxyToLocal('), source.indexOf("app.post('/api/restart'"));
  for (const scenario of ['success', 'http-error', 'offline', 'invalid-json', 'network-error']) {
    const records = [];
    const context = {
      getLocalUrl: () => scenario === 'offline' ? '' : 'https://mock.example',
      LOCAL_API_KEY: 'mock', logger: { warn() {} },
      getFetch: async () => async () => {
        if (scenario === 'network-error') throw new Error('Network failure');
        return { status: scenario === 'http-error' ? 500 : 200, text: async () => scenario === 'invalid-json' ? 'invalid' : JSON.stringify({ debug: { imageCount: 4 } }) };
      },
    };
    vm.createContext(context);
    vm.runInContext(helper, context);
    const res = { status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await context.proxyToLocal({}, res, 'POST', '/api/get-deal', {}, (data, status) => records.push({ data, status }));
    assert.equal(records.length, 1, scenario);
    assert.equal(records[0].status, res.code);
    assert.equal(records[0].data, res.data);
    assert.equal(res.code, { success: 200, 'http-error': 500, offline: 503, 'invalid-json': 502, 'network-error': 500 }[scenario]);
  }
});
