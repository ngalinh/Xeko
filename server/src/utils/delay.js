/**
 * Tạo delay ngẫu nhiên giữa min và max (ms)
 * Giúp mô phỏng hành vi người dùng thật
 */
function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delay cố định
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Gõ text giống người: delay random per-keystroke, đôi khi pause dài giữa
 * các từ (giả lập "suy nghĩ"). Tương thích với page.keyboard, locator, hoặc
 * elementHandle (cứ object nào có .type(text, { delay }) là chạy được).
 *
 * Tốc độ ~ 50-150ms/char + 200-600ms pause sau ~mỗi 4-8 từ.
 */
async function humanType(target, text, { minDelay = 50, maxDelay = 150, wordPauseMin = 200, wordPauseMax = 600 } = {}) {
  if (!text) return;
  const words = String(text).split(/(\s+)/); // giữ whitespace
  let wordsSinceBreak = 0;
  const breakEvery = randInt(4, 8);
  for (const chunk of words) {
    await target.type(chunk, { delay: randInt(minDelay, maxDelay) });
    if (/\s/.test(chunk)) {
      wordsSinceBreak++;
      if (wordsSinceBreak >= breakEvery) {
        await sleep(randInt(wordPauseMin, wordPauseMax));
        wordsSinceBreak = 0;
      }
    }
  }
}

/**
 * Click có jitter: sleep ngắn random trước + sau khi click. Optionally
 * scrollIntoViewIfNeeded nếu target hỗ trợ. Truyền tiếp opts cho .click().
 */
async function humanClick(target, opts = {}) {
  await randomDelay(150, 450);
  if (typeof target.scrollIntoViewIfNeeded === 'function') {
    try { await target.scrollIntoViewIfNeeded(); } catch {}
  }
  await target.click(opts);
  await randomDelay(150, 400);
}

module.exports = { randomDelay, sleep, humanType, humanClick };
