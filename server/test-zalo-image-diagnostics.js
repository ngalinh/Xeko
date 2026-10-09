'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startImageDiagnostics } = require('./src/playwright/zalo-image-diagnostics');
function setup(t, screenshotFails = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-diag-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const page = new EventEmitter();
  let screenshots = 0;
  page.evaluate = async () => ({ buttons: [{ disabled: true }], notices: ['Upload failed'], headers: ['Group A'] });
  page.screenshot = async ({path: file}) => {
    screenshots++;
    if (screenshotFails) throw new Error('page closed');
    fs.writeFileSync(file, 'fixture');
  };
  const diagnostics = startImageDiagnostics(page, { account: 'Account A', group: 'Group A', expectedImages: 2 }, {
    directory, logger: { info() {}, warn() {} },
    readImageState: async () => ({ composerPresent: true, composerSources: ['blob:a', 'blob:b'], threadSources: ['https://cdn.test/secret'], composerBlob: 2 })
  });
  const request = { resourceType: () => 'fetch', method: () => 'POST',
    url: () => 'https://crm.test/upload?token=secret', failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
  return { page, directory, diagnostics, request, screenshots: () => screenshots };
}
test('records upload failure and phase; saves screenshot link and bounded network metadata', async t => {
  const s = setup(t);
  s.page.emit('request', s.request);
  s.page.emit('response', { request: () => s.request, status: () => 500 });
  s.page.emit('requestfailed', s.request);
  await s.diagnostics.checkpoint('upload-wait', { networkIdle: false });
  const error = Object.assign(new Error('Delivery unknown'), { deliveryUnknown: true });
  await s.diagnostics.saveFailure(error);
  s.diagnostics.stop();
  const json = fs.readdirSync(s.directory).find(file => file.endsWith('.json'));
  const raw = fs.readFileSync(path.join(s.directory, json), 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.group, 'Group A');
  assert.equal(record.events.find(e => e.type === 'response').status, 500);
  assert.equal(record.checkpoints[0].images.composerImages, 2);
  assert.equal(record.checkpoints[0].networkIdle, false);
  assert.equal(record.checkpoints.at(-1).deliveryUnknown, true);
  assert.match(error.message, /screenshot=zalo-images-.*\.png/);
  assert.equal(s.screenshots(), 1);
  assert.equal(raw.includes('secret'), false, 'no query strings, image URLs or request bodies');
  for (const event of ['request','response','requestfinished','requestfailed']) assert.equal(s.page.listenerCount(event), 0);
});
test('closed page cannot hide original error; diagnostic JSON still saved', async t => {
  const s = setup(t, true);
  s.page.evaluate = async () => { throw new Error('closed'); };
  const error = new Error('Original failure');
  await s.diagnostics.saveFailure(error);
  s.diagnostics.stop();
  assert.equal(error.message, 'Original failure');
  const record = JSON.parse(fs.readFileSync(path.join(s.directory, fs.readdirSync(s.directory)[0]), 'utf8'));
  assert.equal(record.screenshotError, 'page closed');
  assert.equal(record.checkpoints[0].snapshotError, 'closed');
});
test('network buffer remains bounded and late events stop after cleanup', async t => {
  const s = setup(t);
  for (let i = 0; i < 200; i++) {
    s.page.emit('request', s.request);
    s.page.emit('requestfinished', s.request);
  }
  s.diagnostics.stop();
  s.page.emit('request', s.request);
  await s.diagnostics.saveFailure(new Error('Failed'));
  const json = fs.readdirSync(s.directory).find(file => file.endsWith('.json'));
  const record = JSON.parse(fs.readFileSync(path.join(s.directory, json), 'utf8'));
  assert.equal(record.events.length, 80);
});
