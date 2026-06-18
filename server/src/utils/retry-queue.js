/**
 * AUTO-RETRY khi bài đăng bị chặn vì rate-limit (HTTP 429 từ local server).
 *
 * Thay vì để bài "Failed", ta đánh dấu row post_logs là success=2 (chờ đăng lại)
 * và hẹn giờ tự đăng lại sau khoảng `retryAfterMs` mà local server trả về.
 *
 * - Bền qua restart: mỗi lần hẹn được ghi vào bảng post_retries (retry-store).
 * - Ảnh được copy sang temp/retry_* riêng để không bị cleanup cùng request gốc.
 * - Việc đăng lại đi qua queuePost (serial) như mọi bài khác.
 * - retry-queue KHÔNG tự quyết định đăng lại tiếp; runner (executePost) sẽ gọi
 *   schedule() lần nữa nếu vẫn bị rate-limit và còn lượt.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { queuePost } = require('./post-queue');
const retryStore = require('../database/retry-store');

// Số lần tự đăng lại tối đa trước khi bỏ cuộc và đánh dấu Failed.
const MAX_RETRIES = Number(process.env.POST_RETRY_MAX || 5);
// Đệm thêm sau cửa sổ rate-limit để chắc chắn đã qua giới hạn.
const RETRY_BUFFER_MS = Number(process.env.POST_RETRY_BUFFER_MS || 15_000);

const TEMP_DIR = path.resolve(__dirname, '../../temp');
const _timers = new Map();
let _runner = null;

/** Nhận diện kết quả bị rate-limit: proxy trả thẳng body 429 { error, retryAfterMs }. */
function isRateLimited(result) {
  return !!(result && result.retryAfterMs != null && !result.success);
}

function _copyImages(imagePaths, tag) {
  if (!imagePaths || !imagePaths.length) return [];
  const dir = path.join(TEMP_DIR, `retry_${tag}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const src of imagePaths) {
    try {
      if (!fs.existsSync(src)) continue;
      const dest = path.join(dir, path.basename(src));
      fs.copyFileSync(src, dest);
      out.push(dest);
    } catch (e) { logger.error(`[retry-queue] copy ảnh: ${e.message}`); }
  }
  return out;
}

function _cleanupImages(imagePaths) {
  if (!imagePaths || !imagePaths.length) return;
  for (const p of imagePaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
  try { fs.rmdirSync(path.dirname(imagePaths[0])); } catch { /* ignore */ }
}

function _arm(record, delayMs) {
  const t = setTimeout(() => _fire(record), Math.max(0, delayMs));
  _timers.set(record.id, t);
}

function _fire(record) {
  _timers.delete(record.id);
  retryStore.updateStatus(record.id, 'running');
  if (!_runner) {
    logger.error(`[retry-queue] chưa có runner — bỏ qua #${record.id}`);
    return;
  }
  queuePost(() => _runner(record))
    .then(() => {
      _cleanupImages(record.imagePaths);
      retryStore.remove(record.id);
    })
    .catch(e => {
      logger.error(`[retry-queue] chạy #${record.id} lỗi: ${e.message}`);
      retryStore.updateStatus(record.id, 'error');
    });
}

/**
 * Hẹn 1 lần đăng lại.
 * @param {object} p
 * @param {number} p.postLogId  - id row post_logs cần cập nhật khi đăng lại xong
 * @param {number} p.retryAfterMs - thời gian chờ (ms) local server yêu cầu
 * @param {number} p.attempt    - đây là lần đăng lại thứ mấy (1-based)
 * @param {object} p.args       - tham số để dựng lại executePost
 * @param {string[]} p.imagePaths - đường dẫn ảnh tạm (sẽ được copy riêng)
 */
function schedule({ postLogId, retryAfterMs, attempt, args, imagePaths }) {
  const delay = Math.max(0, Number(retryAfterMs) || 0) + RETRY_BUFFER_MS;
  const tag = `${postLogId}_${attempt}_${Math.random().toString(36).slice(2, 8)}`;
  const copied = _copyImages(imagePaths, tag);
  const retryAt = new Date(Date.now() + delay).toISOString();
  const id = retryStore.insert({ postLogId, retryAt, attempt, args, imagePaths: copied });
  const record = { id, postLogId, retryAt, attempt, args, imagePaths: copied };
  _arm(record, delay);
  logger.info(`[retry-queue] hẹn đăng lại #${id} (post_log=${postLogId}, lần ${attempt}/${MAX_RETRIES}) sau ${Math.ceil(delay / 1000)}s`);
  return { id, retryAt };
}

/**
 * Khôi phục các lần hẹn còn dang dở khi server khởi động.
 * @param {(record:object)=>Promise<any>} runner - hàm thực thi đăng lại
 */
function init(runner) {
  _runner = runner;
  const pending = retryStore.getPending();
  if (!pending.length) { logger.info('[retry-queue] init: không có lần hẹn nào'); return; }
  const now = Date.now();
  let restored = 0, catchup = 0;
  for (const p of pending) {
    const record = { id: p.id, postLogId: p.postLogId, retryAt: p.retryAt, attempt: p.attempt, args: p.args, imagePaths: p.imagePaths };
    const delay = new Date(p.retryAt).getTime() - now;
    if (delay <= 0) { catchup++; _fire(record); }
    else { _arm(record, delay); restored++; }
  }
  logger.info(`[retry-queue] init: khôi phục ${restored}, chạy ngay ${catchup}`);
}

module.exports = { schedule, init, isRateLimited, MAX_RETRIES };
