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

function list({ limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`SELECT * FROM deal_history ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(Math.floor(lim), Math.max(0, Math.floor(Number(offset) || 0))).map(deserialize);
}

function deserialize(row) {
  return { id: row.id, title: row.title, brand: row.brand || '', url: row.url, website: row.website, price: row.price, log: row.log ? JSON.parse(row.log) : null, createdAt: row.created_at };
}

function page({ page = 1, limit = 20 } = {}) {
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
  const total = db.prepare('SELECT COUNT(*) AS total FROM deal_history').get().total;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
  return { rows: list({ limit: size, offset: (current - 1) * size }), total, page: current, pages };
}

module.exports = { create, list, getById, page };
