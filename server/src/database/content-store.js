const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    platform TEXT DEFAULT 'all',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contents_platform ON contents(platform);
  CREATE INDEX IF NOT EXISTS idx_contents_created_at ON contents(created_at);
`);

const insertStmt = db.prepare(`
  INSERT INTO contents (title, body, tags, platform, created_at, updated_at)
  VALUES (@title, @body, @tags, @platform, @createdAt, @updatedAt)
`);

function create({ title, body, tags = [], platform = 'all' }) {
  const now = new Date().toISOString();
  const info = insertStmt.run({
    title,
    body,
    tags: JSON.stringify(tags),
    platform,
    createdAt: now,
    updatedAt: now,
  });
  return getById(info.lastInsertRowid);
}

const updateStmt = db.prepare(`
  UPDATE contents SET title=@title, body=@body, tags=@tags, platform=@platform, updated_at=@updatedAt
  WHERE id=@id
`);

function update(id, { title, body, tags, platform }) {
  const existing = getById(id);
  if (!existing) return null;
  updateStmt.run({
    id,
    title: title ?? existing.title,
    body: body ?? existing.body,
    tags: JSON.stringify(tags ?? existing.tags),
    platform: platform ?? existing.platform,
    updatedAt: new Date().toISOString(),
  });
  return getById(id);
}

const deleteStmt = db.prepare(`DELETE FROM contents WHERE id=?`);

function remove(id) {
  return deleteStmt.run(id).changes > 0;
}

const getByIdStmt = db.prepare(`SELECT * FROM contents WHERE id=?`);

function getById(id) {
  const row = getByIdStmt.get(id);
  return row ? deserialize(row) : null;
}

function list({ search = '', platform = '' } = {}) {
  let sql = `SELECT * FROM contents WHERE 1=1`;
  const params = [];
  if (platform && platform !== 'all') {
    sql += ` AND (platform=? OR platform='all')`;
    params.push(platform);
  }
  if (search) {
    sql += ` AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  sql += ` ORDER BY updated_at DESC`;
  return db.prepare(sql).all(...params).map(deserialize);
}

function deserialize(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags || '[]'),
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { create, update, remove, getById, list };
