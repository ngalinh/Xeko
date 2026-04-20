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
    image_paths TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_time ON scheduled_posts(time);
`);

const insertStmt = db.prepare(`
  INSERT INTO scheduled_posts (id, time, type, target, group_id, group_name, message, profile, image_paths, status, created_at)
  VALUES (@id, @time, @type, @target, @groupId, @groupName, @message, @profile, @imagePaths, @status, @createdAt)
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
    imagePaths: JSON.stringify(job.imagePaths || []),
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
    imagePaths: JSON.parse(r.image_paths || '[]'),
    status: r.status,
  }));
}

const maxIdStmt = db.prepare(`SELECT MAX(id) as maxId FROM scheduled_posts`);

function nextId() {
  const row = maxIdStmt.get();
  return (row.maxId || 0) + 1;
}

module.exports = { insert, updateStatus, remove, getPending, nextId };
