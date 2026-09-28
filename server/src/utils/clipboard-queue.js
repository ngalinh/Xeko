// Chromium contexts share the OS clipboard, even for different FB accounts.
// Serialize only write + paste, not the entire browser task.
let tail = Promise.resolve();
function withClipboard(fn) {
  const result = tail.then(fn);
  tail = result.then(() => {}, () => {});
  return result;
}
module.exports = { withClipboard };
