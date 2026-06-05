/**
 * Hàng đợi đăng Zalo theo từng tài khoản (account key).
 *
 * Vì sao cần:
 *   1. Mỗi Zalo account dùng CHUNG 1 thư mục profile browser (persistent context).
 *      Nếu 2 post cùng account chạy song song → xung đột userDataDir → crash/treo.
 *      → Bắt buộc tuần tự hoá theo account.
 *   2. Đăng dồn dập cùng 1 account dễ bị Zalo flag spam.
 *      → Tự giãn cách ≥ MIN_INTERVAL_MS giữa 2 post liên tiếp của cùng account.
 *
 * Nhờ vậy, khi user tick nhiều group cùng account, các bài được đăng lần lượt
 * và tự chờ đủ khoảng cách — KHÔNG còn bị từ chối "Quá nhanh".
 *
 * Posts của 2 account KHÁC nhau chạy độc lập (không chờ nhau).
 *
 * Config qua env: ZALO_POST_MIN_INTERVAL_MS, fallback POST_MIN_INTERVAL_MS, mặc định 30s.
 */

const MIN_INTERVAL_MS = Number(
  process.env.ZALO_POST_MIN_INTERVAL_MS || process.env.POST_MIN_INTERVAL_MS || 30_000
);

// Map<accountKey, { tail: Promise, lastStartAt: number }>
const chains = new Map();

/**
 * Xếp một tác vụ đăng vào hàng đợi của account. Trả về Promise resolve/reject
 * theo kết quả của fn() (giữ nguyên semantics fire-and-forget của caller).
 *
 * @param {string} accountKey  Key tuần tự hoá (vd: `zalo:<accountKey>`).
 * @param {() => Promise<any>} fn  Hàm thực hiện đăng (vd: salework.postToZaloGroup).
 * @returns {Promise<any>}
 */
function enqueue(accountKey, fn) {
  const key = accountKey || '_default';
  let chain = chains.get(key);
  if (!chain) {
    chain = { tail: Promise.resolve(), lastStartAt: 0 };
    chains.set(key, chain);
  }

  const run = chain.tail.then(async () => {
    // Chờ đủ khoảng cách kể từ lần BẮT ĐẦU post trước đó cùng account.
    // Nếu post trước đã chạy lâu hơn MIN_INTERVAL thì không phải chờ thêm.
    if (chain.lastStartAt) {
      const since = Date.now() - chain.lastStartAt;
      if (since < MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - since));
      }
    }
    chain.lastStartAt = Date.now();
    return fn();
  });

  // tail nuốt lỗi để 1 post fail không chặn cả hàng đợi; caller vẫn nhận lỗi qua `run`.
  chain.tail = run.catch(() => {});
  return run;
}

module.exports = { enqueue, MIN_INTERVAL_MS };
