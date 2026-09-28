const { AsyncLocalStorage } = require('node:async_hooks');

// One FIFO per account, shared by posting, comments and CTV in this process.
// The worker also queues HTTP jobs: the cloud queue cannot lock its browsers.
const queues = new Map();
const taskProfile = new AsyncLocalStorage();
const legacyQueue = Symbol('unspecified-profile');

function getQueuedProfile() {
  return taskProfile.getStore()?.profile || null;
}

function queuePost(fn, profile = null) {
  if (profile !== null && (typeof profile !== 'string' || !profile.trim())) {
    throw new Error('Thiếu tài khoản cho hàng đợi');
  }
  const key = profile === null ? legacyQueue : profile;
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.then(() => taskProfile.run({ profile }, fn));
  const tail = result.then(() => {}, () => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return result;
}

module.exports = { queuePost, getQueuedProfile };
