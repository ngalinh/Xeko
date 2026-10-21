const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { migratePermissionsFile } = require('./src/utils/permissions-file');
const source = fs.readFileSync(path.join(__dirname, 'src/utils/permissions.js'), 'utf8');
function harness({ admin = 'admin@example.test', broken = false, response } = {}) {
  let stored = JSON.stringify({ users: { 'member@example.test': { email: 'member@example.test', profiles: ['p1'] } } });
  const calls = [];
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => { if (broken) throw new Error('Unreadable'); return stored; },
    writeFileSync: (_, value) => { stored = value; },
  };
  const context = {
    module: { exports: {} }, __dirname: '/fixture/server/src/utils',
    process: { env: { XEKO_SUPER_ADMIN: admin } }, console: { warn() {} }, setTimeout,
    require: name => name === 'fs' ? fakeFs : name === 'path' ? path : { info() {}, warn() {}, error() {} },
    fetch: async (_, options) => {
      calls.push(options.method || 'GET');
      if (response instanceof Error) throw response;
      return response;
    },
  };
  vm.runInNewContext(source, context);
  const permissions = context.module.exports;
  permissions.configureSync({ getLocalUrl: () => 'https://fixture.invalid', apiKey: 'test-only' });
  return { permissions, calls };
}
test('configured super admin retains access on store failure; unknown users stay denied', () => {
  const { permissions: p } = harness({ broken: true });
  assert.equal(p.hasAccess(' ADMIN@example.test '), true);
  assert.equal(p.isXekoAdmin('admin@example.test'), true);
  assert.equal(p.hasAccess('unknown@example.test'), false);
});
test('missing super admin never grants empty identity admin privileges', () => {
  const { permissions: p } = harness({ admin: '' });
  assert.equal(p.isSuperAdmin(''), false);
  assert.equal(p.isXekoAdmin(''), false);
  assert.equal(p.hasAccess(''), false);
});
test('existing member access and profile restrictions survive loading', () => {
  const { permissions: p } = harness();
  assert.equal(p.hasAccess('member@example.test'), true);
  assert.deepEqual(Array.from(p.getAllowedProfileKeys('member@example.test')), ['p1']);
  assert.equal(p.isXekoAdmin('member@example.test'), false);
});
test('failed restore never PUTs a potentially empty remote store over LOCAL', async () => {
  for (const response of [new Error('offline'), { ok: false, status: 500 },
    { ok: false, status: 401 }, { ok: true, json: async () => ({ users: [] }) }]) {
    const { permissions, calls } = harness({ response });
    await permissions.syncOnRegister();
    assert.deepEqual(calls, ['GET']);
  }
});
test('only confirmed missing LOCAL file allows bootstrap', async () => {
  const { permissions, calls } = harness({ response: { ok: false, status: 404 } });
  await permissions.syncOnRegister();
  assert.deepEqual(calls, ['GET', 'PUT']);
});
test('successful restore recovers previously authorized users', async () => {
  const { permissions, calls } = harness({ response: { ok: true, json: async () => ({ users: {
    'restored@example.test': { email: 'restored@example.test', profiles: ['p2'] },
  } }) } });
  await permissions.syncOnRegister();
  assert.equal(permissions.hasAccess('restored@example.test'), true);
  assert.deepEqual(calls, ['GET']);
});
test('legacy LOCAL permissions migrate without overwriting existing permissions', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.permissions-test-'));
  try {
    const legacy = path.join(dir, 'legacy.json');
    const target = path.join(dir, 'config/users.json');
    fs.writeFileSync(legacy, JSON.stringify({ users: { member: { profiles: ['p1'] } } }));
    assert.equal(migratePermissionsFile(target, legacy), true);
    assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(legacy, 'utf8'));
    fs.writeFileSync(legacy, JSON.stringify({ users: {} }));
    assert.equal(migratePermissionsFile(target, legacy), false);
    assert.ok(JSON.parse(fs.readFileSync(target)).users.member);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
