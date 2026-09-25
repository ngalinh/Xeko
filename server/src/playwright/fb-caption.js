'use strict';

const normalizeCaption = text => (text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();

// A successful clipboard write/key press does not prove React accepted the paste.
async function fillComposerCaption(page, editor, message) {
  const matches = async () => normalizeCaption(await editor.innerText()) === normalizeCaption(message);
  const confirm = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await matches()) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await editor.scrollIntoViewIfNeeded();
  if (await matches()) return true;
  try {
    await page.evaluate(async text => {
      let timer;
      try {
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Clipboard timeout')), 1500); }),
        ]);
      } finally { clearTimeout(timer); }
    }, message);
    await editor.click();
    await editor.press('ControlOrMeta+a');
    await editor.press('ControlOrMeta+v');
    if (await confirm()) return true;
  } catch { /* Clipboard permissions or paste can fail; replace in the same editor. */ }

  // Replace rather than append: a late/partial paste must not duplicate the caption.
  await editor.fill(message);
  return confirm();
}

module.exports = { fillComposerCaption, normalizeCaption };
