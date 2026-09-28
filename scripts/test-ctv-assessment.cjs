const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ctv.js'), 'utf8');
const context = {element: (tag, text, cls) => ({tag, text, cls, children:[], append(...nodes) {this.children.push(...nodes);}})};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function renderAssessment('), source.indexOf('  const urlsFrom')), context);
test('preview defaults to a seller verdict and closed native details containing five sections', () => {
  const preview = context.renderAssessmentPreview({sellerUS:'yes',type:'page',confidence:1});
  assert.equal(preview.children[0].text, 'Seller bán sản phẩm trên website Mỹ: Có');
  const details = preview.children[1];
  assert.equal(details.tag, 'details'); assert.notEqual(details.open, true);
  assert.equal(details.children[0].tag, 'summary');
  assert.deepEqual(details.children[0].children.map(n=>n.text), ['Xem chi tiết','Thu gọn']);
  assert.equal(details.children[1].children.length, 5);
});
test('unselectable Fanpage explains the personal-profile gate, not seller confidence', () => {
  assert.match(context.selectionExplanation({assessment:{eligible:false,type:'page',sellerUS:'yes',confidence:1}}), /Fanpage.*chỉ cho chọn profile cá nhân/);
  assert.equal(context.selectionExplanation({assessment:{eligible:true},selectionBlockedReason:'Đã liên hệ'}), 'Đã liên hệ');
});
test('assessment renders five distinct numbered sections as text, including multiline captions', () => {
  const v = {type:'page',sellerUS:'yes',confidence:.97,name:'<img src=x onerror=alert(1)>',bio:'Bio gốc',brands:['Nike','Coach'],captionAnalysis:'Bài 1: bán giày.\nBài 2: bán túi.'};
  const list = context.renderAssessment(v);
  assert.equal(list.tag, 'ol'); assert.equal(list.children.length, 5);
  const values = list.children.map(item => item.children[1].text);
  assert.deepEqual(values, ['Fanpage - Bán sản phẩm có trên website Mỹ - Có - 97%',v.name,v.bio,'Nike, Coach',v.captionAnalysis]);
  assert.ok(list.children.every(item => item.tag === 'li' && item.children[0].tag === 'strong'));
});
test('legacy assessment shows missing fields honestly and retains the previous analysis', () => {
  const list = context.renderAssessment({type:'group',sellerUS:'unknown',confidence:null,reason:'Phân tích cũ'});
  const values = list.children.map(item => item.children[1].text);
  assert.match(values[0], /^Group.*Chưa rõ.*Chưa đủ dữ liệu$/);
  assert.equal(values[1], 'Chưa đọc được tên Facebook');
  assert.equal(values[2], 'Chưa có dữ liệu bio');
  assert.equal(values[3], 'Chưa xác định được thương hiệu');
  assert.equal(values[4], 'Phân tích cũ');
});
