// Offline regression: execute the chat posting function with mocked API jobs.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(match[1])) new vm.Script(match[2]);
}
const source = html.slice(html.indexOf('    async function runPostJob('), html.indexOf('    // ===== Lên lịch ====='));
async function run({ mode = 'now', personal = true, groups = ['101', '102'], failedJob = null } = {}) {
  const requests = [], events = [], errors = [];
  const noop = () => {};
  const sandbox = {
    FormData, Date, URL, crypto: { randomUUID: () => 'batch-test' }, BASE_URL: '', window: {},
    document: { getElementById: () => null }, channelsData: { fbGroups: groups.map((id, i) => ({ id, key: `key${i}`, name: `Group ${i}` })) },
    _activeRepostJobs: [], isOtherTabPosting: () => false,
    broadcastTabPostStart: noop, broadcastTabPostEnd: noop,
    addBot: noop, disablePrevButtons: noop, removeTyping: noop,
    pushPendingJob: noop, removePendingJob: noop, _setPendingJobThumbs: noop,
    _updateDashRowDone: () => false, postSentClosing: () => '', xekoIcon: () => '',
    getFbGroupDisplayName: id => id, botSystemError: (_label, e) => { errors.push(e); return e.message; },
    isProxyTimeout: () => false,
    appendImages: async (fd, files) => { for (const file of files) fd.append('images', file); },
    fetch: async (_url, { body }) => {
      const jobId = String(requests.length + 1);
      requests.push({ ...Object.fromEntries(body), images: body.getAll('images') }); events.push(`submit:${jobId}`);
      return { jobId, pendingLogId: jobId };
    },
    parseJson: async value => value,
    pollJob: async jobId => {
      events.push(`poll:${jobId}`);
      await Promise.resolve();
      events.push(`done:${jobId}`);
      return { success: jobId !== failedJob };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await sandbox.runPostJob({ message: 'Nội dung', profile: 'profile-a', profileName: 'Profile A',
    target: personal ? 'personal' : null, groupId: null, customGroupIds: groups,
    files: ['image-a', 'image-b'], website: 'https://example.com/product', postMode: mode,
    channelSel: { fb: [{ id: 'personal' }, { id: 'cat', groupKeys: groups.map((_, i) => `key${i}`) }] },
  });
  assert.deepEqual(errors, []);
  const share = groups.length > 0 && (mode === 'quickfb' || (personal && mode !== 'schedule' && groups.length <= 9));
  assert.deepEqual(requests.map(r => [r.target, r.groupId || null]), share
    ? [['personal-share-groups', null]]
    : [...(personal ? [['personal', null]] : []), ...groups.map(id => ['group', id])]);
  assert.deepEqual(events, requests.flatMap((_, i) => [`submit:${i + 1}`, `poll:${i + 1}`, `done:${i + 1}`]));
  for (const request of requests) {
    assert.equal(request.message, 'Nội dung');
    assert.equal(request.profile, 'profile-a');
    assert.equal(request.website, 'https://example.com/product');
    assert.equal(request.batchId, 'batch-test');
    assert.deepEqual(request.images, ['image-a', 'image-b']);
    if (share) {
      assert.deepEqual(JSON.parse(request.groupKeywords), groups.slice(0, 9).map((_, i) => `Group ${i}`));
    } else {
      assert.equal(request.groupKeywords, undefined);
    }
  }
}
test('chat shares profile post to selected groups in order without duplicate posts', () => run());
test('quickfb shares profile post to selected groups', () => run({ mode: 'quickfb' }));
test('profile only creates one post', () => run({ groups: [] }));
test('groups only does not create a profile post', () => run({ personal: false }));
test('more than nine groups are all posted', () => run({ groups: Array.from({ length: 12 }, (_, i) => String(100 + i)) }));
test('failed group does not skip remaining destinations', () => run({ personal: false, failedJob: '2' }));
test('nine groups use the share dialog', () => run({ groups: Array.from({ length: 9 }, (_, i) => String(100 + i)) }));
