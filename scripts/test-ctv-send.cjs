const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ctv.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  function sendCategory('), source.indexOf('  const openSendDetails')), context);

test('unconfirmed deliveries remain attention items, never sent or pending', () => {
  assert.equal(context.sendCategory({state:'unconfirmed'}),'attention');
  assert.equal(context.sendCategory({state:'sent'}),'sent');
  assert.equal(context.sendCategory({state:'qualified'}),'pending');
  assert.equal(context.sendCategory({state:'sending'}),'pending');
  assert.equal(context.sendCategory({state:'review',error:'timeout'}),'attention');
  assert.equal(context.sendCategory({state:'duplicate'}),'duplicate');
});
test('uncertain send guidance takes precedence over a timeout error', () => {
  const text=context.sendIssue({state:'unconfirmed',error:'Timeout 15000ms exceeded'});
  assert.match(text,/Chưa xác nhận.*kiểm tra/);
  assert.doesNotMatch(text,/Không mở được ô soạn/);
});
test('timeouts and checkpoint diagnostics become actionable Vietnamese text', () => {
  assert.match(context.sendIssue({state:'review',error:'locator.waitFor: Timeout 15000ms exceeded'}),/Không mở được ô soạn tin/);
  assert.match(context.sendIssue({state:'review',error:'checkpoint'}),/Quản lý tài khoản/);
  assert.match(context.sendIssue({state:'review',error:'Browser closed'}),/Kết nối trình duyệt đã đóng/);
  assert.doesNotMatch(context.sendIssue({state:'review',error:'some internal selector'}),/internal selector/);
});
test('technical details retain the original diagnostic without ANSI escape sequences', () => {
  assert.equal(context.cleanDiagnostic('\u001b[2mTimeout 15000ms\u001b[22m\nlocator([role=main])'),'Timeout 15000ms\nlocator([role=main])');
  assert.equal(context.cleanDiagnostic(null),'');
});
