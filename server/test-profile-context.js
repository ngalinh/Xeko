const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProfileLauncher, closeProfileContext, BUSY_MESSAGE } = require('./src/utils/profile-context');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('reserves the resolved profile while launching and until close', async () => {
  let finish;
  const launch = createProfileLauncher(() => new Promise(resolve => { finish = resolve; }));
  const pending = launch('./test-profile');
  await assert.rejects(launch('./other/../test-profile'), { message: BUSY_MESSAGE });
  const context = new EventEmitter();
  finish(context);
  await pending;
  await assert.rejects(launch('./test-profile'), { message: BUSY_MESSAGE });
  context.emit('close');
  const again = launch('./test-profile');
  finish(new EventEmitter());
  await again;
});

test('independent profiles can launch concurrently; failed launch releases reservation', async () => {
  let fail = true;
  const launch = createProfileLauncher(async () => {
    if (fail) throw new Error('launch failed');
    return new EventEmitter();
  });
  await assert.rejects(launch('./a'), /launch failed/);
  fail = false;
  await Promise.all([launch('./a'), launch('./b')]);
});

test('normalizes Chromium profile collision without hiding unrelated failures', async () => {
  const launch = createProfileLauncher(async () => { throw new Error('Opening in existing browser session.'); });
  await assert.rejects(launch('./a'), { message: BUSY_MESSAGE });
});

test('close timeout keeps profile reserved until a real close event', async () => {
  const context = new EventEmitter();
  let finish;
  context.close = () => new Promise(resolve => { finish = resolve; });
  const launch = createProfileLauncher(async () => context);
  await launch('./slow');
  assert.equal(await closeProfileContext(context, 10), false);
  await assert.rejects(launch('./slow'), { message: BUSY_MESSAGE });
  context.emit('close');
  finish();
  await tick();
  await launch('./slow');
});

test('successful close permits next launch; rejected close keeps reservation', async () => {
  const context = new EventEmitter();
  context.close = async () => { throw new Error('close failed'); };
  const launch = createProfileLauncher(async () => context);
  await launch('./closing');
  assert.equal(await closeProfileContext(context), false);
  await assert.rejects(launch('./closing'), { message: BUSY_MESSAGE });
  context.close = async () => { context.emit('close'); };
  assert.equal(await closeProfileContext(context), true);
  await launch('./closing');
});
