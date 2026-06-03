const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS seed_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_log_id INTEGER,
    post_url TEXT NOT NULL,
    profile TEXT NOT NULL,
    profile_name TEXT,
    platform TEXT DEFAULT 'facebook',
    message TEXT,
    image_count INTEGER DEFAULT 0,
    images TEXT,
    success INTEGER NOT NULL,
    error TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_seed_logs_post_log_id ON seed_logs(post_log_id);
  CREATE INDEX IF NOT EXISTS idx_seed_logs_timestamp ON seed_logs(timestamp);
`);

const insertStmt = db.prepare(`
  INSERT INTO seed_logs (post_log_id, post_url, profile, profile_name, platform, message, image_count, images, success, error, timestamp)
  VALUES (@postLogId, @postUrl, @profile, @profileName, @platform, @message, @imageCount, @images, @success, @error, @timestamp)
`);

function logSeed({ postLogId, postUrl, profile, profileName, platform, message, imageCount, images, success, error }) {
  return insertStmt.run({
    postLogId: postLogId || null,
    postUrl,
    profile: profile || 'unknown',
    profileName: profileName || profile || 'unknown',
    platform: platform || 'facebook',
    message: message || null,
    imageCount: imageCount || 0,
    images: images && images.length ? JSON.stringify(images) : null,
    success: success ? 1 : 0,
    error: error || null,
    timestamp: new Date().toISOString(),
  });
}

function getSeedLogs(postLogId) {
  const rows = db.prepare('SELECT * FROM seed_logs WHERE post_log_id = ? ORDER BY timestamp DESC').all(postLogId);
  return rows.map(r => ({
    ...r,
    images: r.images ? safeParseJson(r.images) : [],
  }));
}

function getSeedLogsByUrl(postUrl) {
  const rows = db.prepare('SELECT * FROM seed_logs WHERE post_url = ? ORDER BY timestamp DESC').all(postUrl);
  return rows.map(r => ({
    ...r,
    images: r.images ? safeParseJson(r.images) : [],
  }));
}

function deleteSeedLog(id) {
  return db.prepare('DELETE FROM seed_logs WHERE id = ?').run(id);
}

// Tổng hợp số lần seeding theo từng bài (post_url) — phục vụ cột Seeding ở dashboard.
function getSeedSummary() {
  return db.prepare(`
    SELECT post_url,
           COUNT(*) AS total,
           SUM(success) AS success,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail,
           MAX(timestamp) AS last_timestamp
    FROM seed_logs
    WHERE post_url IS NOT NULL AND post_url != ''
    GROUP BY post_url
  `).all();
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return []; }
}

module.exports = { logSeed, getSeedLogs, getSeedLogsByUrl, deleteSeedLog, getSeedSummary };
