const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

function source(file) { return fs.readFileSync(path.join(__dirname, file), 'utf8'); }

function loggerHarness(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE post_logs (
    id INTEGER PRIMARY KEY, timestamp TEXT, profile TEXT, profile_name TEXT,
    platform TEXT, target TEXT, group_name TEXT, group_id TEXT, message TEXT,
    image_count INTEGER, success INTEGER, error TEXT, post_url TEXT, source TEXT,
    images TEXT, batch_id TEXT, job_id TEXT, website TEXT, retry_at TEXT, retry_count INTEGER
  )`);
  const mod = { exports: {} };
  vm.runInNewContext(source('src/database/post-logger.js'), {
    module: mod, require: () => db, setTimeout: () => 1, clearTimeout() {},
  });
  return { db, log: mod.exports };
}

test('old queued rows survive sweeper; only timeout rows accept late results', t => {
  const { db, log } = loggerHarness(t);
  const ids = {};
  for (const job of ['queued', 'orphan', 'cancelled', 'failed', 'done']) {
    ids[job] = log.insertPendingPost({ jobId: job, profile: 'A' });
  }
  db.prepare("UPDATE post_logs SET timestamp='2000-01-01T00:00:00.000Z'").run();
  log.completePendingPost(ids.cancelled, { success: false, error: 'Đã dừng theo yêu cầu người dùng' });
  log.completePendingPost(ids.failed, { success: false, error: 'Upload rejected' });
  log.completePendingPost(ids.done, { success: true });
  log.markTimedOutPending(600000, ['queued']);
  const row = name => db.prepare('SELECT * FROM post_logs WHERE id=?').get(ids[name]);
  assert.equal(row('queued').success, -1);
  assert.equal(log.getPendingPosts().length, 1);
  assert.equal(row('orphan').success, 0);
  assert.equal(log.completePendingByJobId('orphan', { success: true }).changes, 1);
  assert.equal(row('orphan').success, 1);
  for (const name of ['cancelled', 'failed', 'done']) {
    assert.equal(log.completePendingPost(ids[name], { success: true }).changes, 0);
    assert.equal(log.completePendingByJobId(name, { success: true }).changes, 0);
  }
  assert.equal(row('cancelled').error, 'Đã dừng theo yêu cầu người dùng');
  assert.equal(row('failed').error, 'Upload rejected');
  // Exercise the grouped completion statement as well as the id/job-id variants.
  log.markTimedOutPending(600000);
  assert.equal(log.completePendingPost(ids.queued, { success: true, groupName: 'Group' }).changes, 1);
  assert.equal(row('queued').group_name, 'Group');
});

function driveHarness(t, responseAt, { offline = false, cancelled = false } = {}) {
  const { db, log } = loggerHarness(t);
  const id = log.insertPendingPost({ jobId: 'job', profile: 'A', platform: 'zalo' });
  if (cancelled) log.completePendingPost(id, { success: false, error: 'Đã dừng theo yêu cầu người dùng' });
  let now = 0, polls = 0;
  const cache = new Map(), meta = new Map([['job', { pendingLogId: id, ts: 0 }]]);
  const context = vm.createContext({
    Date: { now: () => now }, setTimeout: fn => { now += 60000; fn(); },
    AbortSignal: { timeout() {} }, getLocalUrl: () => offline ? null : 'https://worker.test',
    getFetch: async () => async () => ({ ok: true, text: async () => JSON.stringify(responseAt(++polls, cache)) }),
    LOCAL_API_KEY: 'test', _zaloJobDoneCache: cache, _pendingZaloLogs: meta,
    logger: { info() {}, warn() {}, error() {} }, sseNotify() {}, postLogger: log,
  });
  const code = source('index.js');
  vm.runInContext(code.slice(code.indexOf('async function _driveZaloJob('), code.indexOf("app.post('/api/zalo/post'")), context);
  return { run: () => context._driveZaloJob('job'), cache, meta,
    row: () => db.prepare('SELECT * FROM post_logs WHERE id=?').get(id), elapsed: () => now };
}

test('Zalo queued for 15 minutes completes without a false failure', async t => {
  const h = driveHarness(t, n => n <= 15 ? { status: 'processing', queued: true } : { status: 'done', success: true });
  await h.run();
  assert.ok(h.elapsed() > 600000);
  assert.equal(h.row().success, 1);
  assert.equal(h.cache.get('job').success, true);
});

test('Zalo timeout is recoverable and late success updates the same row', async t => {
  let sawTimeout = false;
  const h = driveHarness(t, (n, cache) => {
    if (n === 12) {
      sawTimeout = true;
      assert.equal(h.row().error, 'Timeout - không xác nhận được kết quả');
      assert.equal(cache.size, 0);
    }
    return n < 13 ? { status: 'processing', queued: false } : { status: 'done', success: true };
  });
  await h.run();
  assert.equal(sawTimeout, true);
  assert.equal(h.row().success, 1);
  assert.equal(h.row().error, null);
});

test('late worker success does not overwrite user cancellation', async t => {
  const h = driveHarness(t, () => ({ status: 'done', success: true }), { cancelled: true });
  await h.run();
  assert.equal(h.row().success, 0);
  assert.equal(h.row().error, 'Đã dừng theo yêu cầu người dùng');
});

test('offline worker has a bounded reconciliation window, no terminal cache', async t => {
  const h = driveHarness(t, () => assert.fail('offline'), { offline: true });
  await h.run();
  assert.equal(h.row().success, 0);
  assert.equal(h.cache.size, 0);
  assert.ok(h.elapsed() >= 130 * 60000 && h.elapsed() < 132 * 60000);
});

test('FB pacing delays the second post only, honors configured minimum and cancellation', async () => {
  let now = 1000;
  const waits = [], mod = { exports: {} };
  vm.runInNewContext(source('src/utils/fb-post-pacing.js'), {
    module: mod, Date: { now: () => now },
    require: name => name === './post-delays'
      ? { groupDelayMs: () => 20000, sleep: async ms => { waits.push(ms); now += ms; } }
      : { MIN_INTERVAL_MS: 30000 },
  });
  const wait = mod.exports.waitForPostTurn;
  await wait('A');
  await wait('B');
  assert.deepEqual(waits, []);
  now += 120000; // a long post still needs a rest once it finishes
  mod.exports.finishPostTurn('A');
  await wait('A');
  assert.deepEqual(waits, [30000]);
  mod.exports.finishPostTurn('A');
  await wait('A', () => true);
  assert.deepEqual(waits, [30000]);
  now += 40000;
  await wait('A');
  assert.deepEqual(waits, [30000]);
});

test('Zalo rests between channels after a long or failed attempt', async () => {
  let now = 1000;
  const mod = { exports: {} }, starts = [];
  vm.runInNewContext(source('src/utils/zalo-queue.js'), {
    module: mod, Date: { now: () => now }, process: { env: {} },
    require: () => ({ groupDelayMs: () => 30000, profileDelayMs: () => 15000,
      sleep: async ms => { now += ms; } }),
  });
  const first = mod.exports.enqueue('A', async () => {
    starts.push(now); now += 120000; throw Error('posting failed');
  });
  const second = mod.exports.enqueue('A', async () => { starts.push(now); });
  await assert.rejects(first, /posting failed/);
  await second;
  assert.deepEqual(starts, [1000, 151000]);
});

test('Zalo accounts waiting for capacity still start at staggered times', async () => {
  let now = 1000;
  const mod = { exports: {} }, starts = [], releases = [];
  vm.runInNewContext(source('src/utils/zalo-queue.js'), {
    module: mod, Date: { now: () => now }, process: { env: { ZALO_MAX_CONCURRENT: '2' } },
    require: () => ({ groupDelayMs: () => 30000, profileDelayMs: () => 15000,
      sleep: async ms => { now += ms; } }),
  });
  const jobs = ['A', 'B', 'C', 'D'].map(account => mod.exports.enqueue(account, async () => {
    starts.push({ account, at: now });
    if (account === 'A' || account === 'B') await new Promise(resolve => releases.push(resolve));
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts.map(s => s.account), ['A', 'B']);
  now += 120000;
  releases.forEach(resolve => resolve());
  await Promise.all(jobs);
  assert.equal(starts.length, 4);
  assert.ok(starts[3].at - starts[2].at >= 15000);
});

test('browser keeps following a healthy FB job through a long queue', async () => {
  const html = source('../index.html');
  const start = html.indexOf('    async function pollJob(');
  const end = html.indexOf('\n    }', start) + '\n    }'.length;
  let now = 0, polls = 0;
  const c = vm.createContext({
    Date: { now: () => now }, AbortController, BASE_URL: '',
    _jobSseBus: new Map(), _jobSseResults: new Map(), console: { log() {} },
    sleepOrVisible: async () => { now += 60000; }, isProxyTimeout: () => false,
    fetch: async () => ({ status: 200 }),
    parseJson: async () => ++polls <= 15 ? { status: 'pending' } : { status: 'done', result: { success: true } },
  });
  vm.runInContext(html.slice(start, end), c);
  assert.equal((await c.pollJob('fb-job')).success, true);
  assert.equal(polls, 16);
  assert.equal(c._jobSseBus.size, 0);
});
