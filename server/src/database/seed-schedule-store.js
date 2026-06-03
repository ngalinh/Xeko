const db = require('./db');

// Lịch tự động seeding: mỗi dòng = 1 đợt seeding hẹn giờ cho 1 bài,
// gồm nhiều bình luận (comments) và danh sách tài khoản để rải ngẫu nhiên.
db.exec(`
  CREATE TABLE IF NOT EXISTS seed_schedules (
    id INTEGER PRIMARY KEY,
    time TEXT NOT NULL,
    post_log_id INTEGER,
    post_url TEXT NOT NULL,
    comments TEXT,            -- JSON: [{ text, imagePaths: [..] }]
    accounts TEXT,            -- JSON: [{ key, name }]  (rải ngẫu nhiên)
    min_delay INTEGER DEFAULT 30,   -- giây, delay tối thiểu giữa các comment
    max_delay INTEGER DEFAULT 90,   -- giây, delay tối đa
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, done, error
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_seed_schedules_status ON seed_schedules(status);
  CREATE INDEX IF NOT EXISTS idx_seed_schedules_time ON seed_schedules(time);
`);

db.exec(`CREATE TABLE IF NOT EXISTS seed_schedule_id_counter (id INTEGER NOT NULL)`);
if (!db.prepare('SELECT id FROM seed_schedule_id_counter').get()) {
  db.prepare('INSERT INTO seed_schedule_id_counter (id) VALUES (0)').run();
}

const insertStmt = db.prepare(`
  INSERT INTO seed_schedules (id, time, post_log_id, post_url, comments, accounts, min_delay, max_delay, status, created_at)
  VALUES (@id, @time, @postLogId, @postUrl, @comments, @accounts, @minDelay, @maxDelay, @status, @createdAt)
`);

function insert(job) {
  insertStmt.run({
    id: job.id,
    time: job.time.toISOString(),
    postLogId: job.postLogId || null,
    postUrl: job.postUrl,
    comments: JSON.stringify(job.comments || []),
    accounts: JSON.stringify(job.accounts || []),
    minDelay: job.minDelay != null ? job.minDelay : 30,
    maxDelay: job.maxDelay != null ? job.maxDelay : 90,
    status: job.status || 'pending',
    createdAt: new Date().toISOString(),
  });
}

const updateStatusStmt = db.prepare(`UPDATE seed_schedules SET status = @status, result = @result WHERE id = @id`);

function updateStatus(id, status, result) {
  updateStatusStmt.run({
    id,
    status,
    result: result ? JSON.stringify(result) : null,
  });
}

const deleteStmt = db.prepare(`DELETE FROM seed_schedules WHERE id = ?`);

function remove(id) {
  deleteStmt.run(id);
}

function _mapRow(r) {
  return {
    id: r.id,
    time: new Date(r.time),
    postLogId: r.post_log_id,
    postUrl: r.post_url,
    comments: safeParse(r.comments, []),
    accounts: safeParse(r.accounts, []),
    minDelay: r.min_delay != null ? r.min_delay : 30,
    maxDelay: r.max_delay != null ? r.max_delay : 90,
    status: r.status,
    result: safeParse(r.result, null),
    createdAt: r.created_at,
  };
}

const getPendingStmt = db.prepare(`SELECT * FROM seed_schedules WHERE status IN ('pending', 'running') ORDER BY time ASC`);
function getPending() {
  return getPendingStmt.all().map(_mapRow);
}

const getByUrlStmt = db.prepare(`SELECT * FROM seed_schedules WHERE post_url = ? ORDER BY time ASC`);
function getByUrl(postUrl) {
  return getByUrlStmt.all(postUrl).map(_mapRow);
}

const getAllStmt = db.prepare(`SELECT * FROM seed_schedules ORDER BY time ASC`);
function getAll() {
  return getAllStmt.all().map(_mapRow);
}

const maxIdStmt = db.prepare(`SELECT MAX(id) as maxId FROM seed_schedules`);
const getCounterStmt = db.prepare(`SELECT id FROM seed_schedule_id_counter`);
const updateCounterStmt = db.prepare(`UPDATE seed_schedule_id_counter SET id = ?`);

function nextId() {
  const existing = (maxIdStmt.get()?.maxId || 0);
  const counter = (getCounterStmt.get()?.id || 0);
  const next = Math.max(existing, counter) + 1;
  updateCounterStmt.run(next);
  return next;
}

function safeParse(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { insert, updateStatus, remove, getPending, getByUrl, getAll, nextId };
