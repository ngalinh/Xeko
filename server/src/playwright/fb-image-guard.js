'use strict';

// Run inside the visible composer, never against avatars elsewhere in the feed.
function readImageState(dialog, baseline) {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const images = [...dialog.querySelectorAll('img')].filter(img => {
    const src = img.currentSrc || img.getAttribute('src') || '';
    return src && !baseline.includes(src) && visible(img) &&
      img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  });
  const count = new Set(images.map(img => img.currentSrc || img.getAttribute('src'))).size;
  const rejected = /Không thể tải file|không thể tải ảnh|couldn.t upload|Unable to upload|could not be uploaded/i.test(dialog.textContent || '');
  const busy = [...dialog.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
  const readyButton = [...dialog.querySelectorAll('[role="button"], button')].some(el => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return /^(Đăng|Post|Tiếp|Next)$/.test(label) && visible(el) &&
      el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
  });
  return { count, rejected, busy, readyButton };
}

async function waitForImages(composer, expected, baseline, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const stableMs = options.stableMs ?? 1500;
  const requireReadyButton = options.requireReadyButton ?? true;
  const now = options.now || Date.now;
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let readySince = null;
  let state = { count: 0 };
  while (now() < deadline) {
    state = await composer.evaluate(readImageState, baseline);
    if (state.rejected) throw new Error('Facebook từ chối tải ảnh; đã dừng đăng bài.');
    if (state.count === expected && !state.busy && (!requireReadyButton || state.readyButton)) {
      if (readySince === null) readySince = now();
      if (now() - readySince >= stableMs) return true;
    } else {
      readySince = null;
    }
    await pause(300);
  }
  throw new Error(`Chưa xác nhận đủ ${expected} ảnh tải xong (thấy ${state.count}); đã dừng để tránh đăng thiếu hình.`);
}

module.exports = { readImageState, waitForImages };
