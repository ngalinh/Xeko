const path = require('path');

const BUSY_MESSAGE = 'Hồ sơ tài khoản đang được một phiên trình duyệt khác sử dụng. Đóng cửa sổ kiểm tra đăng nhập hoặc chờ trình duyệt của lượt trước đóng rồi đăng lại.';

function createProfileLauncher(launch) {
  const active = new Map();
  return async (userDataDir, opts) => {
    const resolved = path.resolve(userDataDir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (active.has(key)) throw new Error(BUSY_MESSAGE);
    const token = {};
    active.set(key, token);
    const release = () => {
      if (active.get(key) === token) active.delete(key);
    };
    try {
      const context = await launch(userDataDir, opts);
      // A close timeout is NOT proof that Chromium released the profile.
      context.once('close', release);
      return context;
    } catch (error) {
      release();
      if (/Opening in existing browser session|profile.*already in use|ProcessSingleton|SingletonLock/i.test(error.message || '')) {
        throw new Error(BUSY_MESSAGE, { cause: error });
      }
      throw error;
    }
  };
}

async function closeProfileContext(context, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => context.close()).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createProfileLauncher, closeProfileContext, BUSY_MESSAGE };
