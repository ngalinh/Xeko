'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup({ failResolve = false, cancelAfterResolve = false } = {}) {
  const source = fs.readFileSync(require.resolve('./src/playwright/post'), 'utf8');
  const start = source.indexOf('async function submitPost(');
  const end = source.indexOf('\n}\n', start) + 2;
  const clicks = [], waits = [], warnings = [];
  let stage = 0, cancelled = false, diagnostics = 0;
  const surface = {
    getByRole(_role, { name }) {
      return {
        count: async () => name === (stage ? 'Đăng' : 'Tiếp') ? 1 : 0,
        click: async () => { clicks.push(name); stage++; },
        waitFor: async options => { waits.push(options); }
      };
    },
    waitFor: async () => {}
  };
  const context = {
    verifyImagesBeforeSubmit: async () => {},
    listenForPostUrl: () => ({ arm() {}, promise: Promise.resolve(null) }),
    resolvePostSurface: async (_page, options) => {
      if (failResolve) { cancelled = true; throw new Error('surface timeout'); }
      if (cancelAfterResolve) cancelled = true;
      if (options.timeout) waits.push(options);
      return surface;
    },
    _diagPostSurfaceWalk: async () => { diagnostics++; },
    logger: { info() {}, warn: message => warnings.push(message) },
    randomDelay: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const page = { evaluate: async () => {}, keyboard: { press: async () => {} } };
  return { run: () => context.submitPost(page, () => cancelled), clicks, waits, warnings,
    diagnostics: () => diagnostics };
}

test('personal submit moves from Next to Post without a dialog-only wait', async () => {
  const api = setup();
  assert.equal((await api.run()).success, true);
  assert.deepEqual(api.clicks, ['Tiếp', 'Đăng']);
  assert.equal(api.waits.length, 2);
  assert.ok(api.waits.every(options => options.timeout === 4000));
});

test('surface failure records reason and diagnostics', async () => {
  const api = setup({ failResolve: true });
  assert.equal((await api.run()).cancelled, true);
  assert.equal(api.diagnostics(), 1);
  assert.match(api.warnings[0], /surface timeout/);
  assert.deepEqual(api.clicks, []);
});

test('stop received during surface resolution prevents the next click', async () => {
  const api = setup({ cancelAfterResolve: true });
  assert.equal((await api.run()).cancelled, true);
  assert.deepEqual(api.clicks, []);
});
