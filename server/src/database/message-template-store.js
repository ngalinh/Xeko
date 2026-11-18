const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS message_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_templates_owner ON message_templates(owner_email);
`);

const listStmt = db.prepare(`SELECT id, name, content, updated_at FROM message_templates WHERE owner_email=@ownerEmail ORDER BY updated_at DESC`);
const insertStmt = db.prepare(`INSERT INTO message_templates (owner_email, name, content, created_at, updated_at) VALUES (@ownerEmail, @name, @content, @now, @now)`);
const updateStmt = db.prepare(`UPDATE message_templates SET name=@name, content=@content, updated_at=@now WHERE id=@id AND owner_email=@ownerEmail`);
const deleteStmt = db.prepare(`DELETE FROM message_templates WHERE id=@id AND owner_email=@ownerEmail`);

// Mẫu tin nhắn đã lưu của 1 người dùng (CTV) — dùng để tự điền lại khi soạn
// tin nhắn cho chiến dịch mới, khỏi phải gõ lại từ đầu mỗi lần.
function list(ownerEmail) {
  return listStmt.all({ ownerEmail });
}

function create(ownerEmail, { name, content }) {
  const now = new Date().toISOString();
  const result = insertStmt.run({ ownerEmail, name, content, now });
  return { id: result.lastInsertRowid, name, content, updated_at: now };
}

function update(id, ownerEmail, { name, content }) {
  const now = new Date().toISOString();
  return updateStmt.run({ id, ownerEmail, name, content, now });
}

function remove(id, ownerEmail) {
  return deleteStmt.run({ id, ownerEmail });
}

module.exports = { list, create, update, remove };
