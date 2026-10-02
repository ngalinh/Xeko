const { groupDelayMs, sleep } = require('./post-delays');
const { MIN_INTERVAL_MS } = require('./rate-limit');

// Called only inside the worker's per-profile FIFO, before the execution timer.
// Keep pacing separate from queuePost: scans/CTV must not consume posting slots.
const nextStarts = new Map();
async function waitForPostTurn(profile, shouldCancel = () => false) {
  if (shouldCancel()) return;
  const wait = (nextStarts.get(profile) || 0) - Date.now();
  if (wait > 0) await sleep(wait);
}

// Rest after completion, including a slow/failed attempt, before the next channel.
function finishPostTurn(profile) {
  nextStarts.set(profile, Date.now() + Math.max(MIN_INTERVAL_MS, groupDelayMs()));
}

module.exports = { waitForPostTurn, finishPostTurn };
