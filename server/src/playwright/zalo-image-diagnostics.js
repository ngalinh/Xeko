'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function readComposerDiagnostics() {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const buttons = [...document.querySelectorAll('button.send-btn, button')]
    .filter(el => visible(el) && (el.matches('.send-btn') || /^(Gửi|Send)$/i.test(el.textContent.trim())))
    .map(el => ({ label: (el.textContent || '').trim().slice(0, 40), disabled: !!el.disabled,
      ariaDisabled: el.getAttribute('aria-disabled'), busy: el.getAttribute('aria-busy') })).slice(0, 5);
  const notices = [...document.querySelectorAll('[role="alert"], .v-snackbar__content, .v-messages__message')]
    .filter(visible).map(el => (el.textContent || '').trim().slice(0, 300)).slice(0, 5);
  const headers = [...document.querySelectorAll('.thread-header .thread-name, .thread-header .conv-name, .conversation-active .conv-name')]
    .filter(visible).map(el => (el.textContent || '').trim().slice(0, 200)).slice(0, 5);
  return { buttons, notices, headers,
    progressBars: [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].filter(visible).length };
}

function startImageDiagnostics(page, metadata, { directory, logger, readImageState }) {
  const id = 'zalo-images-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const started = Date.now(), requests = new WeakMap(), pending = new Set();
  const record = { id, ...metadata, events: [], checkpoints: [] };
  const endpoint = raw => { try { const u = new URL(raw); return u.origin + u.pathname; } catch { return 'unknown'; } };
  const push = event => { record.events.push({ ms: Date.now() - started, ...event }); if (record.events.length > 80) record.events.shift(); };
  const onRequest = req => {
    if (!['xhr', 'fetch'].includes(req.resourceType()) || /^(GET|HEAD|OPTIONS)$/i.test(req.method())) return;
    const item = { method: req.method(), endpoint: endpoint(req.url()) };
    requests.set(req, item); pending.add(req);
    push({ type: 'request', ...item });
  };
  const onResponse = res => { const item = requests.get(res.request()); if (item) push({ type: 'response', ...item, status: res.status() }); };
  const onFinished = req => { pending.delete(req); };
  const onFailed = req => {
    const item = requests.get(req);
    if (item) push({ type: 'requestfailed', ...item, error: (req.failure()?.errorText || '').slice(0, 200) });
    pending.delete(req);
  };
  const handlers = { request: onRequest, response: onResponse, requestfinished: onFinished, requestfailed: onFailed };
  for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);

  async function checkpoint(stage, detail = {}) {
    record.phase = stage;
    const entry = { stage, ms: Date.now() - started, pendingWrites: pending.size, ...detail };
    try {
      let timer;
      const snapshot = await Promise.race([
        Promise.all([readImageState(page), page.evaluate(readComposerDiagnostics)]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic snapshot timeout')), 2000); })
      ]).finally(() => clearTimeout(timer));
      const [state, composer] = snapshot;
      entry.images = { composerPresent: state.composerPresent, composerImages: state.composerSources?.length,
        threadImages: state.threadSources?.length, composerBlob: state.composerBlob, threadBlob: state.threadBlob, http: state.http };
      entry.composer = composer;
    } catch (e) { entry.snapshotError = e.message.slice(0, 200); }
    record.checkpoints.push(entry);
    if (record.checkpoints.length > 12) record.checkpoints.shift();
    logger.info('[basso][image-diag] ' + JSON.stringify({ id, ...entry }));
  }
  async function saveFailure(error) {
    // Diagnostics must never replace the original error or cause a resend.
    try {
      await checkpoint('failure', { error: error.message, deliveryUnknown: !!error.deliveryUnknown });
      fs.mkdirSync(directory, { recursive: true });
      const name = id + '.png';
      try {
        await page.screenshot({ path: path.join(directory, name), fullPage: false, timeout: 5000 });
        error.message += ' (screenshot=' + name + ')';
      } catch (e) { record.screenshotError = e.message; }
      fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify(record, null, 2));
      logger.warn('[basso][image-diag] saved ' + id + '.json');
    } catch (e) { logger.warn('[basso][image-diag] save failed: ' + e.message); }
  }
  return { checkpoint, saveFailure, stop() {
    for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
    pending.clear();
  } };
}
module.exports = { startImageDiagnostics, readComposerDiagnostics };
