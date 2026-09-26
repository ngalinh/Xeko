const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createProfileLifecycle } = require('./src/utils/zalo-profile-lifecycle');
const { verifySearchResults } = require('./src/playwright/zalo-target');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

test('same profile stays exclusive across queued jobs and delayed close', async () => {
  const lifecycle = createProfileLifecycle(1000);
  const closed = deferred();
  const started = [];
  const first = lifecycle.run('a', async () => {
    started.push(1);
    await lifecycle.close('a', { close: () => closed.promise });
  });
  const secondGate = deferred();
  const second = lifecycle.run('a', async () => { started.push(2); await secondGate.promise; });
  const third = lifecycle.run('a', () => started.push(3));
  await tick();
  assert.deepEqual(started, [1]);
  await lifecycle.run('b', () => started.push('other'));
  closed.resolve();
  await first;
  await tick();
  const fourth = lifecycle.run('a', () => started.push(4));
  assert.deepEqual(started, [1, 'other', 2]);
  secondGate.resolve();
  await Promise.all([second, third, fourth]);
  assert.deepEqual(started, [1, 'other', 2, 3, 4]);
});

test('hung close blocks relaunch with bounded wait, then recovers when closed', async () => {
  const lifecycle = createProfileLifecycle(10);
  const closed = deferred();
  await assert.rejects(lifecycle.close('a', { close: () => closed.promise }), /chưa đóng xong/);
  await assert.rejects(lifecycle.run('a', () => assert.fail('must not relaunch')), /chưa đóng xong/);
  closed.resolve();
  await tick();
  assert.equal(await lifecycle.run('a', () => 'recovered'), 'recovered');
});

test('failed close prevents reuse; failed job does not poison queue', async () => {
  const lifecycle = createProfileLifecycle(10);
  await assert.rejects(lifecycle.run('a', () => { throw new Error('job failed'); }), /job failed/);
  assert.equal(await lifecycle.run('a', () => 1), 1);
  await assert.rejects(lifecycle.close('a', { close: async () => { throw new Error('close failed'); } }), /close failed/);
  await assert.rejects(lifecycle.run('a', () => assert.fail('must not relaunch')), /close failed/);
});

test('account name case/spacing differences pass but other accounts and ambiguous groups fail', () => {
  const conv = { id: 'g', threadType: 'group', contact: { fullName: 'Sỉ Hàng Order' }, zaloAccount: { id: 'a', displayName: 'Linh Duong Us' } };
  const target = { groupName: 'Sỉ Hàng Order', accountName: ' Linh  Duong US ' };
  assert.equal(verifySearchResults({ conversations: [conv] }, 'a', target), 'g');
  assert.throws(() => verifySearchResults({ conversations: [conv] }, 'b', target));
  assert.throws(() => verifySearchResults({ conversations: [conv] }, 'a', { ...target, accountName: 'Linh Thao' }));
  assert.throws(() => verifySearchResults({ conversations: [conv, conv] }, 'a', target));
});

function harness(overrides = {}) {
  let time = 0;
  const c = vm.createContext({
    require(id) {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id === 'path' || id === 'fs') return require(id);
      if (id.endsWith('/zalo-profile-lifecycle')) return { createProfileLifecycle };
      if (id === './zalo-target') return { assertConversationTarget: async () => {} };
      if (id.endsWith('/logger')) return { info() {}, warn() {}, error() {} };
      if (id.endsWith('/delay')) return { sleep: async ms => { time += ms; }, randomDelay: async () => {} };
      return {};
    },
    module: { exports: {} }, __dirname, process: { env: {} }, Date: { now: () => time },
    setTimeout, clearTimeout, Buffer,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/playwright/salework.js'), 'utf8'), c);
  c.screenshot = async () => {};
  return c;
}

test('slow account list and delayed selection update do not cause double toggles', async () => {
  const c = harness();
  let reads = 0, clicked = false, updates = 0, clicks = 0;
  c.openAccountDropdown = async () => true;
  c.accountListVisible = async () => false;
  c.readAccountRows = async () => {
    if (++reads < 5) return [];
    if (clicked) updates++;
    return [{ idx: 0, title: 'Linh Duong Us', on: clicked && updates > 4 }];
  };
  c.clickAccountRowByIdx = async () => { clicks++; clicked = true; };
  const page = {
    locator: () => ({ getByRole: () => ({ isVisible: async () => false }), first: () => ({ waitFor: async () => {} }) }),
    keyboard: { press: async () => {} },
  };
  assert.equal(await c.selectZaloAccount(page, 'Linh Duong US'), true);
  assert.equal(clicks, 1);
});

for (const failure of ['missing', 'duplicate', 'unchanged']) {
  test('account selection diagnoses ' + failure + ' and never sends', async () => {
    const c = harness();
    c.openAccountDropdown = async () => true;
    const row = { idx: 0, title: 'Linh Duong Us', on: false };
    c.readAccountRows = async () => failure === 'missing' ? [] : failure === 'duplicate' ? [row, row] : [row];
    c.clickAccountRowByIdx = async () => {};
    const page = { locator: () => ({ getByRole: () => ({ isVisible: async () => false }) }) };
    const expected = { missing: /không thấy/, duplicate: /trùng/, unchanged: /không cập nhật/ }[failure];
    await assert.rejects(c.selectZaloAccount(page, 'Linh Duong Us'), expected);
  });
}

for (const stage of ['account', 'group']) {
  test('pre-send ' + stage + ' error reloads once and revalidates login', async () => {
    const c = harness();
    let visits = 0, logins = 0, accounts = 0, groups = 0;
    c.waitForChatReady = async () => true;
    c.ensureLoggedIn = async () => { logins++; };
    c.selectZaloAccount = async () => { if (++accounts === 1 && stage === 'account') throw new Error('slow account'); };
    c.searchAndClickGroup = async () => { if (++groups === 1 && stage === 'group') throw new Error('slow group'); return true; };
    await c.prepareZaloTarget({ goto: async () => { visits++; } }, 'a', 'Linh Duong Us', 'group');
    assert.equal(visits, 2);
    assert.equal(logins, 2);
    assert.equal(accounts, 2);
  });
}

test('preparation retries are bounded and cancellation prevents another attempt', async () => {
  const c = harness();
  let visits = 0;
  const page = { goto: async () => { visits++; throw new Error('network'); } };
  await assert.rejects(c.prepareZaloTarget(page, 'a', 'account', 'group'), /sau 2 lần thử.*network/);
  assert.equal(visits, 2);
  await assert.rejects(c.prepareZaloTarget(page, 'a', 'account', 'group', () => true), e => e.cancelled);
  assert.equal(visits, 2);
});

for (const failPage of [false, true]) {
  test('posting holds profile until context close, including newPage failure=' + failPage, async () => {
    const closing = deferred();
    let closes = 0, sends = 0, settled = false;
    const context = {
      newPage: async () => { if (failPage) throw new Error('page failed'); return {}; },
      close: () => { closes++; return closing.promise; },
    };
    const c = harness({
      fs: { existsSync: () => true },
      '../utils/playwright-launch': { safeLaunchPersistentContext: async () => context },
      '../utils/proxy': { getZaloProxyForAccount: () => null },
      '../utils/device-fingerprint': { getProfileDeviceFingerprint: () => ({}) },
    });
    c.prepareZaloTarget = async () => {};
    c.sendMessage = async () => { sends++; };
    const posted = c.postToZaloGroup({ accountKey: 'a', zaloAccountName: 'account', groupName: 'group', imagePaths: [] })
      .then(result => { settled = true; return result; });
    await tick();
    assert.equal(closes, 1);
    assert.equal(settled, false);
    closing.resolve();
    const result = await posted;
    assert.equal(result.success, !failPage);
    assert.equal(sends, failPage ? 0 : 1);
  });
}

test('selection clears more than eight previously selected accounts', async () => {
  const c = harness();
  const rows = Array.from({ length: 12 }, (_, idx) => ({ idx, title: 'account-' + idx, on: true }));
  c.openAccountDropdown = async () => true;
  c.accountListVisible = async () => false;
  c.readAccountRows = async () => rows.map(row => ({ ...row }));
  c.clickAccountRowByIdx = async (_, idx) => { rows[idx].on = !rows[idx].on; };
  const page = {
    locator: () => ({ getByRole: () => ({ isVisible: async () => false }), first: () => ({ waitFor: async () => {} }) }),
    keyboard: { press: async () => {} },
  };
  await c.selectZaloAccount(page, 'account-11');
  assert.deepEqual(rows.filter(row => row.on).map(row => row.title), ['account-11']);
});
