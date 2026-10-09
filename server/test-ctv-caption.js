const test = require('node:test');
const assert = require('node:assert/strict');
const { scanText, evaluateCaptions } = require('./src/ctv/caption-review');

test('brand variants retain original UTF-16 highlight offsets', () => {
  const text = '🔥 Áo C.K đủ size, giày N.i.k.e, ad!das và L@coste s🅰️le';
  const result = scanText(text);
  for (const brand of ['Calvin Klein','Nike','Adidas','Lacoste']) assert.ok(result.spans.some(s => s.label === brand), brand);
  for (const span of result.spans) assert.equal(text.slice(span.start,span.end), span.text);
  assert.equal(result.salesSignal, true);
});
test('abbreviations require context and payment CK is excluded', () => {
  assert.ok(!scanText('CK trước qua ngân hàng, STK 123').spans.some(s => s.kind === 'brand'));
  assert.equal(scanText('CK hôm nay').spans.find(s=>s.kind==='brand').certainty, 'possible');
  assert.equal(scanText('Áo CK đủ size').spans.find(s=>s.kind==='brand').certainty, 'clear');
  assert.ok(!scanText('Macbook Apple, laptop MAC').spans.some(s=>s.label==='MAC'));
  assert.ok(!scanText('coaching guessing nikefake').spans.some(s=>s.kind==='brand'));
});
test('review, buying requests and negation remain manual review', () => {
  for(const text of ['Không bán áo Nike','Review giày Nike sale','Ai bán áo CK','Cần mua túi Coach']) assert.equal(scanText(text).salesSignal,false,text);
  const result=evaluateCaptions({personalEvidence:true,bio:'Không tuyển CTV',posts:['Áo Nike có sẵn','Áo CK đủ size','Túi Coach nhận order từ Amazon']});
  assert.equal(result.eligible,false); assert.equal(result.sellerUS,'unknown'); assert.equal(result.wholesaleRecruitment.excluded,false);
  assert.equal(result.provider,'keywords'); assert.ok(result.retailers.includes('Amazon'));
});
test('deduplicates captions, preserves evidence and refuses empty/blocked collection', () => {
  const result=evaluateCaptions({posts:['Áo Nike có sẵn','Áo  Nike có sẵn','<script>alert(1)</script>']});
  assert.equal(result.reviewedPostCount,2); assert.equal(result.reviewedImageCount,0);
  assert.equal(result.captionReviews[1].text,'<script>alert(1)</script>');
  assert.equal(evaluateCaptions({posts:[]}).collectionBlocked,true);
  assert.equal(evaluateCaptions({blocked:'Không xem được',posts:['Áo Nike']}).collectionBlocked,true);
});
