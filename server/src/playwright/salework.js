const { safeLaunchPersistentContext } = require('../utils/playwright-launch');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getZaloProxyForAccount } = require('../utils/proxy');
const { randomDelay, humanType } = require('../utils/delay');
const { getProfileDeviceFingerprint } = require('../utils/device-fingerprint');
const { checkProxy } = require('../utils/proxy-health');

const DEBUG_SCREENSHOT_DIR = '/tmp/salework-debug';

function getSaleworkProfile(accountKey) {
  return path.resolve(__dirname, `../../../playwright-data/salework-${accountKey}`);
}

function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_SCREENSHOT_DIR)) {
    fs.mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
  }
}

async function screenshot(page, label) {
  try {
    ensureDebugDir();
    const filePath = `${DEBUG_SCREENSHOT_DIR}/${Date.now()}-${label}.png`;
    await Promise.race([
      page.screenshot({ path: filePath, fullPage: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 5000)),
    ]);
    logger.info(`[salework] screenshot: ${filePath}`);
  } catch {}
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Hàm dùng chung (inject vào page.evaluate) để lấy CÁC TAG account thật trong ô
// el-select. QUAN TRỌNG: selector '[class*="tag"]' khớp cả container `.el-tag`
// LẪN các con của nó (span text, icon close `.el-tag__close`) → 1 tag bị đếm
// thành 3-4 "tag" ("Linh Thảo Us A... | Linh Thảo Us A... | ... | "). Vì vậy chỉ
// giữ phần tử NGOÀI CÙNG (không nằm trong phần tử khác đã khớp).
const TAG_HELPER = `
  function _xekoVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function _xekoTagEls() {
    const root = document.querySelector('.el-select') || document.querySelector('[class*="select"]');
    if (!root) return [];
    let els = Array.from(root.querySelectorAll('.el-tag'));   // ưu tiên container tag thật
    if (!els.length) {
      const all = Array.from(root.querySelectorAll('[class*="tag"]'));
      els = all.filter(el => !all.some(o => o !== el && o.contains(el))); // bỏ phần tử con
    }
    // Chỉ giữ tag ĐANG HIỂN THỊ — tránh đếm tag ẩn/đo kích thước của Element UI
    // làm 1 account nhìn thành nhiều tag → read-back huỷ oan.
    return els.filter(_xekoVisible);
  }
  // Lấy tên đầy đủ của 1 tag: dùng textContent hiển thị; CHỈ thay bằng 'title'
  // khi title NỐI DÀI phần text nhìn thấy (đó là tên đầy đủ bị cắt ellipsis).
  // Tránh vớ nhầm title của nút xoá ("Remove"/"Xóa") hay icon con.
  function _xekoTagText(t) {
    const norm = s => (s || '').normalize('NFC').trim();
    const own = norm(t.textContent);
    const ownStripped = own.replace(/[\\s.…]+$/, '');
    const titles = [t, ...Array.from(t.querySelectorAll('[title]'))]
      .map(e => norm(e.getAttribute && e.getAttribute('title')))
      .filter(Boolean);
    const full = ownStripped.length >= 3 ? titles.find(tt => tt.startsWith(ownStripped)) : null;
    return full || own;
  }
`;

// Đếm số tag (account đang chọn) đang hiển thị trong ô el-select.
async function countSelectedTags(page) {
  return page.evaluate(`(() => { ${TAG_HELPER} return _xekoTagEls().length; })()`);
}

async function selectZaloAccount(page, accountName) {
  logger.info(`[salework] Chọn tài khoản: ${accountName}`);

  // Bước 1: Clear tất cả selection cũ (dropdown là multi-select).
  //
  // QUAN TRỌNG: Salework chạy trên persistent profile và NHỚ lựa chọn của lần
  // đăng trước (mỗi post mở lại browser → ô đã có sẵn tag cũ). Nếu không xoá
  // sạch, read-back sẽ thấy nhiều tag "Linh Thảo Us A... | ..." (tên bị cắt
  // ellipsis nên các account khác nhau trông y hệt) → huỷ đăng. Vì vậy phải
  // xoá rồi XÁC MINH ô đã trống, thử lại nếu còn sót.
  const clearTags = async () => {
    let n = 0;
    while (n < 30) {
      const removed = await page.evaluate(() => {
        const closeIcons = document.querySelectorAll(
          '.el-tag .el-tag__close, .el-tag .el-icon-close, .el-select__tags .el-tag i, ' +
          '.el-tag__close, .el-icon-close, [class*="tag"] [class*="close"], [class*="tag"] i'
        );
        for (const icon of closeIcons) {
          if (icon.offsetParent !== null) { icon.click(); return true; }
        }
        return false;
      });
      if (!removed) break;
      await delay(200);
      n++;
    }
    return n;
  };

  let cleared = await clearTags();
  if (await countSelectedTags(page) > 0) cleared += await clearTags(); // 1 lượt vét nữa
  if (cleared > 0) logger.info(`[salework] Xoá ${cleared} tag cũ`);
  const leftover = await countSelectedTags(page);
  if (leftover > 0) {
    logger.warn(`[salework] Vẫn còn ${leftover} tag sau khi xoá — read-back sẽ kiểm tra lại trước khi đăng`);
  }

  // Bước 2-4: gói trong attemptSelect() để CÓ THỂ THỬ LẠI.
  //
  // QUAN TRỌNG (bug đã gặp): Salework chạy trên persistent profile và nhớ lựa
  // chọn lần trước → mở lên ô đã sẵn tag account đúng (option ở trạng thái
  // "selected"). Dropdown là multi-select Element UI: BẤM LẠI một option ĐANG
  // được chọn sẽ BỎ CHỌN nó → ô về 0 tag → read-back tưởng "không chọn được" →
  // huỷ oan. Vì vậy: nếu option đã được chọn sẵn thì KHÔNG click; và nếu sau khi
  // chọn ô vẫn TRỐNG thì thử lại 1 lần (lần sau option không còn selected nên
  // click sẽ chọn lại đúng).
  const attemptSelect = async () => {
    // Bước 2: Mở dropdown
    const openSelectors = [
      '.el-select',
      '.el-select .el-input__inner',
      '.el-select__caret',
    ];
    for (const sel of openSelectors) {
      try {
        await page.click(sel, { force: true, timeout: 3000 });
        logger.info(`[salework] Mở dropdown bằng: ${sel}`);
        break;
      } catch {}
    }
    await delay(1500);

    // Bước 3: Đánh dấu đúng option trong dropdown rồi click bằng LOCATOR.
    //
    // QUAN TRỌNG: trước đây dùng page.mouse.click(x, y) theo toạ độ
    // getBoundingClientRect. Option có thể nằm DƯỚI mép viewport (đã gặp y=1193
    // khi viewport chỉ cao ≤1080) → click bắn ra ngoài màn hình, TRƯỢT hoàn toàn,
    // dropdown vẫn ở "Tất cả tài khoản" → bài bị đăng bằng tài khoản mặc định
    // (đăng NHẦM account). Dùng locator.click() vì nó tự scrollIntoView option
    // vào tầm nhìn trước khi click, không phụ thuộc toạ độ tuyệt đối.
    await page.evaluate(() => {
      document.querySelectorAll('[data-xeko-pick]').forEach(el => el.removeAttribute('data-xeko-pick'));
    });
    // Tên account trong Salework hay bị CẮT ellipsis ("Linh Thảo Us A...") nên
    // nhiều account khác nhau cùng prefix (Authentic / America / ...) trông y hệt.
    // Quy tắc chọn để KHÔNG đoán bừa (đoán bừa = chọn nhầm account):
    //   1. Khớp CHÍNH XÁC tên đầy đủ (ưu tiên đọc `title` = tên đầy đủ khi bị cắt,
    //      fallback textContent). Nếu có NHIỀU dòng khớp chính xác cùng tên → vẫn
    //      LÀ account cần đăng (Salework render lặp / kết nối trùng) → bấm dòng đầu,
    //      ưu tiên option thật trong dropdown. KHÔNG từ chối.
    //   2. Nếu chỉ khớp prefix (option bị cắt), CHỈ chấp nhận khi có ĐÚNG 1 ứng viên.
    //      >1 ứng viên prefix khác nhau = mơ hồ thật → bỏ, để read-back huỷ đăng.
    const mark = await page.evaluate((name) => {
      const norm = s => (s || '').normalize('NFC').trim();
      const normName = norm(name);
      const fullText = el => norm(el.getAttribute && el.getAttribute('title')) || norm(el.textContent);
      // Option đã được CHỌN SẴN chưa? Element UI gắn class "selected"/"is-selected"
      // (hoặc aria-selected="true") lên item đang chọn. Dò lên vài cấp phòng khi
      // phần tử khớp là span con bên trong item.
      const isSelectedOpt = (el) => {
        let n = el;
        for (let i = 0; i < 4 && n; i++) {
          if (n.classList && (n.classList.contains('selected') || n.classList.contains('is-selected'))) return true;
          if (n.getAttribute && n.getAttribute('aria-selected') === 'true') return true;
          n = n.parentElement;
        }
        return false;
      };

      const candidates = [];
      const scan = (els, isOption) => {
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const full = fullText(el);                       // tên đầy đủ (ưu tiên title)
          const vis = norm(el.textContent);                // text hiển thị (có thể bị cắt)
          const visStripped = vis.replace(/[\s.…]+$/, '');
          const exact =
            full === normName ||
            full.startsWith(normName + ' ') || full.startsWith(normName + '\n');
          const prefix = !exact && visStripped.length >= 6 && normName.startsWith(visStripped);
          if (exact) candidates.push({ el, exact: true, isOption });
          else if (prefix) candidates.push({ el, exact: false, isOption });
        }
      };

      // Pass 1: option thật trong dropdown (đánh dấu isOption để ưu tiên khi bấm)
      scan(document.querySelectorAll('.el-select-dropdown__item, [class*="dropdown"] li, [class*="option"], li'), true);
      // Pass 2: fallback rộng hơn nếu Salework đổi cấu trúc DOM
      if (!candidates.length) scan(document.querySelectorAll('[class*="item"], div, span, a'), false);

      const exacts = candidates.filter(c => c.exact);
      let chosen = null, reason = 'none';
      if (exacts.length) {
        // Mọi exact đều cùng tên đầy đủ = cùng 1 account → bấm cái đầu (ưu tiên option thật).
        const pick = exacts.find(c => c.isOption) || exacts[0];
        chosen = pick.el;
        reason = exacts.length === 1 ? 'exact' : `exact x${exacts.length}`;
      } else if (candidates.length === 1) {
        chosen = candidates[0].el; reason = 'prefix-duy-nhất';
      } else if (candidates.length > 1) {
        reason = `mơ hồ: ${candidates.length} option bị cắt cùng prefix`;
      }

      if (chosen) chosen.setAttribute('data-xeko-pick', '1');
      return { ok: !!chosen, reason, alreadySelected: chosen ? isSelectedOpt(chosen) : false };
    }, accountName);

    if (mark.ok && mark.alreadySelected) {
      // Đã được chọn sẵn (profile nhớ lần trước) — KHÔNG click lại kẻo bỏ chọn.
      logger.info(`[salework] Option "${accountName}" đã được chọn sẵn (${mark.reason}) — không click lại để tránh bỏ chọn`);
    } else if (mark.ok) {
      const opt = page.locator('[data-xeko-pick="1"]').first();
      try { await opt.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
      try {
        await opt.click({ timeout: 5000 });
        logger.info(`[salework] Đã click option tài khoản: ${accountName} (${mark.reason})`);
      } catch (e) {
        logger.warn(`[salework] Click option lỗi: ${e.message}`);
      }
      await delay(1000);
    } else {
      logger.warn(`[salework] Không chọn được option rõ ràng cho "${accountName}" (${mark.reason}) — để read-back quyết định huỷ`);
    }

    // Click ra ngoài để đóng dropdown (luôn làm để read-back đọc đúng nhãn ô)
    await page.click('body', { position: { x: 700, y: 400 }, force: true }).catch(() => {});
    await delay(1000);

    // Bước 4: READ-BACK — đọc lại nhãn ô tài khoản đang hiển thị để XÁC MINH đã
    // chọn đúng. Không bao giờ tin "đã click" là "đã chọn". Nếu ô vẫn ở "Tất cả
    // tài khoản" / trống / khác tên yêu cầu → trả false để caller HUỶ đăng.
    // Trả về MẢNG nhãn từng tag (ưu tiên `title` = tên đầy đủ khi bị cắt ellipsis).
    // Dùng _xekoTagEls() để CHỈ đếm container tag thật — tránh 1 account bị tách
    // thành nhiều "tag" do span/icon con khiến read-back tưởng đang chọn nhiều account.
    const tags = await page.evaluate(`(() => {
      ${TAG_HELPER}
      const norm = s => (s || '').normalize('NFC').trim();
      const root = document.querySelector('.el-select') || document.querySelector('[class*="select"]');
      if (!root) return [];
      const tags = _xekoTagEls();
      if (tags.length) {
        return tags.map(t => _xekoTagText(t)).filter(Boolean);
      }
      const input = root.querySelector('input');
      if (input && norm(input.value)) return [norm(input.value)];
      const txt = norm(root.textContent);
      return txt ? [txt] : [];
    })()`);
    logger.info(`[salework] Ô tài khoản sau khi chọn (${tags.length} tag): ${JSON.stringify(tags)}`);
    return { tags, alreadySelected: mark.alreadySelected };
  };

  let { tags: tagTexts, alreadySelected: wasAlreadySelected } = await attemptSelect();
  // Ô về TRỐNG sau lần chọn đầu — rất có thể cú click vừa BỎ CHỌN tag đã sẵn có.
  // Thử lại 1 lần: lần này option không còn ở trạng thái selected nên click sẽ
  // chọn lại đúng (clearTags đã chạy nên không sợ lẫn tag rác).
  // KHÔNG retry nếu lần đầu bỏ qua click vì alreadySelected=true — lần sau cũng
  // bỏ qua y hệt, retry không giải quyết được gì.
  if (tagTexts.length === 0 && !wasAlreadySelected) {
    logger.warn('[salework] Ô tài khoản TRỐNG sau lần chọn đầu — thử chọn lại 1 lần');
    ({ tags: tagTexts } = await attemptSelect());
  }
  const selectedText = tagTexts.join(' | ');

  const lc = s => (s || '').normalize('NFC').trim().toLowerCase();
  const want = lc(accountName);

  // Gộp các tag TRÙNG NHAU (Element UI đôi khi render lặp 1 account) → chỉ xét
  // số account KHÁC BIỆT đang chọn.
  const distinct = [...new Set(tagTexts.map(lc).filter(t => t && !t.includes('tất cả')))];

  // XÁC MINH:
  //   - Phải đang chọn ĐÚNG 1 account khác biệt (không lẫn account khác → tránh
  //     đăng nhầm/đăng đồng thời nhiều account).
  //   - Account đó phải là cái cần đăng: khớp đủ, "tên | sđt", hoặc prefix khi bị
  //     cắt ellipsis (giờ an toàn vì đã chắc chỉ có 1 account khác biệt).
  let matched = false;
  if (distinct.length === 1) {
    const lt = distinct[0];
    const ltStripped = lt.replace(/[\s.…]+$/, '');
    matched =
      lt === want ||
      lt.includes(want) ||
      (ltStripped.length >= 6 && want.startsWith(ltStripped));
  } else if (distinct.length > 1) {
    // Nhiều account khác nhau: chỉ chấp nhận nếu TẤT CẢ đều chính là account cần đăng.
    matched = distinct.every(lt => lt === want || lt.includes(want));
  }

  if (matched) {
    logger.info(`[salework] ✓ Xác minh đã chọn đúng tài khoản: ${accountName}`);
    return true;
  }

  logger.error(`[salework] ✗ Không chọn được tài khoản "${accountName}" — ô đang là "${selectedText || '(trống)'}"`);
  return false;
}

async function searchAndClickGroup(page, groupName) {
  logger.info(`[salework] Tìm nhóm: ${groupName}`);

  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    await delay(2500);
  }

  await screenshot(page, '03-search-filled');

  // Dùng page.evaluate để lấy tọa độ (1 round-trip), rồi page.mouse.click()
  // để fire đầy đủ pointer events mà Vue.js yêu cầu.
  const rect = await page.evaluate((name) => {
    const norm = s => s.normalize('NFC').trim();
    const normName = norm(name);

    // Contact row trong Salework luôn có kích thước hợp lý: rộng >150px, cao 30-200px
    const isRow = (r) => r.width > 150 && r.height > 30 && r.height < 200
                      && r.top >= 0 && r.top < window.innerHeight;

    // Pass 1: selector có class liên quan đến conversation/contact/item
    const pass1 = document.querySelectorAll(
      '[class*="conversation"], [class*="contact"], [class*="chat"], ' +
      '[class*="list-item"], [class*="message-item"], li, a[href]'
    );
    for (const el of pass1) {
      if (!norm(el.textContent || '').includes(normName)) continue;
      const r = el.getBoundingClientRect();
      if (isRow(r)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: 'pass1' };
    }

    // Pass 2: bất kỳ div/li nào có kích thước trông như một hàng danh sách
    const pass2 = document.querySelectorAll('div, li');
    for (const el of pass2) {
      if (!norm(el.textContent || '').includes(normName)) continue;
      const r = el.getBoundingClientRect();
      if (isRow(r)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: 'pass2' };
    }
    return null;
  }, groupName);

  await screenshot(page, '03b-before-click');

  if (rect) {
    logger.info(`[salework] [${rect.src}] Click (${Math.round(rect.x)}, ${Math.round(rect.y)}) cho: ${groupName}`);
    await page.mouse.click(rect.x, rect.y);
    await delay(1000);
    await screenshot(page, '03c-after-click');
    await delay(1500);
    return true;
  }

  logger.error(`[salework] Không tìm thấy element cho: ${groupName}`);
  return false;
}

async function sendMessage(page, message, imagePaths = []) {
  logger.info(`[salework] Gửi: "${message?.substring(0, 30)}" + ${imagePaths.length} ảnh`);

  if (imagePaths.length > 0) {
    let uploaded = false;

    // Thử 1: setInputFiles trực tiếp
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        logger.info(`[salework] Upload ${imagePaths.length} ảnh (direct)`);
        break;
      } catch { continue; }
    }

    // Thử 2: filechooser — Promise.all như code cũ
    if (!uploaded) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            const toolbar = await page.$$('[class*="toolbar"] button, [class*="toolbar"] div[role="button"], [class*="action"] svg');
            for (const btn of toolbar) {
              const title = await btn.getAttribute('title').catch(() => '');
              if (title?.includes('nh') || title?.includes('image') || title?.includes('hoto')) {
                await btn.click();
                return;
              }
            }
            const icons = await page.$$('svg, [class*="icon"]');
            for (const icon of icons) {
              const parent = await icon.$('xpath=..');
              const title = await parent?.getAttribute('title').catch(() => '');
              if (title?.includes('Hình') || title?.includes('ảnh') || title?.includes('image')) {
                await icon.click();
                return;
              }
            }
          })(),
        ]);
        await fileChooser.setFiles(imagePaths);
        uploaded = true;
        logger.info(`[salework] Upload ${imagePaths.length} ảnh (filechooser)`);
      } catch (e) {
        logger.error(`[salework] Upload thất bại: ${e.message}`);
      }
    }

    await delay(2000);
    await screenshot(page, '05-after-upload');
  }

  if (message) {
    // CHỈ lấy element đang HIỂN THỊ (:visible) — tránh vớ phải textarea/contenteditable
    // ẩn (modal đóng, conversation khác) khiến click chờ 30s rồi ném lỗi dù tin đã gửi.
    // Fallback selector gốc nếu vì lý do nào đó query :visible không trả về (an toàn).
    const msgInput =
      (await page.$('[placeholder*="Nhập tin nhắn"]:visible, [placeholder*="nhập tin nhắn"]:visible, [contenteditable="true"]:visible, textarea:visible').catch(() => null))
      || (await page.$('[placeholder*="Nhập tin nhắn"], [placeholder*="nhập tin nhắn"], [contenteditable="true"], textarea').catch(() => null));
    if (msgInput) {
      await randomDelay(200, 500);
      // Click để focus; nếu element chập chờn → focus bằng JS thay vì ném lỗi (timeout ngắn 5s).
      try {
        await msgInput.click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[salework] Click ô nhập tin lỗi (${e.message}) → focus bằng JS`);
        await msgInput.evaluate(el => el.focus()).catch(() => {});
      }
      await randomDelay(250, 600);
      // Copy-paste để giữ nguyên xuống dòng (paste event không trigger gửi như Enter)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(text => navigator.clipboard.writeText(text), message);
      await page.keyboard.press('Control+v');
      logger.info('[salework] Đã nhập tin nhắn (paste)');
      await randomDelay(400, 900);
    } else {
      logger.warn('[salework] Không thấy ô nhập tin đang hiển thị');
    }
  }

  await randomDelay(800, 1600);

  const sendSelectors = [
    'button:has-text("Gửi"):visible',
    'button:has-text("Send"):visible',
    '[class*="send"] button:visible',
  ];
  for (const sel of sendSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await randomDelay(300, 800);
        await btn.click({ timeout: 5000 });
        logger.info('[salework] Click nút Gửi');
        await randomDelay(1800, 2600);
        return true;
      }
    } catch { continue; }
  }

  await page.keyboard.press('Enter');
  logger.info('[salework] Gửi bằng Enter');
  await delay(2000);
  return true;
}

async function postToZaloGroup({ zaloAccountName, accountKey, groupName, message, imagePaths }) {
  const profilePath = getSaleworkProfile(accountKey);

  if (!fs.existsSync(profilePath)) {
    return {
      success: false,
      error: `Chưa đăng nhập Salework cho tài khoản "${zaloAccountName}". Hãy xoá và thêm lại tài khoản qua UI.`,
    };
  }

  const proxy = getZaloProxyForAccount(accountKey);
  if (proxy) logger.info(`[salework] Account "${zaloAccountName}" dùng proxy: ${proxy.server}`);

  if (proxy) {
    const health = await checkProxy(proxy);
    if (!health.ok) {
      return {
        success: false,
        error: `Proxy "${proxy.server}" không kết nối được: ${health.error}. Sửa proxy ở tab Tài khoản Zalo.`,
      };
    }
  }

  // Fingerprint riêng cho mỗi Zalo account (namespace 'zalo:' để tránh va FB)
  const { userAgent, viewport } = getProfileDeviceFingerprint(`zalo:${accountKey || zaloAccountName}`);
  const browser = await safeLaunchPersistentContext(profilePath, {
    headless: false,
    slowMo: 500,
    viewport,
    userAgent,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ...(proxy ? { proxy } : {}),
  });

  const page = await browser.newPage();

  // Dọn dẹp browser CHẠY NỀN (fire-and-forget) — không bao giờ chặn việc trả
  // kết quả. Trước đây finally await page.close()/browser.close() có thể treo
  // (dù có Promise.race) → promise postToZaloGroup không resolve → local-server
  // không set job 'done' → cloud poll mãi 'processing' → frontend kẹt "Đang đăng".
  // Tách cleanup ra để lỗi đóng browser không ảnh hưởng tới việc báo kết quả.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    Promise.race([page.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {})
      .then(() => Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {}))
      .then(() => logger.info('[salework] Đã đóng browser'))
      .catch(() => {});
  };

  try {
    logger.info(`[salework] === account=${zaloAccountName}, group=${groupName} ===`);

    await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);
    await screenshot(page, '01-loaded');

    const accountOk = await selectZaloAccount(page, zaloAccountName);
    await screenshot(page, '02-account-selected');

    // HUỶ đăng nếu không chọn được đúng tài khoản — thà báo lỗi rõ ràng còn hơn
    // âm thầm đăng nhầm bằng tài khoản mặc định ("Tất cả tài khoản" → Basso…).
    if (!accountOk) {
      throw new Error(`Không chọn được tài khoản "${zaloAccountName}" trên Salework (ô vẫn ở "Tất cả tài khoản" hoặc chọn nhầm). Đã huỷ đăng để tránh đăng nhầm tài khoản — mở lại Salework kiểm tra danh sách tài khoản đã kết nối.`);
    }

    if (!(await searchAndClickGroup(page, groupName))) {
      throw new Error(`Không tìm thấy nhóm: ${groupName}`);
    }
    await screenshot(page, '04-group-selected');

    await sendMessage(page, message, imagePaths);

    logger.info(`[salework] Đã đăng lên "${groupName}" qua "${zaloAccountName}"`);
    cleanup(); // chạy nền, không await — trả kết quả ngay
    return { success: true };
  } catch (e) {
    logger.error(`[salework] Lỗi: ${e.message}`);
    try { await screenshot(page, '99-error'); } catch {}
    cleanup(); // chạy nền, không await
    return { success: false, error: e.message };
  }
}

module.exports = { postToZaloGroup, getSaleworkProfile };
