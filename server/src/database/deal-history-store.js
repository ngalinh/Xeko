const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS deal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT '',
    url TEXT DEFAULT '',
    website TEXT DEFAULT '',
    price TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deal_history_created_at ON deal_history(created_at);
`);

const insertStmt = db.prepare(`
  INSERT INTO deal_history (title, url, website, price, created_at)
  VALUES (@title, @url, @website, @price, @createdAt)
`);

function create({ title = '', url = '', website = '', price = '' }) {
  const now = new Date().toISOString();
  const info = insertStmt.run({ title, url, website, price, createdAt: now });
  return getById(info.lastInsertRowid);
}

const getByIdStmt = db.prepare(`SELECT * FROM deal_history WHERE id=?`);
function getById(id) {
  const row = getByIdStmt.get(id);
  return row ? deserialize(row) : null;
}

function list({ limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`SELECT * FROM deal_history ORDER BY created_at DESC LIMIT ?`).all(lim).map(deserialize);
}

function deserialize(row) {
  return { id: row.id, title: row.title, url: row.url, website: row.website, price: row.price, createdAt: row.created_at };
}

module.exports = { create, list, getById };
