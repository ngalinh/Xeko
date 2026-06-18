const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY,
    time TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT,
    group_id TEXT,
    group_name TEXT,
    message TEXT,
    profile TEXT NOT NULL,
    profile_name TEXT,
    image_paths TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_time ON scheduled_posts(time);
`);

// Migration: thêm cột profile_name nếu chưa có (cho DB cũ)
try {
  db.exec(`ALTER TABLE scheduled_posts ADD COLUMN profile_name TEXT`);
} catch { /* cột đã tồn tại */ }
try {
  db.exec(`ALTER TABLE scheduled_posts ADD COLUMN group_keywords TEXT`);
} catch { /* cột đã tồn tại */ }
try {
  db.exec(`ALTER TABLE scheduled_posts ADD COLUMN zalo_account TEXT`);
} catch { /* cột đã tồn tại */ }

// Bảng lưu ID counter tăng dần vĩnh viễn, tránh trùng ID sau khi schedules bị xóa
db.exec(`CREATE TABLE IF NOT EXISTS schedule_id_counter (id INTEGER NOT NULL)`);
if (!db.prepare('SELECT id FROM schedule_id_counter').get()) {
  db.prepare('INSERT INTO schedule_id_counter (id) VALUES (0)').run();
}

const insertStmt = db.prepare(`
  INSERT INTO scheduled_posts (id, time, type, target, group_id, group_name, message, profile, profile_name, image_paths, group_keywords, zalo_account, status, created_at)
  VALUES (@id, @time, @type, @target, @groupId, @groupName, @message, @profile, @profileName, @imagePaths, @groupKeywords, @zaloAccount, @status, @createdAt)
`);

function insert(job) {
  insertStmt.run({
    id: job.id,
    time: job.time.toISOString(),
    type: job.type || 'facebook',
    target: job.target || null,
    groupId: job.groupId || null,
    groupName: job.groupName || null,
    message: job.message || null,
    profile: job.profile,
    profileName: job.profileName || job.profile,
    imagePaths: JSON.stringify(job.imagePaths || []),
    groupKeywords: JSON.stringify(Array.isArray(job.groupKeywords) ? job.groupKeywords : []),
    zaloAccount: job.zaloAccount || null,
    status: job.status || 'pending',
    createdAt: new Date().toISOString(),
  });
}

const updateStatusStmt = db.prepare(`UPDATE scheduled_posts SET status = @status, result = @result WHERE id = @id`);

function updateStatus(id, status, result) {
  updateStatusStmt.run({
    id,
    status,
    result: result ? JSON.stringify(result) : null,
  });
}

const deleteStmt = db.prepare(`DELETE FROM scheduled_posts WHERE id = ?`);

function remove(id) {
  deleteStmt.run(id);
}

const getPendingStmt = db.prepare(`SELECT * FROM scheduled_posts WHERE status IN ('pending', 'running') ORDER BY time ASC`);

function getPending() {
  return getPendingStmt.all().map(r => ({
    id: r.id,
    time: new Date(r.time),
    type: r.type,
    target: r.target,
    groupId: r.group_id,
    groupName: r.group_name,
    message: r.message,
    profile: r.profile,
    profileName: r.profile_name || r.profile,
    imagePaths: JSON.parse(r.image_paths || '[]'),
    groupKeywords: JSON.parse(r.group_keywords || '[]'),
    zaloAccount: r.zalo_account || null,
    status: r.status,
  }));
}

// nextId() trả về ID tiếp theo và tăng counter vĩnh viễn trong DB
// Dùng MAX của cả 2 nguồn để tương thích với DB cũ chưa có counter table
const maxIdStmt = db.prepare(`SELECT MAX(id) as maxId FROM scheduled_posts`);
const getCounterStmt = db.prepare(`SELECT id FROM schedule_id_counter`);
const updateCounterStmt = db.prepare(`UPDATE schedule_id_counter SET id = ?`);

function nextId() {
  const existing = (maxIdStmt.get()?.maxId || 0);
  const counter = (getCounterStmt.get()?.id || 0);
  const next = Math.max(existing, counter) + 1;
  updateCounterStmt.run(next);
  return next;
}

module.exports = { insert, updateStatus, remove, getPending, nextId };
