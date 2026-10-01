const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BUSY_MESSAGE } = require('./src/utils/profile-context');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function extract(name) {
  const start = html.indexOf(`const ${name} = `) + `const ${name} = `.length;
  const end = html.indexOf('\n          };', start);
  return Function(`return (${html.slice(start, end + 12).trim()});`)();
}
test('profile collisions take priority over popup flags, timeout and login text', () => {
  const classify = extract('classifyFailure');
  const humanize = extract('humanizeFailReason');
  for (const raw of [BUSY_MESSAGE, 'browserType.launchPersistentContext: Opening in existing browser session. --disable-popup-blocking timeout']) {
    assert.equal(classify(raw).label, 'Hồ sơ đang mở');
    assert.match(humanize(raw), /Hồ sơ tài khoản đang được/);
    assert.doesNotMatch(humanize(raw), /ô tạo bài|hết hạn/);
  }
});
