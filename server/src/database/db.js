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

// Bang scraped_posts: luu bai viet scrape duoc tu FB (profile/page/group)
// UNIQUE(source_type, source_url, post_id) cho phep cung 1 post xuat hien
// trong nhieu source (vd: profile + group reshare) ma khong va cham.
db.exec(`
  CREATE TABLE IF NOT EXISTS scraped_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scraped_at TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT NOT NULL,
    post_id TEXT,
    permalink TEXT,
    author_name TEXT,
    author_url TEXT,
    text TEXT,
    time_text TEXT,
    images TEXT,
    reaction_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    profile TEXT,
    UNIQUE(source_type, source_url, post_id)
  );

  CREATE INDEX IF NOT EXISTS idx_scraped_posts_scraped_at ON scraped_posts(scraped_at);
  CREATE INDEX IF NOT EXISTS idx_scraped_posts_source ON scraped_posts(source_type, source_url);
  CREATE INDEX IF NOT EXISTS idx_scraped_posts_post_id ON scraped_posts(post_id);
`);

module.exports = db;
