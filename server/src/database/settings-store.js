const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const getStmt = db.prepare(`SELECT value FROM settings WHERE key=?`);
const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);

function get(key, defaultValue = null) {
  const row = getStmt.get(key);
  return row ? row.value : defaultValue;
}

function set(key, value) {
  upsertStmt.run(key, value, new Date().toISOString());
}

module.exports = { get, set };
