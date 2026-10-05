const { profileUrl } = require('./rules');

// Runs in the About page. Read only an explicitly labelled, visible field.
function readGenderField() {
  const excluded = '[role="article"],article,[role="feed"],[role="dialog"],[role="navigation"],nav';
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const labels = /^(giới tính|gender)$/iu;
  const values = [];
  for (const root of document.querySelectorAll('[role="main"],main')) {
    for (const label of root.querySelectorAll('span,div,dt')) {
      if (!visible(label) || label.closest(excluded) || !labels.test((label.innerText || '').trim())) continue;
      let row = label.parentElement;
      for (let depth = 0; row && row !== root && depth < 3; depth++, row = row.parentElement) {
        if (!visible(row) || row.closest(excluded)) break;
        const lines = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length !== 2 || !lines.some(s => labels.test(s))) continue;
        const value = lines.find(s => !labels.test(s));
        if (!value || value.length > 100 || /^(edit|chỉnh sửa|public|công khai|only me|chỉ mình tôi)$/iu.test(value)) continue;
        values.push({ value, evidence: lines.join('\n') });
        break;
      }
    }
  }
  const distinct = [...new Map(values.map(v => [v.value, v])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

function sameProfile(actual, target) {
  try {
    const u = new URL(actual), t = new URL(target);
    if (!['www.facebook.com','facebook.com','m.facebook.com'].includes(u.hostname) || u.protocol !== 'https:') return false;
    if (t.pathname === '/profile.php') return u.pathname === '/profile.php' && u.searchParams.get('id') === t.searchParams.get('id');
    return u.pathname.replace(/\/about(?:_contact_and_basic_info)?\/?$/, '').replace(/\/$/, '') === t.pathname;
  } catch { return false; }
}

async function readSelfDeclaredGender(page, target, { check = () => {}, assertSession = async () => {} } = {}) {
  check();
  const profile = profileUrl(target), about = new URL(profile);
  if (about.pathname === '/profile.php') about.searchParams.set('sk','about_contact_and_basic_info');
  else about.pathname += '/about_contact_and_basic_info';
  const result = { status: 'unknown', value: null, sourceUrl: about.href, checkedAt: new Date().toISOString(), reason: 'Không thấy mục Giới tính tự khai hiển thị.' };
  let tab;
  try {
    tab = await page.context().newPage();
    await tab.goto(about.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    check(); await assertSession(tab);
    if (!sameProfile(tab.url(), profile)) return { ...result, reason: 'Trang Giới thiệu chuyển hướng sang trang khác; không lấy dữ liệu.' };
    let found;
    for (let attempt = 0; attempt < 4; attempt++) {
      check();
      if (!sameProfile(tab.url(), profile)) return result;
      found = await tab.evaluate(readGenderField);
      if (found?.value && typeof found.value === 'string') break;
      if (attempt < 3) await tab.waitForTimeout(750);
    }
    check();
    if (found?.value && typeof found.value === 'string') return { ...result, status: 'self_declared', value: found.value, evidence: found.evidence, sourceUrl: tab.url(), reason: '' };
    return result;
  } catch {
    check();
    return { ...result, reason: 'Không đọc được mục Giới tính tự khai; thông tin có thể bị ẩn hoặc trang chưa sẵn sàng.' };
  } finally { if (tab) await tab.close().catch(() => {}); }
}

module.exports = { readSelfDeclaredGender, readGenderField, sameProfile };
