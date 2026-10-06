const { sleep } = require('./delay');

function readGap(value) {
  if (value == null || String(value).trim() === '') return 60_000;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

// One worker process: serialize matching group names even across accounts.
// Keep expired entries only until the next call; active/waiting chains are retained.
function createGroupPostPacer({ gapMs = 60_000, now = Date.now, pause = sleep, onWait = () => {} } = {}) {
  const groups = new Map();
  return async function withGroupPostGap(groupName, fn, shouldCancel = () => false) {
    const key = String(groupName || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!key) return fn();
    for (const [name, entry] of groups) {
      if (!entry.pending && entry.nextAt <= now()) groups.delete(name);
    }
    let entry = groups.get(key);
    if (!entry) { entry = { tail: Promise.resolve(), nextAt: 0, pending: 0 }; groups.set(key, entry); }
    entry.pending++;
    const cancelled = () => typeof shouldCancel === 'function' && shouldCancel();
    const stopped = () => ({ success: false, cancelled: true, error: 'Đã dừng theo yêu cầu người dùng' });
    const run = entry.tail.then(async () => {
      let started = false;
      try {
        if (cancelled()) return stopped();
        if (entry.nextAt > now()) onWait(key, entry.nextAt - now());
        while (entry.nextAt > now()) {
          if (cancelled()) return stopped();
          await pause(Math.min(1000, entry.nextAt - now()));
        }
        if (cancelled()) return stopped();
        started = true;
        return await fn();
      } finally {
        if (started) entry.nextAt = now() + gapMs;
        entry.pending--;
      }
    });
    entry.tail = run.catch(() => {});
    return run;
  };
}

const withGroupPostGap = createGroupPostPacer({
  gapMs: readGap(process.env.ZALO_SAME_GROUP_GAP_MS),
  onWait: (group, ms) => require('./logger').info(`[zalo][gap] Chờ ${Math.ceil(ms / 1000)}s trước lượt tiếp theo vào nhóm "${group}"`),
});
module.exports = { withGroupPostGap, createGroupPostPacer, readGap };
