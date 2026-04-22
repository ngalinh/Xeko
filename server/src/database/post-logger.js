const db = require('./db');

// === Prepared statements ===

const insertStmt = db.prepare(`
  INSERT INTO post_logs (timestamp, profile, profile_name, platform, target, group_name, group_id, message, image_count, success, error, post_url, source, images)
  VALUES (@timestamp, @profile, @profileName, @platform, @target, @groupName, @groupId, @message, @imageCount, @success, @error, @postUrl, @source, @images)
`);

/**
 * Ghi log 1 bai dang
 */
function logPost({ profile, profileName, platform, target, groupName, groupId, message, imageCount, success, error, postUrl, source, images }) {
  return insertStmt.run({
    timestamp: new Date().toISOString(),
    profile: profile || 'unknown',
    profileName: profileName || profile || 'unknown',
    platform: platform || 'facebook',
    target: target || 'personal',
    groupName: groupName || null,
    groupId: groupId || null,
    message: message || null,
    imageCount: imageCount || 0,
    success: success ? 1 : 0,
    error: error || null,
    postUrl: postUrl || null,
    source: source || 'web',
    images: images && images.length ? JSON.stringify(images) : null,
  });
}

/**
 * Lay lich su bai dang voi filter
 */
function getPostHistory({ profile, platform, success, from, to, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM post_logs WHERE 1=1';
  const params = {};

  if (profile) {
    sql += ' AND profile = @profile';
    params.profile = profile;
  }
  if (platform) {
    sql += ' AND platform = @platform';
    params.platform = platform;
  }
  if (success !== undefined && success !== null && success !== '') {
    sql += ' AND success = @success';
    params.success = Number(success);
  }
  if (from) {
    sql += ' AND timestamp >= @from';
    params.from = from;
  }
  if (to) {
    sql += ' AND timestamp <= @to';
    params.to = to;
  }

  // Dem tong
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(params);

  sql += ' ORDER BY timestamp DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(sql).all(params).map(r => ({
    ...r,
    images: r.images ? safeParseJson(r.images) : [],
  }));

  return { total, rows };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return []; }
}

/**
 * Thong ke tong hop
 */
function getStatistics({ from, to } = {}) {
  const params = {};
  let dateFilter = '';

  if (from) {
    dateFilter += ' AND timestamp >= @from';
    params.from = from;
  }
  if (to) {
    dateFilter += ' AND timestamp <= @to';
    params.to = to;
  }

  // Tong quat
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE 1=1 ${dateFilter}
  `).get(params);

  // Hom nay
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE timestamp >= @todayStart
  `).get({ todayStart: todayStart.toISOString() });

  // Theo ngay (30 ngay gan nhat)
  const daily = db.prepare(`
    SELECT
      DATE(timestamp) as date,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs
    WHERE timestamp >= DATE('now', '-30 days') ${dateFilter}
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
  `).all(params);

  // Theo profile
  const byProfile = db.prepare(`
    SELECT
      profile, profile_name,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE 1=1 ${dateFilter}
    GROUP BY profile
    ORDER BY total DESC
  `).all(params);

  // Theo group
  const byGroup = db.prepare(`
    SELECT
      group_name, platform,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs
    WHERE group_name IS NOT NULL ${dateFilter}
    GROUP BY group_name, platform
    ORDER BY total DESC
  `).all(params);

  // Theo platform
  const byPlatform = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE 1=1 ${dateFilter}
    GROUP BY platform
    ORDER BY total DESC
  `).all(params);

  return { summary, today, daily, byProfile, byGroup, byPlatform };
}

function deleteById(id) {
  return db.prepare('DELETE FROM post_logs WHERE id = ?').run(id);
}

function deleteByIds(ids) {
  if (!ids || ids.length === 0) return { changes: 0 };
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM post_logs WHERE id IN (${placeholders})`).run(ids);
}

function deleteByFilter({ profile, success, from, to } = {}) {
  let sql = 'DELETE FROM post_logs WHERE 1=1';
  const params = {};
  if (profile) { sql += ' AND profile = @profile'; params.profile = profile; }
  if (success !== undefined && success !== null && success !== '') {
    sql += ' AND success = @success'; params.success = Number(success);
  }
  if (from) { sql += ' AND timestamp >= @from'; params.from = from; }
  if (to) { sql += ' AND timestamp <= @to'; params.to = to; }
  return db.prepare(sql).run(params);
}

module.exports = { logPost, getPostHistory, getStatistics, deleteById, deleteByIds, deleteByFilter };
