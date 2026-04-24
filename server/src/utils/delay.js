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

module.exports = { randomDelay, sleep };
