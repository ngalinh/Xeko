const { AsyncLocalStorage } = require('node:async_hooks');

// One FIFO per account, shared by posting, comments and CTV in this process.
// The worker also queues HTTP jobs: the cloud queue cannot lock its browsers.
const queues = new Map();
const taskProfile = new AsyncLocalStorage();
const legacyQueue = Symbol('unspecified-profile');

function getQueuedProfile() {
  return taskProfile.getStore()?.profile || null;
}

// Giới hạn số account chạy Chromium ĐỒNG THỜI (semaphore) — mỗi account chạy
// qua FIFO riêng nên 2 job cùng account không bao giờ chồng nhau, nhưng NHIỀU
// account KHÁC NHAU vẫn chạy song song không giới hạn: nếu một chiến dịch gửi
// cho nhiều account cùng lúc, số cửa sổ Chromium mở chồng nhau có thể tăng
// không giới hạn, ngốn hết CPU/RAM của máy chạy Playwright và khiến các
// request khác (vd API danh sách bài đăng) bị đói, phản hồi timeout dù code
// không hề "treo". Cùng lý do với semaphore ở zalo-queue.js.
const MAX_CONCURRENT = Math.max(1, Number(process.env.FB_MAX_CONCURRENT) || 3);
let _running = 0;
const _waiters = [];
function _acquireSlot() {
  if (_running < MAX_CONCURRENT) { _running++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _releaseSlot() {
  const next = _waiters.shift();
  if (next) next();
  else _running = Math.max(0, _running - 1);
}

function queuePost(fn, profile = null) {
  if (profile !== null && (typeof profile !== 'string' || !profile.trim())) {
    throw new Error('Thiếu tài khoản cho hàng đợi');
  }
  const key = profile === null ? legacyQueue : profile;
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.then(async () => {
    await _acquireSlot();
    try {
      return await taskProfile.run({ profile }, fn);
    } finally {
      _releaseSlot();
    }
  });
  const tail = result.then(() => {}, () => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return result;
}

module.exports = { queuePost, getQueuedProfile };
