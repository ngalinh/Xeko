// Keep a profile exclusive until Chromium confirms its persistent context closed.
// A hung close must not hang job reporting or permit another launch on that profile.
function createProfileLifecycle(timeoutMs = 15000) {
  const tails = new Map();
  const closing = new Map();
  async function waitForClose(key) {
    const state = closing.get(key);
    if (!state) return;
    let timer;
    try {
      await Promise.race([
        state.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Quá thời gian chờ đóng Chromium')), timeoutMs);
        }),
      ]);
      if (state.error) throw state.error;
    } catch (e) {
      throw new Error(`Hồ sơ Zalo "${key}" chưa đóng xong: ${e.message}. Đã chặn mở phiên mới; kiểm tra cửa sổ Chromium trên máy đăng bài.`);
    } finally {
      clearTimeout(timer);
    }
  }
  async function run(key, fn) {
    const previous = tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await waitForClose(key);
      return fn();
    });
    tails.set(key, current);
    try { return await current; }
    finally { if (tails.get(key) === current) tails.delete(key); }
  }
  async function close(key, context) {
    const state = {};
    closing.set(key, state);
    state.promise = Promise.resolve().then(() => context.close()).then(() => {
      if (closing.get(key) === state) closing.delete(key);
    }, error => { state.error = error; });
    await waitForClose(key);
  }
  return { run, close };
}

module.exports = { createProfileLifecycle };
