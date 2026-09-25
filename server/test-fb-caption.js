'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fillComposerCaption, normalizeCaption } = require('./src/playwright/fb-caption');

function fixture({ paste = 'success', fill = true, initial = '' } = {}) {
  let value = initial, clipboard = '', fills = 0;
  const keys = [];
  const page = {
    evaluate: async (_, message) => {
      if (paste === 'denied') throw new Error('clipboard denied');
      clipboard = message;
    },
    waitForTimeout: async () => {},
  };
  const editor = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    innerText: async () => value,
    press: async key => {
      keys.push(key);
      if (key.endsWith('+v')) {
        if (paste === 'success') value = clipboard;
        if (paste === 'partial') value = clipboard.slice(0, 4);
      }
    },
    fill: async message => { fills++; if (fill) value = message; },
  };
  return { page, editor, keys, value: () => value, fills: () => fills };
}
const caption = 'Áo mới 👗\nGiá: 250.000đ\nInbox nhé!';
test('successful paste is read back and preserves multiline Vietnamese caption', async () => {
  const f = fixture();
  assert.equal(await fillComposerCaption(f.page, f.editor, caption), true);
  assert.equal(f.value(), caption);
  assert.equal(f.fills(), 0);
  assert.deepEqual(f.keys, ['ControlOrMeta+a', 'ControlOrMeta+v']);
});
for (const paste of ['denied', 'noop', 'partial']) {
  test(paste + ' clipboard paste falls back without duplicating text', async () => {
    const f = fixture({ paste, initial: 'old draft' });
    assert.equal(await fillComposerCaption(f.page, f.editor, caption), true);
    assert.equal(f.value(), caption);
    assert.equal(f.fills(), 1);
  });
}
test('silent paste and fill failure cannot be reported as success', async () => {
  const f = fixture({ paste: 'noop', fill: false });
  assert.equal(await fillComposerCaption(f.page, f.editor, caption), false);
});
test('matching draft is not pasted twice', async () => {
  const f = fixture({ initial: caption });
  assert.equal(await fillComposerCaption(f.page, f.editor, caption), true);
  assert.equal(f.keys.length, 0);
  assert.equal(f.fills(), 0);
});
test('normalization tolerates DOM line endings and NBSP but keeps line breaks', () => {
  assert.equal(normalizeCaption(' A\u00a0B\r\nC\n'), 'A B\nC');
  assert.notEqual(normalizeCaption('A\nB'), normalizeCaption('AB'));
});
