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

// Existing histories remain valid when upgrading.
if (!db.prepare('PRAGMA table_info(deal_history)').all().some(column => column.name === 'brand')) {
  db.exec("ALTER TABLE deal_history ADD COLUMN brand TEXT DEFAULT ''");
}

if (!db.prepare('PRAGMA table_info(deal_history)').all().some(column => column.name === 'log')) {
  db.exec("ALTER TABLE deal_history ADD COLUMN log TEXT DEFAULT NULL");
}

const insertStmt = db.prepare(`
  INSERT INTO deal_history (title, brand, url, website, price, log, created_at)
  VALUES (@title, @brand, @url, @website, @price, @log, @createdAt)
`);

function create({ title = '', brand = '', url = '', website = '', price = '', log = null }) {
  const now = new Date().toISOString();
  const info = insertStmt.run({ title, brand, url, website, price, log: log == null ? null : JSON.stringify(log), createdAt: now });
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
  return { id: row.id, title: row.title, brand: row.brand || '', url: row.url, website: row.website, price: row.price, log: row.log ? JSON.parse(row.log) : null, createdAt: row.created_at };
}

module.exports = { create, list, getById };
