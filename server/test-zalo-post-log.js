'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Trích đúng thân hàm app.post('/api/zalo/post', ...) từ index.js để test hành vi
// ghi log khi local server mất kết nối, không cần khởi động cả server thật.
function extractZaloPostHandlerBody() {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const start = source.indexOf("app.post(\'/api/zalo/post\'");
  assert.ok(start !== -1, 'không tìm thấy route /api/zalo/post');
  const marker = 'async (req, res) => {';
  const bodyStart = source.indexOf(marker, start) + marker.length;
  const bodyEnd = source.indexOf("\napp.get(\'/api/zalo/status/:jobId\'", start);
  assert.ok(bodyEnd !== -1, 'không tìm thấy điểm kết thúc route');
  let body = source.slice(bodyStart, bodyEnd);
  // Bỏ "});\n\n" còn sót ở cuối (đóng app.post(...)) trước khi wrap lại thành hàm chuẩn
  body = body.replace(/\}\);\s*$/, '');
  return body;
}

function makeHandler(deps) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const body = extractZaloPostHandlerBody();
  // "with" để thân hàm (vốn tham chiếu getLocalUrl/postLogger/... như biến tự do trong
  // index.js) đọc được từ deps mà không cần sửa lại source gốc.
  return new AsyncFunction('req', 'res', 'deps', `with (deps) { ${body} }`);
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

test('/api/zalo/post: local server mất kết nối → ghi log Failed, không biến mất khỏi dashboard', async () => {
  const logged = [];
  const handler = makeHandler();
  const deps = {
    getLocalUrl: () => null,
    postLogger: { logPost: args => logged.push(args) },
  };
  const req = {
    body: { zaloAccountName: 'Thuỳ Trang', groupName: 'Group test', message: 'Nội dung test' },
    files: [],
  };
  const res = makeRes();

  await handler(req, res, deps);

  assert.equal(res.statusCode, 503);
  assert.equal(logged.length, 1, 'phải ghi đúng 1 dòng log Failed');
  assert.equal(logged[0].success, false);
  assert.equal(logged[0].platform, 'zalo');
  assert.equal(logged[0].target, 'group');
  assert.equal(logged[0].profile, 'Thuỳ Trang');
  assert.equal(logged[0].groupName, 'Group test');
  assert.equal(logged[0].error, 'Local server chưa kết nối');
});
