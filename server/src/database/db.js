const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.XEKO_DATA_DIR
  ? path.resolve(process.env.XEKO_DATA_DIR)
  : path.resolve(__dirname, '../..');
const DB_PATH = path.join(DATA_DIR, 'data/posts.db');

// Dam bao thu muc data ton tai
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode cho performance tot hon
db.pragma('journal_mode = WAL');

// Ham LOWER cua SQLite chi ha hoa dung cho ASCII (bo qua ky tu co dau tieng Viet).
// Dang ky ham rieng dung String.prototype.toLowerCase() cua JS (Unicode-aware)
// de dung trong cac truy van tim kiem khong phan biet hoa/thuong voi tieng Viet co dau.
db.function('LOWER_VN', (text) => (text == null ? null : String(text).toLowerCase()));

// Tao bang post_logs
db.exec(`
  CREATE TABLE IF NOT EXISTS post_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    profile TEXT NOT NULL,
    profile_name TEXT,
    platform TEXT NOT NULL,
    target TEXT NOT NULL,
    group_name TEXT,
    group_id TEXT,
    message TEXT,
    image_count INTEGER DEFAULT 0,
    success INTEGER NOT NULL,
    error TEXT,
    post_url TEXT,
    source TEXT DEFAULT 'web'
  );

  CREATE INDEX IF NOT EXISTS idx_post_logs_timestamp ON post_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_post_logs_profile ON post_logs(profile);
  CREATE INDEX IF NOT EXISTS idx_post_logs_platform ON post_logs(platform);
  CREATE INDEX IF NOT EXISTS idx_post_logs_success ON post_logs(success);
`);

// Migration: add images column (JSON array of URLs) if not exists
const cols = db.prepare("PRAGMA table_info(post_logs)").all().map(c => c.name);
if (!cols.includes('images')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN images TEXT`);
}
if (!cols.includes('batch_id')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN batch_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_post_logs_batch_id ON post_logs(batch_id)`);
}
if (!cols.includes('job_id')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN job_id TEXT`);
}
// retry_at: ISO time bài sẽ tự đăng lại (khi success=2 = chờ đăng lại vì rate-limit)
// retry_count: số lần đã tự đăng lại
if (!cols.includes('retry_at')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN retry_at TEXT`);
}
if (!cols.includes('retry_count')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN retry_count INTEGER DEFAULT 0`);
}
// website: website gắn với bài đăng (metadata, do nhân viên chọn/nhập ở chatbot)
if (!cols.includes('website')) {
  db.exec(`ALTER TABLE post_logs ADD COLUMN website TEXT`);
}

module.exports = db;
