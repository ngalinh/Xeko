/**
 * Tao delay ngau nhien giua min va max (ms)
 * Giup mo phong hanh vi nguoi dung that
 */
function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delay co dinh
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { randomDelay, sleep };
