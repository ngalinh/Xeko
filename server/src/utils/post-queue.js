// Đảm bảo chỉ 1 lần đăng bài chạy tại 1 thời điểm (tránh race condition profile)
let _queue = Promise.resolve();

function queuePost(fn) {
  const p = _queue.then(() => fn());
  _queue = p.catch(() => {});
  return p;
}

module.exports = { queuePost };
