const db = require('./db');

// === Prepared statements ===

const insertStmt = db.prepare(`
  INSERT INTO post_logs (timestamp, profile, profile_name, platform, target, group_name, group_id, message, image_count, success, error, post_url, source, images, batch_id, job_id, website)
  VALUES (@timestamp, @profile, @profileName, @platform, @target, @groupName, @groupId, @message, @imageCount, @success, @error, @postUrl, @source, @images, @batchId, @jobId, @website)
`);

const insertPendingStmt = db.prepare(`
  INSERT INTO post_logs (timestamp, profile, profile_name, platform, target, group_name, group_id, message, image_count, success, error, post_url, source, images, batch_id, job_id, website)
  VALUES (@timestamp, @profile, @profileName, @platform, @target, @groupName, @groupId, @message, @imageCount, -1, null, null, @source, @images, @batchId, @jobId, @website)
`);

const completePendingStmt = db.prepare(
  `UPDATE post_logs SET success=@success, error=@error, post_url=@postUrl,
     profile=COALESCE(NULLIF(@profile,''), profile),
     profile_name=COALESCE(NULLIF(@profileName,''), profile_name)
   WHERE id=@id AND success=-1`
);
const completePendingWithGroupStmt = db.prepare(
  `UPDATE post_logs SET success=@success, error=@error, post_url=@postUrl, group_name=@groupName,
     profile=COALESCE(NULLIF(@profile,''), profile),
     profile_name=COALESCE(NULLIF(@profileName,''), profile_name)
   WHERE id=@id AND success=-1`
);

// === Cache lich su (trong bo nho) ===
// getPostHistory / getPostHistorySessions quet TOAN BO bang post_logs moi lan goi (gom
// phien o JS). Khi co bai dang dang, frontend auto-poll moi 4s + nhieu nhan vien cung mo
// Kho content -> hang loat lan quet toan bang giong het nhau lam server qua tai, request
// >12s -> danh sach ket o "Dang tai danh sach...". Cache theo "generation": moi lan GHI
// DB thi tang gen + xoa cache, nen doc trung nhau trong khoang khong co ghi la tra tuc
// thi (khong quet lai). Dong "Dang dang" (pending) lay tuoi rieng o route nen khong bi cu.
// TTL la luoi an toan phong truong hop co ghi tu tien trinh khac (bounded staleness).
let _histGen = 1;
const _HIST_TTL_MS = 5000;
const _histCache = new Map();

// Sau khi cache bi xoa (co ghi DB), chu dong tinh lai TRUOC view Kho content
// mac dinh (khong filter, trang 1) trong nen — thay vi de nguoi dung dau tien
// mo Kho content phai ganh chi phi quet toan bang ngay trong request cua ho
// (chinh la nguyen nhan "Server dang ban" khi vua dang bai xong). Debounce vi
// 1 phien dang (vd dang nhieu kenh) co the ghi DB nhieu lan lien tiep -> chi
// tinh lai 1 lan sau khi "yen" thay vi quet lai sau moi lan ghi.
const _DEFAULT_SESSION_SIZE = 20;
const _PREWARM_DEBOUNCE_MS = 400;
let _prewarmTimer = null;
function _schedulePrewarmDefaultView() {
  if (_prewarmTimer) clearTimeout(_prewarmTimer);
  _prewarmTimer = setTimeout(() => {
    _prewarmTimer = null;
    try { getPostHistorySessions({ sessionPage: 0, sessionSize: _DEFAULT_SESSION_SIZE }); }
    catch { /* best-effort, khong lam gian doan luong ghi */ }
  }, _PREWARM_DEBOUNCE_MS);
  if (_prewarmTimer.unref) _prewarmTimer.unref();
}

function _bustHistoryCache() {
  _histGen++;
  _histCache.clear();
  _schedulePrewarmDefaultView();
}
function _cachedHistory(key, compute) {
  const now = Date.now();
  const hit = _histCache.get(key);
  if (hit && hit.gen === _histGen && (now - hit.ts) < _HIST_TTL_MS) return hit.value;
  const value = compute();
  if (_histCache.size > 200) _histCache.clear(); // chan phinh bo nho
  _histCache.set(key, { gen: _histGen, ts: now, value });
  return value;
}

/**
 * Ghi log 1 bai dang
 */
function logPost({ profile, profileName, platform, target, groupName, groupId, message, imageCount, success, error, postUrl, source, images, batchId, jobId, website }) {
  _bustHistoryCache();
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
    batchId: batchId || null,
    jobId: jobId || null,
    website: website || null,
  });
}

function insertPendingPost({ profile, profileName, platform, target, groupName, groupId, message, imageCount, source, images, batchId, jobId, website }) {
  _bustHistoryCache();
  const result = insertPendingStmt.run({
    timestamp: new Date().toISOString(),
    profile: profile || 'unknown',
    profileName: profileName || profile || 'unknown',
    platform: platform || 'facebook',
    target: target || 'personal',
    groupName: groupName || null,
    groupId: groupId || null,
    message: message || null,
    imageCount: imageCount || 0,
    source: source || 'web',
    images: images && images.length ? JSON.stringify(images) : null,
    batchId: batchId || null,
    jobId: jobId || null,
    website: website || null,
  });
  return result.lastInsertRowid;
}

function completePendingPost(id, { success, error, postUrl, groupName, profile, profileName } = {}) {
  _bustHistoryCache();
  if (groupName !== undefined) {
    return completePendingWithGroupStmt.run({ id, success: success ? 1 : 0, error: error || null, postUrl: postUrl || null, groupName: groupName || null, profile: profile || '', profileName: profileName || '' });
  }
  return completePendingStmt.run({ id, success: success ? 1 : 0, error: error || null, postUrl: postUrl || null, profile: profile || '', profileName: profileName || '' });
}

function completePendingByJobId(jobId, { success, error, postUrl, profile, profileName } = {}) {
  _bustHistoryCache();
  return db.prepare(
    `UPDATE post_logs SET success=@success, error=@error, post_url=@postUrl,
       profile=COALESCE(NULLIF(@profile,''), profile),
       profile_name=COALESCE(NULLIF(@profileName,''), profile_name)
     WHERE job_id=@jobId AND success=-1`
  ).run({ jobId, success: success ? 1 : 0, error: error || null, postUrl: postUrl || null, profile: profile || '', profileName: profileName || '' });
}

// Cập nhật kết quả cuối cho 1 row theo id, KHÔNG ràng buộc success hiện tại.
// Dùng cho luồng auto-retry: row đang ở success=2 (chờ đăng lại) cần được ghi
// kết quả thật (1/0) mà completePendingPost (chỉ match success=-1) không xử lý được.
const completeByIdStmt = db.prepare(
  `UPDATE post_logs SET success=@success, error=@error, post_url=@postUrl, retry_at=NULL,
     profile=COALESCE(NULLIF(@profile,''), profile),
     profile_name=COALESCE(NULLIF(@profileName,''), profile_name)
   WHERE id=@id`
);
const completeByIdWithGroupStmt = db.prepare(
  `UPDATE post_logs SET success=@success, error=@error, post_url=@postUrl, retry_at=NULL, group_name=@groupName,
     profile=COALESCE(NULLIF(@profile,''), profile),
     profile_name=COALESCE(NULLIF(@profileName,''), profile_name)
   WHERE id=@id`
);
function completePostById(id, { success, error, postUrl, groupName, profile, profileName } = {}) {
  _bustHistoryCache();
  if (groupName !== undefined) {
    return completeByIdWithGroupStmt.run({ id, success: success ? 1 : 0, error: error || null, postUrl: postUrl || null, groupName: groupName || null, profile: profile || '', profileName: profileName || '' });
  }
  return completeByIdStmt.run({ id, success: success ? 1 : 0, error: error || null, postUrl: postUrl || null, profile: profile || '', profileName: profileName || '' });
}

// Đánh dấu 1 row là "đang chờ đăng lại" (rate-limit). success=2 là trạng thái riêng,
// không bị markTimedOutPending (chỉ quét success=-1) và bị loại khỏi thống kê.
const markRetryWaitingStmt = db.prepare(
  `UPDATE post_logs SET success=2, error=@error, retry_at=@retryAt, retry_count=@retryCount WHERE id=@id`
);
function markRetryWaiting(id, { error, retryAt, retryCount } = {}) {
  _bustHistoryCache();
  return markRetryWaitingStmt.run({ id, error: error || null, retryAt: retryAt || null, retryCount: retryCount || 0 });
}

// Kết thúc 1 row đang "chờ đăng lại" (success=2) thành Failed. Dùng khi lần tự
// đăng lại ném lỗi hoặc timer bị mất (server restart) — để row không kẹt mãi ở
// trạng thái "Chờ đăng lại". Chỉ đụng vào row còn ở success=2 (idempotent).
const failRetryWaitingStmt = db.prepare(
  `UPDATE post_logs SET success=0, error=@error, retry_at=NULL WHERE id=@id AND success=2`
);
function failRetryWaiting(id, error) {
  _bustHistoryCache();
  return failRetryWaitingStmt.run({ id, error: error || 'Tự đăng lại thất bại' });
}

// Danh sách các row đang chờ đăng lại (success=2) — dùng để dò row mồ côi khi khởi động.
function getRetryWaiting() {
  return db.prepare('SELECT id, retry_at, retry_count, error FROM post_logs WHERE success = 2').all();
}

function getPendingPosts() {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return db.prepare('SELECT * FROM post_logs WHERE success = -1 AND timestamp >= ? ORDER BY timestamp DESC').all(since).map(r => ({
    ...r,
    images: r.images ? safeParseJson(r.images) : [],
  }));
}

function cleanupStalePending() {
  _bustHistoryCache();
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM post_logs WHERE success = -1 AND timestamp < ?').run(cutoff);
}

// Mark pending posts older than maxAgeMs as failed (timeout) instead of leaving them stuck
function markTimedOutPending(maxAgeMs = 10 * 60 * 1000) {
  _bustHistoryCache();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  db.prepare(`UPDATE post_logs SET success=0, error='Timeout - không xác nhận được kết quả' WHERE success=-1 AND timestamp < ?`).run(cutoff);
}

/**
 * Dung menh de WHERE (kem params) chung cho cac truy van lich su — de getPostHistory
 * va getPostHistorySessions dung chung, tranh lech logic loc.
 */
function buildHistoryWhere({ profile, platform, target, groupId, success, from, to, search } = {}) {
  let sql = ' WHERE success != -1';
  const params = {};

  if (profile) {
    const vals = String(profile).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) { sql += ' AND profile = @profile'; params.profile = vals[0]; }
    else if (vals.length > 1) { vals.forEach((v, i) => { params[`profile${i}`] = v; }); sql += ` AND profile IN (${vals.map((_, i) => `@profile${i}`).join(',')})`; }
  }
  if (platform) {
    const vals = String(platform).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) { sql += ' AND platform = @platform'; params.platform = vals[0]; }
    else if (vals.length > 1) { vals.forEach((v, i) => { params[`platform${i}`] = v; }); sql += ` AND platform IN (${vals.map((_, i) => `@platform${i}`).join(',')})`; }
  }
  if (target) {
    const vals = String(target).split(',').map(s => s.trim()).filter(s => s === 'personal' || s === 'group');
    if (vals.length === 1) { sql += ' AND target = @target'; params.target = vals[0]; }
    else if (vals.length > 1) { sql += ' AND target IN (@targetA,@targetB)'; params.targetA = 'personal'; params.targetB = 'group'; }
  }
  if (success !== undefined && success !== null && success !== '') {
    const vals = String(success).split(',').map(s => s.trim()).filter(s => s === '0' || s === '1');
    if (vals.length === 1) { sql += ' AND success = @success'; params.success = Number(vals[0]); }
    // vals.length > 1 means both 0 and 1 → no filter needed
  }
  if (from) {
    sql += ' AND timestamp >= @from';
    params.from = from;
  }
  if (to) {
    sql += ' AND timestamp <= @to';
    params.to = to;
  }
  if (groupId) {
    const vals = String(groupId).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) {
      sql += ' AND (group_id = @groupId OR group_name = @groupId)';
      params.groupId = vals[0];
    } else if (vals.length > 1) {
      const clauses = vals.map((v, i) => { params[`gid${i}`] = v; return `(group_id = @gid${i} OR group_name = @gid${i})`; });
      sql += ` AND (${clauses.join(' OR ')})`;
    }
  }
  if (search !== undefined && search !== null && String(search).trim() !== '') {
    // Tim kiem theo tu khoa tren toan bo du lieu (truoc khi phan trang),
    // de bai viet khop keyword hien thi du dang o trang nao
    const term = String(search).trim();
    params.search = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    sql += ` AND (
      message LIKE @search ESCAPE '\\'
      OR group_name LIKE @search ESCAPE '\\'
      OR group_id LIKE @search ESCAPE '\\'
      OR profile_name LIKE @search ESCAPE '\\'
      OR profile LIKE @search ESCAPE '\\'
    )`;
  }
  return { where: sql, params };
}

/**
 * Lay lich su bai dang voi filter (phan trang theo DONG)
 */
function getPostHistory({ limit = 50, offset = 0, ...filters } = {}) {
  return _cachedHistory('h:' + JSON.stringify({ limit, offset, ...filters }), () => {
    const { where, params } = buildHistoryWhere(filters);

    const { total } = db.prepare('SELECT COUNT(*) as total FROM post_logs' + where).get(params);

    const rows = db.prepare('SELECT * FROM post_logs' + where + ' ORDER BY timestamp DESC LIMIT @limit OFFSET @offset')
      .all({ ...params, limit, offset })
      .map(r => ({ ...r, images: r.images ? safeParseJson(r.images) : [] }));

    return { total, rows };
  });
}

/**
 * Lay lich su phan trang theo PHIEN (session) — thay vi tra toan bo dong ve client
 * roi gom+phan trang o do (nang, de treo khi nhieu bai). Server gom phien roi CHI tra
 * ve cac dong thuoc trang phien yeu cau. Logic gom trung khop client:
 *   - cung batch_id, HOAC
 *   - cung message + cung image_count + cach anchor < 10 phut.
 * Vi cac dong sap theo timestamp DESC va phien la day lien tuc, trang phien = mot lat
 * cat lien tuc cua danh sach dong → dung LIMIT/OFFSET theo dong (khong can IN nhieu id).
 */
function getPostHistorySessions({ sessionPage = 0, sessionSize = 10, ...filters } = {}) {
  return _cachedHistory('s:' + JSON.stringify({ sessionPage, sessionSize, ...filters }), () =>
    _computePostHistorySessions({ sessionPage, sessionSize, ...filters }));
}

function _computePostHistorySessions({ sessionPage = 0, sessionSize = 10, ...filters } = {}) {
  const { where, params } = buildHistoryWhere(filters);

  // Doc cot toi thieu cua TOAN BO dong khop filter (cuc bo, nhanh) de gom phien.
  const lite = db.prepare('SELECT id, timestamp, batch_id, message, image_count FROM post_logs' + where + ' ORDER BY timestamp DESC').all(params);
  const total = lite.length;

  const TEN_MIN = 10 * 60 * 1000;
  const groups = [];
  let cur = null, idx = 0;
  for (const r of lite) {
    const merge = cur && (
      (cur.anchor.batch_id && r.batch_id && cur.anchor.batch_id === r.batch_id) ||
      (cur.anchor.message && r.message && cur.anchor.message === r.message &&
        (cur.anchor.image_count || 0) === (r.image_count || 0) &&
        Math.abs(new Date(r.timestamp).getTime() - new Date(cur.anchor.timestamp).getTime()) < TEN_MIN)
    );
    if (merge) { cur.count++; }
    else { cur = { anchor: r, count: 1, rowStart: idx }; groups.push(cur); }
    idx++;
  }
  const totalSessions = groups.length;

  const start = Math.max(0, sessionPage * sessionSize);
  const pageGroups = groups.slice(start, start + sessionSize);
  const rowStart = pageGroups.length ? pageGroups[0].rowStart : 0;
  const rowCount = pageGroups.reduce((s, g) => s + g.count, 0);

  const rows = rowCount > 0
    ? db.prepare('SELECT * FROM post_logs' + where + ' ORDER BY timestamp DESC LIMIT @limit OFFSET @offset')
        .all({ ...params, limit: rowCount, offset: rowStart })
        .map(r => ({ ...r, images: r.images ? safeParseJson(r.images) : [] }))
    : [];

  return { total, totalSessions, sessionPage, sessionSize, rows };
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
    FROM post_logs WHERE success IN (0,1) ${dateFilter}
  `).get(params);

  // Hom nay
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE success IN (0,1) AND timestamp >= @todayStart
  `).get({ todayStart: todayStart.toISOString() });

  // Theo ngay (30 ngay gan nhat)
  const daily = db.prepare(`
    SELECT
      DATE(timestamp) as date,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs
    WHERE success IN (0,1) AND timestamp >= DATE('now', '-30 days') ${dateFilter}
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
  `).all(params);

  // Theo profile
  const byProfile = db.prepare(`
    SELECT
      profile, profile_name, platform,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE success IN (0,1) ${dateFilter}
    GROUP BY profile, platform
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
    WHERE success IN (0,1) AND group_name IS NOT NULL ${dateFilter}
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
    FROM post_logs WHERE success IN (0,1) ${dateFilter}
    GROUP BY platform
    ORDER BY total DESC
  `).all(params);

  return { summary, today, daily, byProfile, byGroup, byPlatform };
}

function getDailyByProfile({ days = 30, from, to } = {}) {
  if (from || to) {
    const params = {};
    let where = 'success IN (0,1)';
    if (from) { where += ' AND timestamp >= @from'; params.from = from; }
    if (to) { where += ' AND timestamp <= @to'; params.to = to; }
    return db.prepare(`
      SELECT DATE(timestamp) as date, profile,
        COALESCE(profile_name, profile) as profile_name, COUNT(*) as count
      FROM post_logs WHERE ${where}
      GROUP BY DATE(timestamp), profile ORDER BY date ASC
    `).all(params);
  }
  return db.prepare(`
    SELECT DATE(timestamp) as date, profile,
      COALESCE(profile_name, profile) as profile_name, COUNT(*) as count
    FROM post_logs WHERE success IN (0,1) AND timestamp >= DATE('now', '-' || ? || ' days')
    GROUP BY DATE(timestamp), profile ORDER BY date ASC
  `).all(days);
}

function deleteById(id) {
  _bustHistoryCache();
  return db.prepare('DELETE FROM post_logs WHERE id = ?').run(id);
}

function deleteByIds(ids) {
  if (!ids || ids.length === 0) return { changes: 0 };
  _bustHistoryCache();
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM post_logs WHERE id IN (${placeholders})`).run(ids);
}

// Cập nhật link sản phẩm (website) cho 1 hoặc nhiều bài (sửa từ Dashboard).
// website rỗng → set null (xoá link).
function updateWebsiteByIds(ids, website) {
  if (!ids || ids.length === 0) return { changes: 0 };
  _bustHistoryCache();
  const w = (website != null && String(website).trim()) ? String(website).trim() : null;
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`UPDATE post_logs SET website = ? WHERE id IN (${placeholders})`).run(w, ...ids);
}

function deleteByFilter({ profile, success, from, to } = {}) {
  _bustHistoryCache();
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

function getByProfileStats({ profile, platform, target, groupId, from, to } = {}) {
  let sql = `SELECT profile, profile_name, platform,
    COUNT(*) as total,
    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM post_logs WHERE success IN (0,1)`;
  const params = {};

  if (profile) {
    const vals = String(profile).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) { sql += ' AND profile = @profile'; params.profile = vals[0]; }
    else if (vals.length > 1) { vals.forEach((v, i) => { params[`profile${i}`] = v; }); sql += ` AND profile IN (${vals.map((_, i) => `@profile${i}`).join(',')})`; }
  }
  if (platform) {
    const vals = String(platform).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) { sql += ' AND platform = @platform'; params.platform = vals[0]; }
    else if (vals.length > 1) { vals.forEach((v, i) => { params[`platform${i}`] = v; }); sql += ` AND platform IN (${vals.map((_, i) => `@platform${i}`).join(',')})`; }
  }
  if (target) {
    const vals = String(target).split(',').map(s => s.trim()).filter(s => s === 'personal' || s === 'group');
    if (vals.length === 1) { sql += ' AND target = @target'; params.target = vals[0]; }
    else if (vals.length > 1) { sql += ' AND target IN (@targetA,@targetB)'; params.targetA = 'personal'; params.targetB = 'group'; }
  }
  if (groupId) {
    const vals = String(groupId).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) {
      sql += ' AND (group_id = @groupId OR group_name = @groupId)';
      params.groupId = vals[0];
    } else if (vals.length > 1) {
      const clauses = vals.map((v, i) => { params[`gid${i}`] = v; return `(group_id = @gid${i} OR group_name = @gid${i})`; });
      sql += ` AND (${clauses.join(' OR ')})`;
    }
  }
  if (from) { sql += ' AND timestamp >= @from'; params.from = from; }
  if (to) { sql += ' AND timestamp <= @to'; params.to = to; }

  sql += ' GROUP BY profile, platform ORDER BY total DESC';
  return db.prepare(sql).all(params);
}

module.exports = { logPost, insertPendingPost, completePendingPost, completePendingByJobId, completePostById, markRetryWaiting, failRetryWaiting, getRetryWaiting, getPendingPosts, cleanupStalePending, markTimedOutPending, getPostHistory, getPostHistorySessions, getStatistics, getDailyByProfile, getByProfileStats, deleteById, deleteByIds, deleteByFilter, updateWebsiteByIds };
