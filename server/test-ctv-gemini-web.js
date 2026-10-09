const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, parseResponse, createSerialQueue, runOnPage, assertSession } = require('./src/ctv/gemini-web');
const { evaluateProfile } = require('./src/ctv/ai');

const options = { instruction: 'Assess only supplied evidence', schema: { type: 'OBJECT' },
  profileUrl: 'https://www.facebook.com/example', parts: [
    { text: 'Bài viết 1: caption không tin cậy' },
    { inline_data: { mime_type: 'image/jpeg', data: Buffer.from('image-fixture').toString('base64') } },
    { text: 'Bài viết 2: caption tiếp theo' },
  ] };
const request = buildRequest(options, 'test-request');
const assessment = { profileType: 'personal', sellerUS: 'yes', confidence: .99,
  reason: 'Có bằng chứng', evidence: ['fabricated evidence'], bio: '', brands: [], captionAnalysis: 'Phân tích' };
const response = JSON.stringify({ requestId: request.requestId, profileUrl: request.profileUrl, assessment });

test('prompt maps each image to its preceding caption without embedding base64', () => {
  assert.equal(request.files.length, 1);
  assert.equal(request.files[0].buffer.toString(), 'image-fixture');
  assert.ok(request.prompt.indexOf('Bài viết 1') < request.prompt.indexOf(request.files[0].name));
  assert.ok(request.prompt.indexOf(request.files[0].name) < request.prompt.indexOf('Bài viết 2'));
  assert.ok(!request.prompt.includes(options.parts[1].inline_data.data));
  assert.throws(() => buildRequest({ ...options, profileUrl: '' }), /URL/);
  assert.throws(() => buildRequest({ ...options, parts: Array(11).fill(options.parts[1]) }), /10 ảnh/);
});

test('only complete JSON for the exact request and customer is accepted', () => {
  assert.deepEqual(parseResponse(response, request), assessment);
  assert.deepEqual(parseResponse('```json\n' + response + '\n```', request), assessment);
  for (const value of ['Here is JSON: ' + response, response.slice(0, -1), '{}',
    response.replace('test-request', 'previous-request'), response.replace('/example', '/other')]) {
    assert.throws(() => parseResponse(value, request));
  }
});

test('web transport needs no API call and retains evidence gates', async () => {
  let calls = 0;
  const result = await evaluateProfile({ url: options.profileUrl, personalEvidence: true,
    posts: ['Bán giày mới, nhận order mỗi ngày.', 'Chốt đơn áo đẹp, nhận order.', 'Bán mỹ phẩm, nhận đặt hàng.'] },
  () => { throw new Error('Must not call API'); }, { provider: 'gemini-web', webRequest: async input => {
    calls++;
    assert.equal(input.profileUrl, options.profileUrl);
    return assessment;
  } });
  assert.equal(calls, 1);
  assert.equal(result.provider, 'gemini-web');
  assert.equal(result.eligible, false);
  assert.equal(result.sellerUS, 'unknown');
  assert.deepEqual(result.evidence, []);
});

test('invalid web response is not retried or sent to the API', async () => {
  let calls = 0;
  await assert.rejects(evaluateProfile({ url: options.profileUrl, posts: ['Bán áo mới nhận order'] },
    () => { throw new Error('Must not call API'); }, { provider: 'gemini-web', webRequest: async () => { calls++; return {}; } }), /không tự gửi lại/);
  assert.equal(calls, 1);
});

test('cancelled queued job cannot release a later job before the active one completes', async () => {
  const queue = createSerialQueue();
  const events = [];
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const first = queue(async () => { events.push('first'); started(); await new Promise(resolve => { finish = resolve; }); events.push('done'); });
  await running;
  const second = queue(() => events.push('cancelled'), () => { throw new Error('cancel'); });
  const third = queue(() => events.push('third'));
  await assert.rejects(second, /cancel/);
  assert.deepEqual(events, ['first']);
  finish();
  await Promise.all([first, third]);
  assert.deepEqual(events, ['first', 'done', 'third']);
  await assert.rejects(queue(() => { throw new Error('failed'); }), /failed/);
  assert.equal(await queue(() => 'recovered'), 'recovered');
});

function fakePage({ dirty = false, signedOut = false, quota = false, uploadDisabled = false, omitAttachment = false, reply = response } = {}) {
  const state = { sent: 0, uploaded: [], prompt: '', polls: 0 };
  function locator(key) {
    return {
      first() { return this; }, locator(child) { return locator(child); },
      async count() { return key === 'model-response, user-query' ? Number(dirty) : key === 'model-response' || key === 'message-content' ? Number(state.sent > 0) : 0; },
      async isVisible() {
        if (key === 'signin') return signedOut;
        if (key === 'stop') return state.polls < 1;
        if (key === 'copy') return state.polls >= 1;
        return key.includes('textbox');
      },
      async isEnabled() { return key !== 'upload' || !uploadDisabled; },
      async click() { if (key === 'send') state.sent++; },
      async fill(value) { state.prompt = value; },
      async innerText() { if (key === 'message-content') { state.polls++; return state.polls === 1 ? reply.slice(0, -1) : reply; } return ''; },
      async allTextContents() { return quota ? ['You have reached your limit'] : []; },
      async evaluateAll() { return omitAttachment ? '' : state.uploaded.map(f => f.name).join('\n'); },
      getByRole(role, opt) { return page.getByRole(role, opt); },
    };
  }
  const page = {
    state, setDefaultTimeout() {}, async goto() {}, isClosed: () => false,
    url: () => 'https://gemini.google.com/app', locator,
    getByRole(role, { name }) {
      const key = name.test('Sign in') ? 'signin' : name.test('Send message') ? 'send'
        : name.test('Stop response') ? 'stop' : name.test('Copy') ? 'copy'
          : name.test('Upload files') ? 'upload' : 'tools';
      return locator(key);
    },
    async waitForEvent() { return { async setFiles(files) { state.uploaded = files; } }; },
  };
  return page;
}

test('fresh page uploads mapped images once and waits for completed assistant JSON', async () => {
  const page = fakePage();
  assert.deepEqual(await runOnPage(page, request), assessment);
  assert.equal(page.state.sent, 1);
  assert.equal(page.state.uploaded.length, 1);
  assert.equal(page.state.prompt, request.prompt);
  assert.ok(page.state.polls >= 4);
});

test('stale chat, signed-out account, quota, disabled upload and cancellation fail before send', async () => {
  for (const setup of [{ dirty: true }, { signedOut: true }, { quota: true }, { uploadDisabled: true }]) {
    const page = fakePage(setup);
    await assert.rejects(runOnPage(page, request));
    assert.equal(page.state.sent, 0);
  }
  const page = fakePage();
  await assert.rejects(runOnPage(page, request, { check() { throw new Error('cancel'); } }), /cancel/);
  assert.equal(page.state.sent, 0);
  await assert.rejects(assertSession({ isClosed: () => true }), /đóng/);
});

test('missing attachment confirmation never submits prompt and remains cancellable', async () => {
  const page = fakePage({ omitAttachment: true });
  let checks = 0;
  await assert.rejects(runOnPage(page, request, { check() {
    if (++checks > 3) throw new Error('cancel upload');
  } }), /cancel upload/);
  assert.equal(page.state.uploaded.length, 1);
  assert.equal(page.state.sent, 0);
});

test('cancellation while waiting for AI does not resubmit or return an assessment', async () => {
  const page = fakePage();
  await assert.rejects(runOnPage(page, request, { check() {
    if (page.state.sent) throw new Error('cancel response');
  } }), /cancel response/);
  assert.equal(page.state.sent, 1);
  assert.throws(() => parseResponse('You have reached your limit. Try again later.', request), /giới hạn/);
});
