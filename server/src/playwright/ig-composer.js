'use strict';
const { randomUUID } = require('crypto');

// Instagram "Tạo bài viết mới" là MỘT dialog xuyên suốt các bước (chọn file ->
// cắt ảnh -> chỉnh sửa -> caption), không phải nhiều dialog riêng như Facebook.
// Mỗi resolver dưới đây luôn tìm trong dialog [role="dialog"] đang hiển thị,
// tránh nhầm với ô tìm kiếm/chat khác đang mở cùng lúc trên trang.

function findNewPostEntry({ token }) {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const re = /^(Tạo bài viết|Bài viết mới|New post|Create)$/i;
  const els = [...document.querySelectorAll('a, div[role="button"], button')].filter(visible);
  for (const el of els) {
    // Sidebar thu gọn (chỉ icon) không có text span hiển thị — nhãn thật nằm trên
    // svg[aria-label] lồng bên trong, không phải trên chính thẻ a/button.
    const svgLabel = el.querySelector('svg[aria-label]')?.getAttribute('aria-label') || '';
    const label = (el.getAttribute('aria-label') || svgLabel || el.textContent || '').trim();
    if (re.test(label)) {
      el.setAttribute('data-xeko-ig', token);
      return true;
    }
  }
  return false;
}

// Dùng cho nút "Tiếp"/"Next" (bước cắt ảnh, bước chỉnh sửa) và nút "Chia sẻ"/"Share"
// khi KHÔNG cần lấy ô caption kèm theo.
function findDialogButton({ token, textRe }) {
  const re = new RegExp(textRe, 'i');
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  for (const dialog of dialogs) {
    const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible);
    for (const btn of buttons) {
      // Nút icon-only (vd chọn tỷ lệ cắt ảnh) không có text — label nằm trên
      // svg[aria-label] lồng bên trong, không phải trên chính thẻ button.
      const svgLabel = btn.querySelector('svg[aria-label]')?.getAttribute('aria-label') || '';
      const label = (btn.getAttribute('aria-label') || svgLabel || btn.textContent || '').trim();
      if (re.test(label) && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
        btn.setAttribute('data-xeko-ig', token);
        return true;
      }
    }
  }
  return false;
}

function findFileInput({ token }) {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const input = inputs.find(i => /image|video/.test(i.getAttribute('accept') || '')) || inputs[0];
  if (!input) return false;
  input.setAttribute('data-xeko-ig', token);
  return true;
}

// Bước cuối cùng: dialog có đúng 1 ô caption (contenteditable) và nút Chia sẻ/Share.
// Gắn token lên cả hai cùng lúc để đảm bảo chúng thuộc đúng dialog đang active.
function findCaptionStep({ token }) {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  for (const dialog of dialogs) {
    const editors = [...dialog.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')].filter(visible);
    const shareBtn = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible)
      .find(el => /^(Chia sẻ|Share)$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()));
    if (editors.length === 1 && shareBtn) {
      editors[0].setAttribute('data-xeko-ig-editor', token);
      shareBtn.setAttribute('data-xeko-ig-share', token);
      return true;
    }
  }
  return false;
}

// Menu chọn tỷ lệ cắt ảnh (Original/1:1/4:5/16:9) được Instagram render ra NGOÀI
// [role="dialog"] (menu nổi/portal riêng) — không dùng findDialogButton (chỉ tìm
// trong dialog) mà tìm trên toàn trang.
function findFloatingMenuItem({ token, textRe }) {
  const re = new RegExp(textRe, 'i');
  // Instagram giữ lại bản cũ của menu trong DOM khi đang chuyển động (transition
  // đóng/mở), đánh dấu bằng aria-hidden="true" trên 1 wrapper cha — bản đó vẫn có
  // getClientRects() > 0 (chưa unmount) nên dễ bị click nhầm thay vì bản đang hiện
  // thật (aria-hidden="false"). Loại các phần tử nằm trong wrapper aria-hidden="true".
  const visible = el => el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden'
    && !el.closest('[aria-hidden="true"]');
  const els = [...document.querySelectorAll('[role="button"], [role="menuitem"], button, li')].filter(visible);
  for (const el of els) {
    const svgLabel = el.querySelector('svg[aria-label]')?.getAttribute('aria-label') || '';
    const label = (el.getAttribute('aria-label') || svgLabel || el.textContent || '').trim();
    if (re.test(label)) {
      el.setAttribute('data-xeko-ig', token);
      return true;
    }
  }
  return false;
}

async function resolveFloatingMenuItem(page, textRe, { timeout = 10000 } = {}) {
  const token = randomUUID();
  await page.waitForFunction(findFloatingMenuItem, { token, textRe }, { timeout });
  return page.locator(`[data-xeko-ig="${token}"]`);
}

async function resolveNewPostEntry(page, { timeout = 10000 } = {}) {
  const token = randomUUID();
  await page.waitForFunction(findNewPostEntry, { token }, { timeout });
  return page.locator(`[data-xeko-ig="${token}"]`);
}

async function resolveDialogButton(page, textRe, { timeout = 10000 } = {}) {
  const token = randomUUID();
  await page.waitForFunction(findDialogButton, { token, textRe }, { timeout });
  return page.locator(`[data-xeko-ig="${token}"]`);
}

async function resolveFileInput(page, { timeout = 10000 } = {}) {
  const token = randomUUID();
  await page.waitForFunction(findFileInput, { token }, { timeout });
  return page.locator(`[data-xeko-ig="${token}"]`);
}

async function resolveCaptionStep(page, { timeout = 10000 } = {}) {
  const token = randomUUID();
  await page.waitForFunction(findCaptionStep, { token }, { timeout });
  return {
    editor: page.locator(`[data-xeko-ig-editor="${token}"]`),
    shareButton: page.locator(`[data-xeko-ig-share="${token}"]`),
  };
}

module.exports = { resolveNewPostEntry, resolveDialogButton, resolveFileInput, resolveCaptionStep, resolveFloatingMenuItem };
