const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProfile } = require('./src/ctv/ai');
const snapshot = { personalEvidence: true, bio: '', posts: [
  'Nhận order máy pha cà phê từ Amazon.com.',
  'Bán giày từ website Mỹ nike.com, nhận đặt hàng.',
  'Chốt đơn mỹ phẩm từ sephora.com Mỹ.',
] };
const good = { profileType: 'personal', sellerUS: 'yes', confidence: .95,
  reason: 'Có bằng chứng sản phẩm trên website Mỹ', evidence: [snapshot.posts[0]], bio:'', brands:['Nike'], captionAnalysis:'Bài 2 bán giày từ nike.com; bài 3 nhận chốt đơn mỹ phẩm từ sephora.com Mỹ.' };
const candidate = (text, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
const valid = candidate(JSON.stringify(good));
test('header bio is preserved even when AI omits it from the response', async t => {
  const headerBio = 'GROUP SĂN SALE\nhttps://www.facebook.com/groups/388088742359273/\nDigital creator';
  const m = mock(t, [valid]);
  const result = await evaluateProfile({...snapshot, headerBio}, m.fetch);
  assert.equal(result.bio, headerBio);
  assert.match(m.calls[0].systemInstruction.parts[0].text, /Ưu tiên headerBio/);
  assert.equal(JSON.parse(m.calls[0].contents[0].parts[0].text).headerBio, headerBio);
});
test('structured display fields retain only grounded bio and caption brands', async t => {
  const bio = 'Nhận order hàng Mỹ chính hãng';
  const m = mock(t, [candidate(JSON.stringify({...good, bio, brands:['Nike','InventedBrand']}))]);
  const result = await evaluateProfile({...snapshot, bio:'Giới thiệu\n' + bio}, m.fetch);
  assert.equal(result.bio, bio);
  assert.deepEqual(result.brands, ['Nike']);
  assert.equal(result.captionAnalysis, good.captionAnalysis);
});
test('fabricated bio is not displayed and group classification remains ineligible', async t => {
  const m = mock(t, [candidate(JSON.stringify({...good, profileType:'group', bio:'Invented bio'}))]);
  const result = await evaluateProfile(snapshot, m.fetch);
  assert.equal(result.bio, ''); assert.equal(result.type, 'group'); assert.equal(result.eligible, false);
});
function mock(t, responses) {
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only';
  t.after(() => { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; });
  const calls = [];
  return { calls, fetch: async (_, options) => {
    calls.push(JSON.parse(options.body));
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, json: async () => body };
  } };
}
test('structured response includes captions/images, excludes thoughts and joins text parts', async t => {
  const raw = JSON.stringify(good);
  const m = mock(t, [{ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'internal text' }, { text: raw.slice(0, 30) }, { text: raw.slice(30) },
  ] } }] }]);
  const result = await evaluateProfile({ ...snapshot, postMedia: [{ caption: snapshot.posts[0], images: [{ mimeType: 'image/jpeg', data: 'aW1hZ2U=' }] }] }, m.fetch);
  assert.equal(result.eligible, true);
  assert.equal(result.reviewedImageCount, 1);
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0].generationConfig.responseSchema.required, Object.keys(good));
  assert.equal(m.calls[0].generationConfig.thinkingConfig.thinkingBudget, 0);
});
for (const [name, body, error] of [
  ['truncated', candidate(JSON.stringify(good), 'MAX_TOKENS'), /bị cắt/],
  ['empty', { candidates: [] }, /phản hồi trống/],
  ['malformed', candidate('{"profileType":'), /JSON sai định dạng/],
  ['null', candidate('null'), /thiếu trường/],
  ['wrong fields', candidate(JSON.stringify({ ...good, confidence: 'high' })), /sai kiểu/],
  ['wrong evidence', candidate(JSON.stringify({ ...good, evidence: [123] })), /sai kiểu/],
]) {
  test(`${name}: retry once with same input and recover`, async t => {
    const m = mock(t, [body, valid]);
    assert.equal((await evaluateProfile(snapshot, m.fetch)).eligible, true);
    assert.equal(m.calls.length, 2);
    assert.deepEqual(m.calls[0].contents, m.calls[1].contents);
    assert.equal(m.calls[1].generationConfig.maxOutputTokens, 8192);
  });
  test(`${name}: repeated failure reports specific reason and stops`, async t => {
    const m = mock(t, [body]);
    await assert.rejects(evaluateProfile(snapshot, m.fetch), error);
    assert.equal(m.calls.length, 2);
  });
}
for (const body of [{ promptFeedback: { blockReason: 'SAFETY' } }, candidate('', 'SAFETY'), candidate('', 'RECITATION')]) {
  test('blocked responses are not retried', async t => {
    const m = mock(t, [body, valid]);
    await assert.rejects(evaluateProfile(snapshot, m.fetch), /chặn/);
    assert.equal(m.calls.length, 1);
  });
}
test('HTTP errors are not treated as malformed assessment', async t => {
  mock(t, []);
  let calls = 0;
  await assert.rejects(evaluateProfile(snapshot, async () => { calls++; return { ok: false, status: 429 }; }), /HTTP 429/);
  assert.equal(calls, 1);
});
test('recovered response still requires grounded evidence', async t => {
  const m = mock(t, [candidate(''), candidate(JSON.stringify({ ...good, evidence: ['fabricated product evidence'] }))]);
  assert.equal((await evaluateProfile(snapshot, m.fetch)).eligible, false);
});

for (const sellerUS of ['yes', 'no']) {
  for (const posts of [[], snapshot.posts.slice(0,2), ['Một ngày vui']]) {
    test(`insufficient posts override confident ${sellerUS} assessment (${posts.length})`, async t => {
      const m = mock(t, [candidate(JSON.stringify({ ...good, sellerUS, confidence: 1 }))]);
      const result = await evaluateProfile({ ...snapshot, posts }, m.fetch);
      assert.equal(result.sellerUS, 'unknown');
      assert.equal(result.confidence, null);
      assert.equal(result.eligible, false);
      assert.equal(result.insufficientData, true);
      assert.equal(result.reviewedPostCount, posts.length);
      assert.match(result.reason, /Chưa đủ dữ liệu/);
    });
  }
}
test('ungrounded negative result is unknown even with enough posts', async t => {
  const m = mock(t, [candidate(JSON.stringify({ ...good, sellerUS: 'no', confidence: 1, evidence: ['invented statement'] }))]);
  const result = await evaluateProfile(snapshot, m.fetch);
  assert.equal(result.sellerUS, 'unknown');
  assert.equal(result.confidence, null);
  assert.equal(result.eligible, false);
});

 test('empty collection never calls Gemini or infers a result from bio alone', async () => {
  const result = await evaluateProfile({ personalEvidence: true,
    bio: 'Chuyên săn sale hàng nội địa Hàn Quốc', posts: ['  '], postMedia: [] },
    async () => { throw new Error('Gemini must not be called'); });
  assert.equal(result.sellerUS, 'unknown');
  assert.equal(result.confidence, null);
  assert.equal(result.reviewedPostCount, 0);
  assert.equal(result.reviewedImageCount, 0);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.eligible, false);
 });
 test('photo-only collection still sends images to Gemini but stays ineligible', async t => {
  const m = mock(t, [valid]);
  const result = await evaluateProfile({ ...snapshot, posts: [''], postMedia: [
    { caption: '', images: [{ mimeType: 'image/jpeg', data: 'aW1hZ2U=' }] },
  ] }, m.fetch);
  assert.equal(m.calls.length, 1);
  assert.equal(result.reviewedImageCount, 1);
  assert.equal(result.sellerUS, 'unknown');
  assert.equal(result.eligible, false);
 });
