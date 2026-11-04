'use strict';
const { randomUUID } = require('crypto');

// Instagram "Tạo bài viết mới" là MỘT dialog xuyên suốt các bước (chọn file ->
// cắt ảnh -> chỉnh sửa -> caption), không phải nhiều dialog riêng như Facebook.
// Mỗi resolver dưới đây luôn tìm trong dialog [role="dialog"] đang hiển thị,
// tránh nhầm với ô tìm kiếm/chat khác đang mở cùng lúc trên trang.

function findNewPostEntry({ token }) {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const re = /^(Tạo bài viết|New post)$/i;
  const els = [...document.querySelectorAll('a, div[role="button"], button')].filter(visible);
  for (const el of els) {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
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
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
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

module.exports = { resolveNewPostEntry, resolveDialogButton, resolveFileInput, resolveCaptionStep };
