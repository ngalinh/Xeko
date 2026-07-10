const db = require('./db');

// Hàng đợi tự đăng lại (auto-retry) khi bài bị chặn vì rate-limit.
// Nguồn sự thật là bảng này (bền qua restart); retry-queue.js cache timer trong RAM.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_retries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_log_id INTEGER NOT NULL,
    retry_at TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    args TEXT NOT NULL,
    image_paths TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_post_retries_status ON post_retries(status);
`);

const insertStmt = db.prepare(`
  INSERT INTO post_retries (post_log_id, retry_at, attempt, args, image_paths, status, created_at)
  VALUES (@postLogId, @retryAt, @attempt, @args, @imagePaths, 'pending', @createdAt)
`);

function insert({ postLogId, retryAt, attempt, args, imagePaths }) {
  const r = insertStmt.run({
    postLogId,
    retryAt,
    attempt: attempt || 1,
    args: JSON.stringify(args || {}),
    imagePaths: JSON.stringify(imagePaths || []),
    createdAt: new Date().toISOString(),
  });
  return r.lastInsertRowid;
}

const removeStmt = db.prepare('DELETE FROM post_retries WHERE id = ?');
function remove(id) { return removeStmt.run(id); }

const updateStatusStmt = db.prepare('UPDATE post_retries SET status = @status WHERE id = @id');
function updateStatus(id, status) { return updateStatusStmt.run({ id, status }); }

function _map(r) {
  return {
    id: r.id,
    postLogId: r.post_log_id,
    retryAt: r.retry_at,
    attempt: r.attempt,
    args: safeParse(r.args, {}),
    imagePaths: safeParse(r.image_paths, []),
    status: r.status,
  };
}

const getPendingStmt = db.prepare(`SELECT * FROM post_retries WHERE status = 'pending' ORDER BY retry_at ASC`);
function getPending() {
  return getPendingStmt.all().map(_map);
}

// Tất cả record (mọi status) — dùng khi khởi động để dọn record dang dở
// (running/error) còn sót lại sau khi server bị restart giữa chừng.
const getAllStmt = db.prepare(`SELECT * FROM post_retries ORDER BY retry_at ASC`);
function getAll() {
  return getAllStmt.all().map(_map);
}

function safeParse(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

module.exports = { insert, remove, updateStatus, getPending, getAll };
