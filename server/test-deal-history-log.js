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

test('history pages cover older records without duplicates and clamp out-of-range pages', () => {
  const db = new Database(':memory:');
  try {
    const module = { exports: {} };
    vm.runInNewContext(read('server/src/database/deal-history-store.js'), { module, require: () => db });
    const store = module.exports;
    assert.equal(store.page().total, 0);
    for (let i = 0; i < 55; i++) store.create({ title: 'Item ' + i });
    const first = store.page();
    const second = store.page({ page: 2 });
    const last = store.page({ page: 99 });
    assert.equal(first.total, 55);
    assert.equal(first.pages, 3);
    assert.equal(first.rows.length, 20);
    assert.equal(second.rows.length, 20);
    assert.equal(last.page, 3);
    assert.equal(last.rows.length, 15);
    assert.equal(new Set([...first.rows, ...second.rows, ...last.rows].map(r => r.id)).size, 55);
    assert.equal(store.page({ page: -1 }).page, 1);
  } finally { db.close(); }
});

for (const file of ['index.html', 'get-deal-test.html']) {
  test(file + ': page controls update rows and continuous numbering', async () => {
    const dom = new JSDOM(read(file), { url: 'https://example.com/', runScripts: 'outside-only' });
    try {
      const w = dom.window;
      w.fetch = async url => {
        const page = Number(new URL(url, w.location.href).searchParams.get('page'));
        return { ok: true, json: async () => ({ page, pages: 2, total: 21,
          rows: Array.from({ length: page === 1 ? 20 : 1 }, (_, i) => ({ title: 'Item ' + ((page - 1) * 20 + i) })) }) };
      };
      w.eval(read('product-deal.js'));
      await new Promise(resolve => setImmediate(resolve));
      const pager = w.document.querySelector('[data-deal-id=history-pagination]');
      const body = w.document.querySelector('[data-deal-id=history-body]');
      assert.equal(body.rows.length, 20);
      assert.equal(body.rows[0].cells[0].textContent, '1');
      assert.equal(pager.querySelector('button').disabled, true);
      pager.querySelector('[aria-label="Trang 2"]').click();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].cells[0].textContent, '21');
      assert.equal(pager.querySelector('[aria-current=page]').textContent, '2');
      assert.equal(pager.lastChild.disabled, true);
    } finally { dom.window.close(); }
  });
}
