/**
 * Hàng đợi đăng Zalo theo từng tài khoản (account key).
 *
 * Vì sao cần:
 *   1. Mỗi Zalo account dùng CHUNG 1 thư mục profile browser (persistent context).
 *      Nếu 2 post cùng account chạy song song → xung đột userDataDir → crash/treo.
 *      → Bắt buộc tuần tự hoá theo account.
 *   2. Đăng dồn dập cùng 1 account dễ bị Zalo flag spam.
 *      → Tự giãn cách giữa 2 post liên tiếp của cùng account (GROUP delay).
 *   3. Nhiều account KHÁC nhau đăng cùng lúc cũng dễ bị phát hiện "đăng đồng loạt".
 *      → Lệch thời điểm BẮT ĐẦU giữa các account (PROFILE delay) qua 1 cổng toàn cục.
 *
 * Cơ chế PROFILE delay: các account vẫn chạy SONG SONG (post execution chồng nhau),
 * chỉ giãn THỜI ĐIỂM BẮT ĐẦU để không cùng nổ một giây. Cổng toàn cục serialize
 * việc "chốt giờ bắt đầu" qua mọi account rồi giãn ≥ profileDelay so với lần bắt
 * đầu gần nhất của bất kỳ account nào.
 *
 * Vì các account chạy song song, mỗi account mở 1 cửa sổ Chromium riêng
 * (headless: false) — nếu đăng dồn dập nhiều account cùng lúc (vd "đăng tất cả"),
 * số cửa sổ chạy chồng nhau có thể tăng không giới hạn, ngốn hết CPU của máy chạy
 * Playwright và khiến các request khác (vd API danh sách bài đăng) bị đói CPU,
 * phản hồi rất chậm/timeout dù bản thân code không hề bị "treo". Giới hạn số
 * account chạy đồng thời (semaphore) để chặn tình trạng này.
 *
 * Cấu hình delay: xem src/utils/post-delays.js (chỉnh qua env).
 */

const {
  groupDelayMs,
  profileDelayMs,
  sleep,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_MAX_MS,
  PROFILE_DELAY_MIN_MS,
  PROFILE_DELAY_MAX_MS,
} = require('./post-delays');

// Map<accountKey, { tail: Promise, lastStartAt: number }>
const chains = new Map();

// Cổng giãn cách TOÀN CỤC giữa các account khác nhau (lệch thời điểm bắt đầu).
let globalGate = Promise.resolve();
let globalLastStartAt = 0;

// --- Giới hạn số account chạy Chromium ĐỒNG THỜI (semaphore) ---
// Mặc định 3: đủ để nhiều account chồng lịch nhau (staggered start) mà không mở
// quá nhiều cửa sổ Chromium cùng lúc làm máy quá tải. Chỉnh qua env nếu máy khoẻ hơn.
const MAX_CONCURRENT = Math.max(1, Number(process.env.ZALO_MAX_CONCURRENT) || 3);
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

/**
 * Serialize việc "chốt thời điểm bắt đầu" qua mọi account, rồi đảm bảo cách lần
 * bắt đầu gần nhất (của bất kỳ account nào) ≥ profileDelay. Với 2 post liên tiếp
 * CÙNG account, khoảng cách cùng-account (group delay) thường đã ≥ profileDelay
 * nên cổng này gần như không chờ thêm — chỉ thực sự giãn khi là account khác.
 */
function passGlobalStagger() {
  const run = globalGate.then(async () => {
    if (globalLastStartAt) {
      const since = Date.now() - globalLastStartAt;
      const need = profileDelayMs();
      if (since < need) await sleep(need - since);
    }
    globalLastStartAt = Date.now();
  });
  // Nuốt lỗi để 1 lần fail không kẹt cổng cho các post sau.
  globalGate = run.catch(() => {});
  return run;
}

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
    // 1) Giãn cách giữa 2 post CÙNG account (tính từ lần BẮT ĐẦU trước đó).
    //    Nếu post trước đã chạy lâu hơn group delay thì không phải chờ thêm.
    if (chain.lastStartAt) {
      const since = Date.now() - chain.lastStartAt;
      const need = groupDelayMs();
      if (since < need) {
        await sleep(need - since);
      }
    }
    // 2) Lệch thời điểm bắt đầu giữa các account KHÁC nhau (cổng toàn cục).
    await passGlobalStagger();
    // 3) Giới hạn số cửa sổ Chromium chạy đồng thời — chờ tới khi có "chỗ trống"
    //    thay vì mở thêm cửa sổ mới vô hạn (chống đói CPU cho cả máy).
    await _acquireSlot();
    chain.lastStartAt = Date.now();
    try {
      return await fn();
    } finally {
      _releaseSlot();
    }
  });

  // tail nuốt lỗi để 1 post fail không chặn cả hàng đợi; caller vẫn nhận lỗi qua `run`.
  chain.tail = run.catch(() => {});
  return run;
}

module.exports = {
  enqueue,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_MAX_MS,
  PROFILE_DELAY_MIN_MS,
  PROFILE_DELAY_MAX_MS,
  // Alias tương thích ngược (trước đây export MIN_INTERVAL_MS).
  MIN_INTERVAL_MS: GROUP_DELAY_MIN_MS,
};
