const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { execFile } = require('child_process');
const config = require('./config/default');
const logger = require('./src/utils/logger');
const playwright = process.env.PLAYWRIGHT_LOCAL_URL
  ? require('./playwright-proxy')
  : require('./src/playwright/post');
const postLogger = require('./src/database/post-logger');
const seedStore = require('./src/database/seed-store');
const { queuePost } = require('./src/utils/post-queue');

const permissions = require('./src/utils/permissions');
const auth = require('./src/utils/auth');

const app = express();
app.use(express.json());

// ===== GIT AUTO-COMMIT (debounce 30s) =====
// Dùng cho channels.json, saved-posts.json, profiles-meta.json — không dùng cho proxies.json (lưu ở local).
const REPO_ROOT = path.resolve(__dirname, '..');
let _dataCommitTimer = null;
function scheduleDataCommit(message) {
  if (_dataCommitTimer) clearTimeout(_dataCommitTimer);
  _dataCommitTimer = setTimeout(() => {
    _dataCommitTimer = null;
    const msg = message || 'chore: auto-save data';
    const dataFiles = ['data/channels.json', 'data/saved-posts.json', 'data/profiles-meta.json']
      .filter(f => fs.existsSync(path.join(REPO_ROOT, f)));
    if (!dataFiles.length) return;
    execFile('git', ['-C', REPO_ROOT, 'add', ...dataFiles], (err) => {
      if (err) return logger.warn(`git add data: ${err.message}`);
      execFile('git', ['-C', REPO_ROOT, 'diff', '--cached', '--quiet'], (diffErr) => {
        if (!diffErr) return; // nothing staged
        execFile('git', ['-C', REPO_ROOT, 'commit', '-m', msg], (cErr) => {
          if (cErr) return logger.warn(`git commit data: ${cErr.message}`);
          execFile('git', ['-C', REPO_ROOT, 'push', 'origin', 'HEAD'], (pErr) => {
            if (pErr) logger.warn(`git push data: ${pErr.message}`);
            else logger.info(`data auto-committed & pushed: ${msg}`);
          });
        });
      });
    });
  }, 30_000);
}

// Auth gate: cần login basso.vn + được admin Xeko phân quyền mới được vào trang.
// /admin, /platform, /api/auth (basso.vn) đi route khác — chỉ chặn frontend Xeko.
// /api/me: frontend tự kiểm tra session — public.
// /api/register-local: local server tự xác thực bằng x-api-key — public.
const PUBLIC_PATHS = ['/health', '/api/me', '/api/register-local'];
app.use(async (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_PATHS.includes(req.path)) return next();
  // Ảnh thumbnail không cần auth riêng — user đã login mới vào được app
  if (req.path.startsWith('/api/image/')) return next();

  // API endpoints: trả JSON 401/403
  if (req.path.startsWith('/api/')) {
    return auth.requireAuth(permissions)(req, res, next);
  }

  // Static: chặn truy cập index.html khi chưa login → redirect về trang login basso.vn
  // (file css/js khác không cần auth — đỡ phá UX của trang login)
  const needsGate = req.path === '/' || req.path === '/index.html' || req.path.endsWith('/index.html');
  if (!needsGate) return next();
  const user = await auth.verifyBassoSession(req.headers.cookie || '');
  if (!user) {
    return res.redirect('/admin/login.html');
  }
  if (!permissions.hasAccess(user.email)) {
    return res
      .status(403)
      .send(`<!doctype html><meta charset="utf-8"><title>Chưa được phân quyền</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:480px;text-align:center}
h1{color:#dc2626;margin:0 0 16px}p{color:#555;line-height:1.6}
.email{background:#f3f4f6;padding:8px 12px;border-radius:6px;font-family:monospace;display:inline-block;margin:8px 0}
a{color:#4f46e5;text-decoration:none}</style>
<div class="box"><h1>🔒 Chưa được phân quyền</h1>
<p>Tài khoản <span class="email">${user.email}</span> chưa được cấp quyền sử dụng Xeko.</p>
<p>Vui lòng liên hệ admin Xeko để được phân quyền.</p>
<p><a href="/admin/dashboard.html">← Quay lại basso.vn</a></p></div>`);
  }
  next();
});

// Early request logger cho các POST endpoint hay timeout / mất handle.
// Log NGAY sau khi auth pass, TRƯỚC multer + handler — để khi user báo "ko thấy
// chạy", ta phân biệt được:
//   - Có dòng [REQ] này mà không có [/api/post] queue job → multer fail/hang
//   - Không có dòng [REQ] này → request chưa tới Express (proxy/network cắt)
const _LOG_POST_PATHS = new Set(['/api/post', '/api/schedule', '/api/zalo/post']);
app.use((req, res, next) => {
  if (req.method === 'POST' && _LOG_POST_PATHS.has(req.path)) {
    const len = req.headers['content-length'] || '?';
    const ua = (req.headers['user-agent'] || '').slice(0, 50);
    logger.info(`[REQ] POST ${req.path} — len=${len}, ip=${req.ip}, ua="${ua}"`);
  }
  next();
});

// HTML không được cache — browser và SW phải luôn fetch mới sau mỗi lần deploy.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  // sw.js: browser tự cache-bust (dùng conditional GET), nhưng proxy/CDN cần no-store
  } else if (req.path === '/sw.js') {
    res.set('Cache-Control', 'no-store');
  // API: dữ liệu động — không cache ở bất kỳ tầng nào (browser, CDN, nginx)
  } else if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../')));

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

// Multer: lưu ảnh upload vào temp/
const TEMP_DIR = path.resolve(__dirname, '../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Uploads persistent (thumbnail trong history). Temp files sau khi post xong
// được copy sang đây để browser xem lại được. Serve qua /api/image/*
// (nằm trong namespace /api nên chắc chắn được reverse proxy forward).
// Đặt trong data/ để dùng chung persistent volume với posts.db —
// tránh mất ảnh mỗi lần server redeploy (filesystem ephemeral).
const UPLOADS_DIR = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/uploads')
  : path.resolve(__dirname, '../data/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.get('/api/image/:date/:filename', async (req, res) => {
  const { date, filename } = req.params;
  // Chặn path traversal
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || /[/\\]/.test(filename)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(UPLOADS_DIR, date, filename);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(400).send('Bad request');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);

  // Proxy fallback: file không có local → thử fetch từ image server (nếu có cấu hình).
  // Không yêu cầu IMAGE_SERVER_PROXY_MODE vì khi file không tồn tại local thì
  // proxy là fallback hợp lý duy nhất.
  const IMAGE_SERVER_URL = (process.env.IMAGE_SERVER_URL || '').replace(/\/+$/, '');
  if (IMAGE_SERVER_URL) {
    try {
      const fetchFn = await getFetch();
      const upstream = await fetchFn(`${IMAGE_SERVER_URL}/img/${date}/${filename}`);
      if (!upstream.ok) return res.status(upstream.status).send('Not found');
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.send(buf);
    } catch (e) {
      logger.warn(`/api/image proxy upstream fail: ${e.message}`);
      return res.status(502).send('Upstream error');
    }
  }
  return res.status(404).send('Not found');
});

// Lưu local — dùng trực tiếp khi chưa cấu hình IMAGE_SERVER_URL, hoặc làm
// fallback khi gọi VPS ảnh thất bại. URL trả về là path tương đối /api/image/...
function persistImagesLocal(imagePaths) {
  if (!imagePaths || !imagePaths.length) return [];
  const now = new Date();
  const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const targetDir = path.join(UPLOADS_DIR, dateDir);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const urls = [];
  for (const p of imagePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const filename = path.basename(p);
      const target = path.join(targetDir, filename);
      fs.copyFileSync(p, target);
      urls.push(`/api/image/${dateDir}/${filename}`);
    } catch (e) {
      logger.error(`persistImagesLocal: ${e.message}`);
    }
  }
  return urls;
}

// Upload sang VPS ảnh phụ. Nếu IMAGE_SERVER_URL không set thì fallback local.
// Nếu upload fail (network, 5xx...) cũng fallback local — không để mất thumbnail.
//
// Circuit breaker: sau khi remote fail, tạm coi remote down trong 5 phút để
// tránh spam warn + tốn thời gian retry mỗi post. Hết cooldown sẽ probe lại.
const _remoteImgState = { downUntil: 0, lastWarnAt: 0 };
const REMOTE_COOLDOWN_MS = 5 * 60 * 1000;

async function persistImages(imagePaths) {
  if (!imagePaths || !imagePaths.length) return [];

  const IMAGE_SERVER_URL = (process.env.IMAGE_SERVER_URL || '').replace(/\/+$/, '');
  if (!IMAGE_SERVER_URL) return persistImagesLocal(imagePaths);

  const now = Date.now();
  if (_remoteImgState.downUntil > now) {
    // Im lặng fallback local trong cooldown — đã warn từ đầu chu kỳ
    return persistImagesLocal(imagePaths);
  }

  try {
    const fetchFn = await getFetch();
    const useNative = typeof fetch !== 'undefined';
    let form, headers;
    let appended = 0;

    if (useNative) {
      // Node 18+: dùng native FormData + Blob để content-length được set đúng
      form = new FormData();
      for (const p of imagePaths) {
        if (!fs.existsSync(p)) continue;
        const buf = fs.readFileSync(p);
        form.append('images', new Blob([buf]), path.basename(p));
        appended++;
      }
      headers = { 'x-api-key': process.env.IMAGE_SERVER_API_KEY || '' };
    } else {
      const FD = (await import('form-data')).default;
      form = new FD();
      for (const p of imagePaths) {
        if (!fs.existsSync(p)) continue;
        form.append('images', fs.createReadStream(p), { filename: path.basename(p) });
        appended++;
      }
      headers = { ...form.getHeaders(), 'x-api-key': process.env.IMAGE_SERVER_API_KEY || '' };
    }
    if (!appended) return [];

    const response = await fetchFn(`${IMAGE_SERVER_URL}/upload`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(60000), // 1 phút
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.urls)) throw new Error('Invalid response from image server');

    // Remote phục hồi sau cooldown — log để biết
    if (_remoteImgState.downUntil) {
      logger.info('persistImages: remote image server đã phục hồi');
      _remoteImgState.downUntil = 0;
    }

    // Luôn đổi relative URL (/img/...) sang /api/image/... để browser load qua
    // route của VPS chính. Absolute URL (khi PUBLIC_URL được set trên image server)
    // truyền qua nguyên vẹn — browser load thẳng từ image server public.
    return data.urls.map((u) => {
      const m = String(u).match(/\/img\/(\d{4}-\d{2}-\d{2})\/([^/?#]+)/);
      return m ? `/api/image/${m[1]}/${m[2]}` : u;
    });
  } catch (e) {
    // Mở circuit breaker — skip remote 5 phút tới, chỉ warn 1 lần
    _remoteImgState.downUntil = now + REMOTE_COOLDOWN_MS;
    if (now - _remoteImgState.lastWarnAt > REMOTE_COOLDOWN_MS) {
      logger.warn(`persistImages: remote down (${e.message}) → fallback local trong ${REMOTE_COOLDOWN_MS / 60000} phút`);
      _remoteImgState.lastWarnAt = now;
    }
    return persistImagesLocal(imagePaths);
  }
}

// Format mimetype mở rộng để chấp nhận ảnh từ iPhone (HEIC/HEIF) và webp
const ACCEPTED_IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB/ảnh — iPhone HD photo thường <15MB
    files: 20,                   // tối đa 20 ảnh/bài
  },
  fileFilter: (req, file, cb) => {
    // Một số iPhone export với mimetype 'application/octet-stream' — fallback
    // check theo phần mở rộng để vẫn nhận được ảnh
    if (file.mimetype.startsWith('image/') || ACCEPTED_IMAGE_EXTS.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`File "${file.originalname}" không phải ảnh (${file.mimetype})`));
    }
  },
});

let postCount = 0;
let lastResetDate = new Date().toDateString();

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    postCount = 0;
    lastResetDate = today;
  }
}

function cleanupFiles(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// ===== API =====

// Chon profile
app.post('/api/profile', async (req, res) => {
  const { profile } = req.body;

  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ profile }),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      playwright.setProfile(profile);
      return res.json({ success: true, name: data.name || profile });
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  try {
    const p = playwright.setProfile(profile);
    res.json({ success: true, name: p.name || profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Dọn pending rows cũ còn sót từ lần khởi động trước (server crash / kill)
postLogger.cleanupStalePending();

// Định kỳ mỗi 10 phút: mark pending posts > 10 phút là failed (timeout)
setInterval(() => postLogger.markTimedOutPending(10 * 60 * 1000), 10 * 60 * 1000);

// Job queue: post chạy async để tránh reverse proxy timeout ở ~60s.
// Browser POST /api/post → trả ngay {jobId}, rồi polling /api/job/:id.
const postJobs = new Map();

function createJob() {
  const id = crypto.randomBytes(8).toString('hex');
  postJobs.set(id, { status: 'pending', createdAt: Date.now() });
  return id;
}

// SSE: push job result ngay về browser — không cần chờ poll cycle
const _sseClients = new Set();

function sseNotify(jobId, status, result, error) {
  if (_sseClients.size === 0) return;
  const data = `data: ${JSON.stringify({ jobId, status, result: result || null, error: error || null })}\n\n`;
  for (const res of _sseClients) {
    try { res.write(data); } catch { _sseClients.delete(res); }
  }
}

function setJobResult(id, result) {
  const success = result && result.success;
  logger.info(`[setJobResult] job=${id} success=${success} postUrl=${(result && result.postUrl) || '(none)'}`);
  postJobs.set(id, { status: 'done', result, createdAt: Date.now() });
  sseNotify(id, 'done', result, null);
}

function setJobError(id, message) {
  logger.info(`[setJobError] job=${id} error=${message}`);
  postJobs.set(id, { status: 'failed', error: message, createdAt: Date.now() });
  sseNotify(id, 'failed', null, message);
}

// Dọn job cũ mỗi giờ
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of postJobs) {
    if (now - job.createdAt > 3600_000) postJobs.delete(id);
  }
}, 3600_000);

async function executePost({ profile, profileDisplayName, message, target, groupId, groupKeywords, imagePaths, imageUrls, batchId, pendingLogId = null, jobId: _jobId = null }) {
  if (profile) await playwright.setProfile(profile);

  // Snapshot 1 lần ngay đầu — không gọi getActiveProfile() sau await (global có thể bị đổi)
  const _pData = playwright.getActiveProfile();
  const profileKey  = profile || _pData.key || '';
  // Prefer display name sent from frontend (most reliable), fall back to server-resolved name
  const profileName = profileDisplayName || _pData.name || profileKey;

  if (!batchId) batchId = crypto.randomUUID();

  // Helper: dùng completePendingPost nếu có pendingLogId, fallback về job_id, rồi mới logPost
  const _doLog = (logArgs, result, groupName) => {
    if (pendingLogId) {
      const upd = postLogger.completePendingPost(pendingLogId, { success: result.success, error: result.error, postUrl: result.postUrl, groupName });
      if (upd && upd.changes > 0) return;
      // 0 changes → row bị markTimedOut hoặc id sai → thử bằng job_id
      if (_jobId) {
        const upd2 = postLogger.completePendingByJobId(_jobId, { success: result.success, error: result.error, postUrl: result.postUrl });
        if (upd2 && upd2.changes > 0) return;
      }
    }
    postLogger.logPost(logArgs);
  };

  // Đăng lên cá nhân + tất cả group (multi-target, không dùng pendingLogId)
  if (target === 'all') {
    const results = [];
    if (postCount < config.posting.maxPostsPerDay) {
      logger.info('Đang đăng lên FB cá nhân...');
      const r = await playwright.postToPersonal(message, imagePaths);
      postCount++;
      postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
      results.push({ target: 'FB Cá nhân', success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error });
      await new Promise(res => setTimeout(res, Math.floor(Math.random() * 30000) + 30000));
    }

    const groups = Object.values(config.groups);
    for (const group of groups) {
      if (postCount >= config.posting.maxPostsPerDay) break;
      logger.info(`Đang đăng lên ${group.name}...`);
      const r = await playwright.postToGroup(group.id, message, imagePaths);
      postCount++;
      postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
      results.push({ target: group.name, success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error });
      if (groups.indexOf(group) < groups.length - 1) {
        await new Promise(res => setTimeout(res, Math.floor(Math.random() * 30000) + 30000));
      }
    }
    return { results };
  }

  if (target === 'allgroup') {
    const groups = Object.values(config.groups);
    const results = [];
    for (const group of groups) {
      if (postCount >= config.posting.maxPostsPerDay) break;
      logger.info(`Đang đăng lên ${group.name}...`);
      const r = await playwright.postToGroup(group.id, message, imagePaths);
      postCount++;
      postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
      results.push({ target: group.name, success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error });
      if (groups.indexOf(group) < groups.length - 1) {
        await new Promise(res => setTimeout(res, Math.floor(Math.random() * 30000) + 30000));
      }
    }
    return { results };
  }

  if (target === 'shortcut') {
    const group = config.groups[groupId];
    const r = await playwright.postToGroup(group.id, message, imagePaths);
    postCount++;
    _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r);
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
  }

  if (target === 'group') {
    const r = await playwright.postToGroup(groupId, message, imagePaths);
    postCount++;
    _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupId, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r);
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
  }

  if (target === 'page') {
    const r = await playwright.postToPage(groupId, message, imagePaths);
    postCount++;
    _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'page', groupId, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r);
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
  }

  // personal + chia sẻ lên nhóm trong 1 bài đăng
  if (target === 'personal-share-groups') {
    const keywords = Array.isArray(groupKeywords) ? groupKeywords : [];
    if (keywords.length === 0) {
      // Không có nhóm → fallback đăng cá nhân thường
      const r = await playwright.postToPersonal(message, imagePaths);
      postCount++;
      _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r);
      return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
    }
    const r = await playwright.postPersonalAndShareToGroups(message, imagePaths, keywords);
    postCount++;
    const sharedGroupNames = Array.isArray(r.sharedGroups) ? r.sharedGroups : [];
    const missedGroupNames = Array.isArray(r.missedGroups) ? r.missedGroups : [];
    const groupNameVal = (sharedGroupNames.length || missedGroupNames.length) ? JSON.stringify({ ok: sharedGroupNames, miss: missedGroupNames }) : null;
    _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'personal+groups', groupName: groupNameVal, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r, groupNameVal);
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error, sharedGroups: sharedGroupNames, missedGroups: missedGroupNames };
  }

  // personal (default)
  const r = await playwright.postToPersonal(message, imagePaths);
  postCount++;
  _doLog({ profile: profileKey, profileName, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId }, r);
  return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
}

// Dang bai (async job)
app.post('/api/post', upload.array('images', 20), async (req, res) => {
  checkDailyReset();

  const { message, target, groupId, profile, profileDisplayName, batchId } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  // groupKeywords gửi qua multipart dưới dạng JSON string (target=personal-share-groups)
  let groupKeywords = [];
  if (req.body.groupKeywords) {
    try {
      const parsed = JSON.parse(req.body.groupKeywords);
      if (Array.isArray(parsed)) groupKeywords = parsed.map(k => String(k).trim()).filter(Boolean);
    } catch {
      cleanupFiles(imagePaths);
      return res.status(400).json({ error: 'groupKeywords phải là JSON array hợp lệ' });
    }
  }

  // Kiem tra nhanh (sync) — trả lỗi luôn nếu sai.
  // KHÔNG được setProfile ở đây vì race với job đang chạy: nhiều request POST /api/post
  // song song (dashboard "đăng 7 nơi") sẽ liên tục đè global activeProfile, khiến job
  // đang await page.goto() đọc nhầm profile khác khi resume → fail openCreatePost.
  if (profile) {
    if (!playwright.profileExists(profile)) {
      cleanupFiles(imagePaths);
      return res.status(400).json({ error: `Profile "${profile}" không tồn tại — thêm tài khoản trong UI Web trước.` });
    }
  } else {
    try { playwright.getActiveProfile(); }
    catch {
      cleanupFiles(imagePaths);
      return res.status(400).json({ error: 'Chưa chọn profile!' });
    }
  }

  if (postCount >= config.posting.maxPostsPerDay) {
    cleanupFiles(imagePaths);
    return res.json({ error: `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.` });
  }

  if (target === 'shortcut' && !config.groups[groupId]) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: `Group "${groupId}" không tồn tại` });
  }

  // Copy ảnh sang uploads/ (persistent) để DB log URL + browser render thumbnail
  // sau này. File gốc trong temp/ vẫn giữ để Playwright dùng, dọn ở finally.
  const imageUrls = await persistImages(imagePaths);

  // Pre-insert pending row cho single-target jobs để dashboard có thể show "Đang đăng" ngay
  // và cập nhật trạng thái khi xong — không cần in-memory _activeRepostJobs.
  const isSingleTarget = target !== 'all' && target !== 'allgroup';
  let pendingLogId = null;
  if (isSingleTarget) {
    const pendingTarget = target === 'personal-share-groups' ? 'personal+groups' : (target || 'personal');
    const pendingGroupId = (target === 'group' || target === 'page') ? groupId : (target === 'shortcut' ? groupId : null);
    const pendingGroupName = target === 'shortcut' ? (config.groups[groupId]?.name || null) : null;
    const jobId = createJob();
    pendingLogId = postLogger.insertPendingPost({
      profile: profile || '',
      profileName: profileDisplayName || profile || '',
      platform: 'facebook',
      target: pendingTarget,
      groupName: pendingGroupName,
      groupId: pendingGroupId || null,
      message,
      imageCount: imagePaths.length,
      source: 'web',
      images: imageUrls,
      batchId,
      jobId,
    });
    res.json({ jobId, status: 'pending', pendingLogId });

    const targetDesc = target === 'group' ? `group:${groupId}` : (target || 'personal');
    logger.info(`[/api/post] queue job ${jobId} — profile=${profile || '(active)'}, target=${targetDesc}, images=${imagePaths.length}, batch=${batchId || '-'}, pendingLogId=${pendingLogId}`);
    const tQueued = Date.now();

    queuePost(() => {
      const tStart = Date.now();
      logger.info(`[job ${jobId}] start (waited ${tStart - tQueued}ms in queue) — profile=${profile || '(active)'}, target=${targetDesc}`);
      return executePost({ profile, profileDisplayName, message, target, groupId, groupKeywords, imagePaths, imageUrls, batchId, pendingLogId, jobId })
        .finally(() => logger.info(`[job ${jobId}] done in ${Date.now() - tStart}ms`));
    })
      .then(result => setJobResult(jobId, result))
      .catch(error => {
        logger.error(`[job ${jobId}] FAILED: ${error.message}`);
        postLogger.completePendingPost(pendingLogId, { success: false, error: error.message });
        setJobError(jobId, error.message);
      })
      .finally(() => cleanupFiles(imagePaths));
    return;
  }

  // Multi-target jobs (all / allgroup): không pre-insert, dùng in-memory _activeRepostJobs như cũ
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  const targetDesc = target === 'group' ? `group:${groupId}` : (target || 'personal');
  logger.info(`[/api/post] queue job ${jobId} — profile=${profile || '(active)'}, target=${targetDesc}, images=${imagePaths.length}, batch=${batchId || '-'}`);
  const tQueued = Date.now();

  // Chạy post qua serial queue — tránh race condition profile
  queuePost(() => {
    const tStart = Date.now();
    logger.info(`[job ${jobId}] start (waited ${tStart - tQueued}ms in queue) — profile=${profile || '(active)'}, target=${targetDesc}`);
    return executePost({ profile, profileDisplayName, message, target, groupId, groupKeywords, imagePaths, imageUrls, batchId })
      .finally(() => logger.info(`[job ${jobId}] done in ${Date.now() - tStart}ms`));
  })
    .then(result => setJobResult(jobId, result))
    .catch(error => {
      logger.error(`[job ${jobId}] FAILED: ${error.message}`);
      setJobError(jobId, error.message);
    })
    .finally(() => cleanupFiles(imagePaths));
});

app.get('/api/job/:id', (req, res) => {
  const job = postJobs.get(req.params.id);
  if (!job) {
    logger.warn(`[api/job] ${req.params.id} → 404 (not found)`);
    return res.status(404).json({ error: 'Job không tồn tại hoặc đã hết hạn' });
  }
  if (job.status !== 'pending') {
    logger.info(`[api/job] ${req.params.id} → ${job.status}`);
  }
  res.json(job);
});

// SSE: browser subscribe để nhận job result ngay khi Playwright xong
// Auth được xử lý bởi global middleware (/api/* → auth.requireAuth(permissions))
app.get('/api/job-events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // tắt nginx/proxy buffering
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  _sseClients.add(res);

  req.on('close', () => {
    clearInterval(ping);
    _sseClients.delete(res);
  });
});

// ===== SCRAPE: Lấy nội dung + ảnh từ link bài viết FB — ASYNC JOB =====
// POST body: { url, profile? }
// Trả {jobId} ngay; poll /api/job/:id để lấy { text, imageUrls }
// Tunnel mode: playwright module là playwright-proxy.js → scrapePost() tự gọi local + poll
app.post('/api/fb-scrape', async (req, res) => {
  const { url, profile } = req.body;
  if (!url) return res.status(400).json({ error: 'Thiếu url bài viết' });

  if (profile) {
    if (!playwright.profileExists(profile)) {
      return res.status(400).json({ error: `Profile "${profile}" không tồn tại` });
    }
  } else {
    try { playwright.getActiveProfile(); } catch {
      return res.status(400).json({ error: 'Chưa chọn profile!' });
    }
  }

  const jobId = createJob();
  res.json({ jobId, status: 'pending' });
  logger.info(`[fb-scrape] job ${jobId} — profile=${profile || '(active)'}, url=${url}`);

  (async () => {
    try {
      if (profile) await playwright.setProfile(profile);
      const result = await playwright.scrapePost(url);
      setJobResult(jobId, {
        success: result.success,
        text: result.text || '',
        imageUrls: result.imageUrls || [],
        error: result.error,
      });
    } catch (e) {
      logger.error(`[fb-scrape] job ${jobId} FAILED: ${e.message}`);
      setJobError(jobId, e.message);
    }
  })();
});

// ===== TEST: FB Quick Post v2 (dev only) — ASYNC JOB pattern =====
// Test có thể chạy > 2 phút → cloud proxy nginx 502 nếu sync.
// Trả jobId ngay, chạy background, UI poll /api/job/:id.
app.post('/api/fb-quick-post-test', upload.array('images', 20), async (req, res) => {
  const { profile, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  let groupKeywords = [];
  if (req.body.groupKeywords) {
    try {
      const parsed = JSON.parse(req.body.groupKeywords);
      if (Array.isArray(parsed)) groupKeywords = parsed.map(k => String(k).trim()).filter(Boolean);
    } catch {
      cleanupFiles(imagePaths);
      return res.status(400).json({ error: 'groupKeywords phải là JSON array hợp lệ' });
    }
  }

  if (!profile) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu profile' });
  }

  // Trả jobId ngay
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });
  logger.info(`[fb-quick-post-test] queue job ${jobId} — profile=${profile}, groups=${groupKeywords.length}, ảnh=${imagePaths.length}`);

  // Chạy background
  (async () => {
    try {
      await playwright.setProfile(profile);
      const result = await playwright.quickPostToPersonalAndGroups(message || '', imagePaths, groupKeywords);
      setJobResult(jobId, result);
      logger.info(`[fb-quick-post-test] job ${jobId} done — success=${result.success}`);
    } catch (e) {
      logger.error(`[fb-quick-post-test] job ${jobId} FAILED: ${e.message}`);
      setJobError(jobId, e.message);
    } finally {
      cleanupFiles(imagePaths);
    }
  })();
});

// Lay screenshot moi nhat
app.get('/api/screenshot', (req, res) => {
  const screenshotPath = path.resolve(__dirname, '../logs/latest-post.png');
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).json({ error: 'Không có screenshot' });
  }
});

// === Session Check API ===
const sessionCheck = require('./src/utils/session-check');

const loginHistory = require('./src/utils/login-history');

// Thêm tài khoản mới + mở trình duyệt để login thủ công
app.post('/api/accounts', async (req, res) => {
  const { type, key, name, email, password, saleworkName, proxy } = req.body;

  if (!key || !name) {
    return res.status(400).json({ error: 'Thiếu tên profile hoặc tên hiển thị' });
  }

  // Neu dang chay o che do proxy (remote server), forward sang local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ type, key, name, email, password, saleworkName, proxy }),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  if (type === 'facebook') {
    // Tạo thư mục profile mới
    const profileDir = path.resolve(__dirname, `../playwright-data/${key}`);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // Mo trinh duyet de login thu cong
    try {
      const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
      const { parseProxy } = require('./src/utils/proxy');
      const proxyOpt = parseProxy(proxy);
      if (proxyOpt) logger.info(`FB "${name}" dùng proxy: ${proxyOpt.server}`);
      const browser = await safeLaunchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1280, height: 720 },
        ...(proxyOpt ? { proxy: proxyOpt } : {}),
      });

      const page = browser.pages()[0] || await browser.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Nếu có email/pass thì điền sẵn
      if (email && password) {
        try {
          const emailInput = await page.$('input[name="email"]');
          if (emailInput) {
            await emailInput.fill(email);
            await page.fill('input[name="pass"]', password);
          }
        } catch {}
      }

      loginHistory.addEntry(key, name, 'login', 'Mở trình duyệt đăng nhập thủ công');

      res.json({
        success: true,
        message: `Đã mở Chromium cho profile "${name}". Hãy đăng nhập thủ công trên trình duyệt, sau đó đóng trình duyệt lại.`,
      });

      // Đợi trình duyệt đóng (user đóng thủ công)
      browser.on('close', () => {
        loginHistory.addEntry(key, name, 'login', 'Đã đóng trình duyệt - session được lưu');
        logger.info(`Profile ${name}: đã đóng trình duyệt, session lưu tại ${profileDir}`);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(400).json({ error: 'Loại tài khoản không hợp lệ' });
  }
});

// Re-login profile FB có sẵn — mở lại Chromium cho profile đã tồn tại
app.post('/api/accounts/:key/login', async (req, res) => {
  const { key } = req.params;

  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts/${encodeURIComponent(key)}/login`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  return res.status(503).json({ error: 'Chưa cấu hình PLAYWRIGHT_LOCAL_URL — không có máy nào để mở Chromium.' });
});

// Test proxy IP cho 1 profile — async job pattern.
// POST → trả jobId ngay; UI poll GET /api/test-proxy/job/:jobId.
// Tránh tunnel/reverse-proxy timeout khi Chromium launch lâu.
async function safeJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`HTTP ${response.status}: response không phải JSON (có thể tunnel timeout / lỗi gateway). ${snippet}`);
  }
}

const localTestProxyJobs = new Map(); // local mode (no tunnel) — chạy in-process
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of localTestProxyJobs) {
    if (now - job.createdAt > 600_000) localTestProxyJobs.delete(id);
  }
}, 600_000);

app.post('/api/accounts/:key/test-proxy', async (req, res) => {
  const { key } = req.params;

  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts/${encodeURIComponent(key)}/test-proxy`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      const data = await safeJsonResponse(response);
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  // Local mode (no tunnel): vẫn chạy async job để UI dùng cùng flow
  const jobId = crypto.randomBytes(8).toString('hex');
  localTestProxyJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  res.json({ jobId, status: 'pending' });

  (async () => {
    try {
      const { runProxyTest } = require('./src/utils/test-proxy');
      const result = await runProxyTest(key, { headless: true });
      localTestProxyJobs.set(jobId, { status: 'done', result, createdAt: Date.now() });
    } catch (e) {
      localTestProxyJobs.set(jobId, {
        status: 'done',
        result: { ok: false, profileKey: key, error: e.message, reason: 'exception' },
        createdAt: Date.now(),
      });
    }
  })();
});

app.get('/api/test-proxy/job/:jobId', async (req, res) => {
  const { jobId } = req.params;

  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/test-proxy/job/${encodeURIComponent(jobId)}`, {
        headers: { 'x-api-key': API_KEY },
      });
      const data = await safeJsonResponse(response);
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  const job = localTestProxyJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại hoặc đã hết hạn' });
  res.json(job);
});

// Xoa profile
app.delete('/api/accounts/:type/:key', async (req, res) => {
  const { type, key } = req.params;

  // Nếu đang chạy ở chế độ proxy, forward sang local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts/${type}/${key}`, {
        method: 'DELETE',
        headers: { 'x-api-key': API_KEY },
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  try {
    if (type === 'facebook') {
      const profileDir = path.resolve(__dirname, `../playwright-data/${key}`);
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
        logger.info(`Da xoa profile dir: ${profileDir}`);
      }
    } else if (type === 'zalo') {
      // Zalo accounts stored in config, not in playwright-data (salework dir is shared)
      // Nothing to delete on the remote server side — local server handles config
    } else {
      return res.status(400).json({ error: 'Loại không hợp lệ' });
    }

    loginHistory.addEntry(key, key, 'delete', `Đã xoá tài khoản`);
    res.json({ success: true, message: `Đã xoá tài khoản "${key}"` });
  } catch (e) {
    logger.error(`Lỗi xoá profile: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Lấy danh sách profiles từ thư mục playwright-data
app.get('/api/accounts', async (req, res) => {
  // ?all=1 chỉ admin Xeko gọi (dùng trong tab Phân quyền để tick chọn profile)
  const wantAll = req.query.all === '1' && req.user && req.user.isXekoAdmin;

  // Nếu đang chạy ở chế độ proxy, lấy từ local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts`, {
        headers: { 'x-api-key': API_KEY },
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!wantAll && req.user) {
        if (Array.isArray(data.facebook)) data.facebook = permissions.filterProfiles(req.user.email, data.facebook);
        // Zalo accounts have different keys from FB profiles — never filter them by FB profile keys
      }
      return res.json(data);
    } catch (e) {
      return res.status(504).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  const dataDir = path.resolve(__dirname, '../playwright-data');
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing',
  ];
  try {
    const entries = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir, { withFileTypes: true })
      : [];
    let fbProfiles = entries
      .filter(e => e.isDirectory()
        && !knownNonProfiles.includes(e.name)
        && !e.name.startsWith('.')
        && !e.name.startsWith('salework')
        && !e.name.includes('.'))
      .map(e => {
        const key = e.name;
        const meta = loadProfilesMeta()[key];
        return {
          key,
          name: meta?.name || key,
          email: meta?.email || '',
          proxy: meta?.proxy || '',
        };
      });

    if (!wantAll && req.user) {
      fbProfiles = permissions.filterProfiles(req.user.email, fbProfiles);
    }

    res.json({ facebook: fbProfiles, zalo: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lưu thông tin profile động vào file JSON (persistent volume)
const PROFILES_META_FILE = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/profiles-meta.json')
  : path.resolve(__dirname, '../data/profiles-meta.json');
function loadProfilesMeta() {
  try {
    if (fs.existsSync(PROFILES_META_FILE)) return JSON.parse(fs.readFileSync(PROFILES_META_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveProfilesMeta(data) {
  const dir = path.dirname(PROFILES_META_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROFILES_META_FILE, JSON.stringify(data, null, 2));
  scheduleDataCommit('chore: auto-save profiles-meta');
}

// Cập nhật thông tin profile
app.put('/api/accounts/:key', async (req, res) => {
  const { key } = req.params;
  const { name, email, password, type, saleworkName, proxy } = req.body;

  if (!name) return res.status(400).json({ error: 'Thiếu tên hiển thị' });

  // Proxy sang local server để đồng bộ với GET /api/accounts
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ name, email, password, type, saleworkName, proxy }),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  try {
    if (type === 'zalo') {
      return res.status(400).json({ error: 'Zalo accounts managed by local server' });
    }
    const meta = loadProfilesMeta();
    const proxyTrimmed = typeof proxy === 'string' ? proxy.trim() : undefined;
    meta[key] = {
      name,
      email: email || '',
      password: password || (meta[key] && meta[key].password) || '',
      proxy: proxyTrimmed !== undefined ? proxyTrimmed : ((meta[key] && meta[key].proxy) || ''),
    };
    saveProfilesMeta(meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Proxy List API =====
// Danh sách proxy lưu trong data/proxies.json (persistent volume) — không dùng localStorage.
const PROXY_LIST_FILE = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/proxies.json')
  : path.resolve(__dirname, '../data/proxies.json');

function loadProxyList() {
  try {
    if (fs.existsSync(PROXY_LIST_FILE)) return JSON.parse(fs.readFileSync(PROXY_LIST_FILE, 'utf8'));
  } catch {}
  return [];
}
function saveProxyList(list) {
  const dir = path.dirname(PROXY_LIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROXY_LIST_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/proxies', (req, res) => {
  res.json(loadProxyList());
});

app.post('/api/proxies', (req, res) => {
  const { label, host, port, user, pass, purchaseDate, expirationDate } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Thiếu host hoặc port' });
  const list = loadProxyList();
  const id = 'px_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const proxy = { id, label: label || '', host, port, user: user || '', pass: pass || '', purchaseDate: purchaseDate || '', expirationDate: expirationDate || '' };
  list.push(proxy);
  saveProxyList(list);
  pushProxyListToLocal(list).catch(() => {});
  res.status(201).json(proxy);
});

app.put('/api/proxies/:id', (req, res) => {
  const { id } = req.params;
  const { label, host, port, user, pass, purchaseDate, expirationDate } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Thiếu host hoặc port' });
  const list = loadProxyList();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Không tìm thấy proxy' });
  list[idx] = { ...list[idx], label: label || '', host, port, user: user || '', pass: pass || '', purchaseDate: purchaseDate || '', expirationDate: expirationDate || '' };
  saveProxyList(list);
  pushProxyListToLocal(list).catch(() => {});
  res.json(list[idx]);
});

app.delete('/api/proxies/:id', (req, res) => {
  const { id } = req.params;
  const list = loadProxyList();
  const filtered = list.filter(p => p.id !== id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'Không tìm thấy proxy' });
  saveProxyList(filtered);
  pushProxyListToLocal(filtered).catch(() => {});
  res.json({ success: true });
});

app.get('/api/login-history', (req, res) => {
  const profile = req.query.profile || null;
  const limit = parseInt(req.query.limit) || 50;
  res.json(loginHistory.getHistory(profile, limit));
});

// Tail N dòng cuối của logs/app.log — admin only.
// Đọc theo block từ cuối file để tránh load full file 5MB vào RAM mỗi lần refresh.
app.get('/api/logs/tail', (req, res) => {
  if (!req.user || !permissions.isXekoAdmin(req.user.email)) {
    return res.status(403).json({ error: 'Chỉ admin xem được logs' });
  }
  const lines = Math.min(parseInt(req.query.lines) || 200, 2000);
  const q = (req.query.q || '').toString();
  const logPath = path.resolve(__dirname, 'logs/app.log');
  if (!fs.existsSync(logPath)) return res.json({ lines: [], path: logPath });

  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
    const blockSize = 64 * 1024;
    let buf = '';
    let pos = stat.size;
    let collected = 0;
    while (pos > 0 && collected <= lines) {
      const readSize = Math.min(blockSize, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buf = chunk.toString('utf8') + buf;
      collected = (buf.match(/\n/g) || []).length;
    }
    fs.closeSync(fd);

    let arr = buf.split('\n').filter(Boolean);
    if (q) {
      const needle = q.toLowerCase();
      arr = arr.filter(l => l.toLowerCase().includes(needle));
    }
    arr = arr.slice(-lines);
    res.json({ lines: arr, total: arr.length, size: stat.size, mtime: stat.mtime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  // Session check cần Playwright - proxy sang local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/sessions`, {
        headers: { 'x-api-key': API_KEY },
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  try {
    const results = await sessionCheck.checkAllSessions();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Scheduler API ===
const scheduler = require('./src/utils/scheduler');

// Lên lịch đăng bài
app.post('/api/schedule', upload.array('images', 20), (req, res) => {
  const { time, target, groupId, message, profile, profileDisplayName, type, groupName, zaloAccount, groupKeywords } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!profile) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile' });
  }

  try {
    const job = scheduler.addSchedule({ time, target, groupId, message, imagePaths, profile, profileDisplayName, type, groupName, zaloAccount, groupKeywords });
    res.json({
      success: true,
      message: `Đã lên lịch đăng bài lúc ${job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
      id: job.id,
    });
  } catch (e) {
    cleanupFiles(imagePaths);
    res.status(400).json({ error: e.message });
  }
});

// Xem danh sách lịch
app.get('/api/schedules', (req, res) => {
  res.json(scheduler.getSchedules());
});

// Xoá lịch
app.delete('/api/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (scheduler.removeSchedule(id)) {
    res.json({ success: true, message: `Đã xoá lịch #${id}` });
  } else {
    res.status(404).json({ error: 'Không tìm thấy lịch' });
  }
});

// Polling notifications (lịch đã chạy xong)
app.get('/api/notifications', (req, res) => {
  res.json(scheduler.getNotifications());
});

// Serve ảnh từ temp/schedule folders
app.get('/api/schedule-image/:id/:index', (req, res) => {
  const schedules = scheduler.getSchedules();
  const schedule = schedules.find(s => s.id === parseInt(req.params.id));
  if (!schedule) return res.status(404).json({ error: 'Không tìm thấy' });

  const index = parseInt(req.params.index);
  if (!schedule.imagePaths || !schedule.imagePaths[index]) {
    return res.status(404).json({ error: 'Không có ảnh' });
  }

  const imgPath = schedule.imagePaths[index];
  if (fs.existsSync(imgPath)) {
    res.sendFile(path.resolve(imgPath));
  } else {
    res.status(404).json({ error: 'File không tồn tại' });
  }
});

// === Post History & Statistics API ===
app.get('/api/post-history', (req, res) => {
  const { profile, platform, target, groupId, success, from, to, limit, offset } = req.query;
  try {
    const result = postLogger.getPostHistory({
      profile, platform, target, groupId: groupId || undefined,
      success: success !== undefined && success !== '' ? success : undefined,
      from, to,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json({ ...result, pending: postLogger.getPendingPosts() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/post-history/bulk', (req, res) => {
  try {
    const raw = (req.query.ids || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (raw.length === 0) return res.status(400).json({ error: 'Không có ID nào hợp lệ' });
    const result = postLogger.deleteByIds(raw);
    res.json({ deleted: result.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/post-history/:id', (req, res) => {
  try {
    const result = postLogger.deleteById(Number(req.params.id));
    res.json({ deleted: result.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Frontend gọi khi pollZaloJob timeout để mark pending row là failed
app.post('/api/pending/:id/timeout', (req, res) => {
  try {
    const result = postLogger.completePendingPost(Number(req.params.id), {
      success: false,
      error: 'Timeout - không xác nhận được kết quả',
    });
    res.json({ updated: result?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/post-history', (req, res) => {
  const { profile, success, from, to } = req.query;
  try {
    const result = postLogger.deleteByFilter({
      profile,
      success: success !== undefined && success !== '' ? success : undefined,
      from, to,
    });
    res.json({ deleted: result.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/statistics', (req, res) => {
  const { from, to } = req.query;
  try {
    const stats = postLogger.getStatistics({ from, to });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/statistics/by-profile', (req, res) => {
  const { profile, platform, target, groupId, from, to } = req.query;
  try {
    const rows = postLogger.getByProfileStats({ profile, platform, target, groupId, from, to });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/statistics/daily-by-profile', (req, res) => {
  try {
    const { from, to } = req.query;
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const rows = postLogger.getDailyByProfile({ days, from, to });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== CHANNELS (stored on remote server — no local server dependency) =====
const CHANNELS_FILE = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/channels.json')
  : path.resolve(__dirname, '../data/channels.json');

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  } catch {}
  return { fbGroups: [], fbPages: [], zaloGroups: [], profileChannels: {} };
}

function saveChannels(data) {
  const dir = path.dirname(CHANNELS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
  scheduleDataCommit('chore: auto-save channels');
  pushChannelsToLocal(data).catch(() => {});
}

async function pushChannelsToLocal(data) {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return;
  try {
    const fetchFn = await getFetch();
    await fetchFn(`${LOCAL_URL}/api/channels/bulk`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
      body: JSON.stringify(data),
    });
    logger.info('channels pushed to local');
  } catch (e) {
    logger.info(`pushChannelsToLocal: ${e.message}`);
  }
}

app.get('/api/channels', (req, res) => {
  res.json(loadChannels());
});

app.post('/api/channels/fb-groups', (req, res) => {
  const { key, id, name, category } = req.body;
  if (!key || !id || !name) return res.status(400).json({ error: 'Thiếu key, id hoặc name' });
  const data = loadChannels();
  if (data.fbGroups.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.fbGroups.push({ key, id, name, category: (category || '').trim() });
  saveChannels(data);
  res.json({ success: true });
});

app.patch('/api/channels/fb-groups/:key', (req, res) => {
  const data = loadChannels();
  const group = (data.fbGroups || []).find(g => g.key === req.params.key);
  if (!group) return res.status(404).json({ error: 'Không tìm thấy group' });
  if (typeof req.body.category === 'string') group.category = req.body.category.trim();
  if (typeof req.body.name === 'string' && req.body.name.trim()) group.name = req.body.name.trim();
  if (typeof req.body.id === 'string' && req.body.id.trim()) group.id = req.body.id.trim();
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/fb-groups/:key', (req, res) => {
  const data = loadChannels();
  data.fbGroups = data.fbGroups.filter(g => g.key !== req.params.key);
  saveChannels(data);
  res.json({ success: true });
});

app.post('/api/channels/fb-pages', (req, res) => {
  const { key, id, name, category } = req.body;
  if (!key || !id || !name) return res.status(400).json({ error: 'Thiếu key, id hoặc name' });
  const data = loadChannels();
  if (!data.fbPages) data.fbPages = [];
  if (data.fbPages.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.fbPages.push({ key, id, name, category: (category || '').trim() });
  saveChannels(data);
  res.json({ success: true });
});

app.patch('/api/channels/fb-pages/:key', (req, res) => {
  const data = loadChannels();
  if (!data.fbPages) data.fbPages = [];
  const pg = data.fbPages.find(g => g.key === req.params.key);
  if (!pg) return res.status(404).json({ error: 'Không tìm thấy page' });
  if (typeof req.body.category === 'string') pg.category = req.body.category.trim();
  if (typeof req.body.name === 'string' && req.body.name.trim()) pg.name = req.body.name.trim();
  if (typeof req.body.id === 'string' && req.body.id.trim()) pg.id = req.body.id.trim();
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/fb-pages/:key', (req, res) => {
  const data = loadChannels();
  if (!data.fbPages) data.fbPages = [];
  data.fbPages = data.fbPages.filter(g => g.key !== req.params.key);
  saveChannels(data);
  res.json({ success: true });
});

app.post('/api/channels/zalo-groups', (req, res) => {
  const { key, oid, name, category } = req.body;
  if (!key || !oid || !name) return res.status(400).json({ error: 'Thiếu key, oid hoặc name' });
  const data = loadChannels();
  if (!data.zaloGroups) data.zaloGroups = [];
  if (data.zaloGroups.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.zaloGroups.push({ key, oid, name, category: (category || '').trim() });
  saveChannels(data);
  res.json({ success: true });
});

app.patch('/api/channels/zalo-groups/:key', (req, res) => {
  const data = loadChannels();
  const group = (data.zaloGroups || []).find(g => g.key === req.params.key);
  if (!group) return res.status(404).json({ error: 'Không tìm thấy group' });
  if (typeof req.body.category === 'string') group.category = req.body.category.trim();
  if (typeof req.body.name === 'string' && req.body.name.trim()) group.name = req.body.name.trim();
  if (typeof req.body.oid === 'string' && req.body.oid.trim()) group.oid = req.body.oid.trim();
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/zalo-groups/:key', (req, res) => {
  const data = loadChannels();
  data.zaloGroups = (data.zaloGroups || []).filter(g => g.key !== req.params.key);
  saveChannels(data);
  res.json({ success: true });
});

app.put('/api/channels/profile-channels', (req, res) => {
  const { profileChannels } = req.body;
  if (!profileChannels) return res.status(400).json({ error: 'Thiếu profileChannels' });
  const data = loadChannels();
  data.profileChannels = profileChannels;
  saveChannels(data);
  res.json({ success: true });
});

// ===== RESTART LOCAL SERVER =====
async function proxyToLocal(req, res, method, path, body = null) {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });
  try {
    const fetchFn = await getFetch();
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
    };
    if (body) opts.body = JSON.stringify(body);
    const response = await fetchFn(`${LOCAL_URL}${path}`, opts);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({ error: `Local server trả về response không hợp lệ (HTTP ${response.status})` });
    }
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
  }
}

app.post('/api/restart', (req, res) => proxyToLocal(req, res, 'POST', '/api/restart'));

// ===== KHO CONTENT =====
const contentStore = require('./src/database/content-store');

app.get('/api/contents', (req, res) => {
  const { search = '', platform = '' } = req.query;
  res.json(contentStore.list({ search, platform }));
});

app.post('/api/contents', upload.array('images', 20), async (req, res) => {
  const { title, body, tags, platform, category, profiles } = req.body;
  if (!body) return res.status(400).json({ error: 'Thiếu nội dung bài viết' });
  const imagePaths = (req.files || []).map(f => f.path);
  const newUrls = imagePaths.length ? await persistImages(imagePaths) : [];
  const tagsArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const profilesArr = profiles ? (Array.isArray(profiles) ? profiles : [profiles]).filter(Boolean) : [];
  const item = contentStore.create({
    title: title.trim(), body, tags: tagsArr, platform: platform || 'all',
    images: newUrls, category: (category || '').trim(), profiles: profilesArr,
  });
  res.json(item);
});

app.put('/api/contents/:id', upload.array('images', 20), async (req, res) => {
  const id = Number(req.params.id);
  const { title, body, tags, platform, category, profiles } = req.body;
  if (!body) return res.status(400).json({ error: 'Thiếu nội dung bài viết' });
  const existing = contentStore.getById(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy content' });
  const imagePaths = (req.files || []).map(f => f.path);
  const newUrls = imagePaths.length ? await persistImages(imagePaths) : [];
  const keepUrls = req.body.keepUrl
    ? (Array.isArray(req.body.keepUrl) ? req.body.keepUrl : [req.body.keepUrl])
    : [];
  const images = [...keepUrls, ...newUrls];
  const tagsArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const profilesArr = profiles ? (Array.isArray(profiles) ? profiles : [profiles]).filter(Boolean) : [];
  const item = contentStore.update(id, {
    title: title.trim(), body, tags: tagsArr, platform, images,
    category: (category || '').trim(), profiles: profilesArr,
  });
  res.json(item);
});

app.delete('/api/contents/:id', (req, res) => {
  const id = Number(req.params.id);
  const ok = contentStore.remove(id);
  if (!ok) return res.status(404).json({ error: 'Không tìm thấy content' });
  res.json({ success: true });
});

// ===== AI CONTENT SUGGEST =====
const settingsStore = require('./src/database/settings-store');
const { suggestContent } = require('./src/ai/gemini');

function localUrlToPath(url) {
  // /api/image/YYYY-MM-DD/filename → UPLOADS_DIR/YYYY-MM-DD/filename
  const m = url.match(/^\/api\/image\/([^/]+)\/([^/]+)$/);
  if (m) return path.join(UPLOADS_DIR, m[1], m[2]);
  return null;
}

function getExamplesStore() {
  return JSON.parse(settingsStore.get('ai_guide_examples_v2', '{}'));
}
function setExamplesStore(obj) {
  settingsStore.set('ai_guide_examples_v2', JSON.stringify(obj));
}

app.get('/api/ai/guide', (req, res) => {
  const guides = JSON.parse(settingsStore.get('ai_content_guides', 'null'))
    || { '': settingsStore.get('ai_content_guide', '') };
  const examplesByCategory = getExamplesStore();
  res.json({ guides, examplesByCategory });
});

app.put('/api/ai/guide', express.json(), (req, res) => {
  const { guides } = req.body;
  if (!guides || typeof guides !== 'object') return res.status(400).json({ error: 'guides phải là object' });
  settingsStore.set('ai_content_guides', JSON.stringify(guides));
  res.json({ success: true });
});

app.post('/api/ai/guide/examples', upload.array('images', 10), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'Cần ít nhất 1 ảnh' });
  const category = req.body.category || '';
  try {
    const urls = await persistImages(files.map(f => f.path));
    const store = getExamplesStore();
    store[category] = [...(store[category] || []), ...urls.map(imageUrl => ({ imageUrl }))];
    setExamplesStore(store);
    res.json({ examples: store[category], category });
  } catch (err) {
    logger.error('AI guide examples upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    for (const f of files) fs.unlink(f.path, () => {});
  }
});

app.delete('/api/ai/guide/examples/:category/:index', (req, res) => {
  const category = req.params.category === '_' ? '' : req.params.category;
  const idx = Number(req.params.index);
  const store = getExamplesStore();
  const list = store[category] || [];
  if (idx < 0 || idx >= list.length) return res.status(404).json({ error: 'Không tìm thấy' });
  list.splice(idx, 1);
  store[category] = list;
  setExamplesStore(store);
  res.json({ examples: list, category });
});

app.post('/api/ai/suggest', upload.array('images', 5), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'Cần ít nhất 1 ảnh' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Tính năng AI chưa được cấu hình (thiếu GEMINI_API_KEY)' });
  try {
    const style = req.body.style || 'short';
    const category = req.body.category || '';
    const productName = (req.body.productName || '').trim();
    const guides = JSON.parse(settingsStore.get('ai_content_guides', 'null')) || {};
    const guide = guides[`${style}|${category}`]
      || guides[`${style}|`]
      || guides[`short|${category}`]
      || guides[`short|`]
      || settingsStore.get('ai_content_guide', '');
    const store = getExamplesStore();
    const examples = store[category]?.length ? store[category] : (store[''] || []);
    const examplePaths = examples
      .map(e => localUrlToPath(e.imageUrl))
      .filter(p => p && require('fs').existsSync(p));
    const imagePaths = files.map(f => f.path);
    const suggestions = await suggestContent(imagePaths, guide, examplePaths, style, category, productName);
    res.json({ suggestions });
  } catch (err) {
    logger.error('AI suggest error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    for (const f of files) {
      fs.unlink(f.path, () => {});
    }
  }
});

// ===== ZALO POST =====
// Metadata lưu tạm khi job Zalo đang xử lý (processing: true) để ghi log khi done
const _pendingZaloLogs = new Map(); // jobId → metadata
// Cache kết quả done để trả lại nếu poll lại sau khi local đã xóa job
const _zaloJobDoneCache = new Map(); // jobId → {status, success, error, ts}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h TTL
  for (const [id, m] of _pendingZaloLogs) {
    if (m.ts < cutoff) _pendingZaloLogs.delete(id);
  }
  for (const [id, m] of _zaloJobDoneCache) {
    if (m.ts < cutoff) _zaloJobDoneCache.delete(id);
  }
}, 60 * 60 * 1000);

app.post('/api/zalo/post', upload.array('images', 20), async (req, res) => {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });

  const imagePaths = (req.files || []).map(f => f.path);
  // Persist ảnh trước khi proxy — đảm bảo files còn tồn tại (ReadStream chưa consume)
  const zaloImageUrls = await persistImages(imagePaths);
  try {
    const fetchFn = await getFetch();
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    const { profile, zaloAccountName, groupName, message, batchId } = req.body;
    const accountName = zaloAccountName || profile;
    if (accountName) form.append('zaloAccountName', accountName);
    if (groupName) form.append('groupName', groupName);
    if (message) form.append('message', message);
    for (const p of imagePaths) {
      form.append('images', fs.createReadStream(p), {
        filename: path.basename(p),
        contentType: 'image/jpeg',
      });
    }

    // Buffer toàn bộ multipart để có Content-Length chính xác — Cloudflare Tunnel
    // truncates chunked streams without Content-Length.
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      const sink = new PassThrough();
      sink.on('data', c => chunks.push(c));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      form.on('error', reject);
      form.pipe(sink);
    });

    const response = await fetchFn(`${LOCAL_URL}/api/zalo/post`, {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Content-Length': String(body.length),
        'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key',
      },
      body,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: `Local trả non-JSON (${response.status}): ${text.slice(0, 200)}` }; }

    // Pre-insert pending DB row để dashboard có source of truth ngay từ đầu
    // (giống FB flow — completePendingPost sẽ update khi job xong)
    let zaloPendingLogId = null;
    if (data.processing && data.jobId) {
      try {
        zaloPendingLogId = postLogger.insertPendingPost({
          profile: accountName || 'zalo',
          profileName: accountName || 'Zalo',
          platform: 'zalo',
          target: 'group',
          groupName: groupName || '',
          message: message || '',
          imageCount: imagePaths.length,
          source: 'web',
          images: zaloImageUrls,
          batchId: batchId || null,
          jobId: data.jobId,
        });
      } catch (e) {
        logger.error(`[zalo/post] insertPendingPost error: ${e.message}`);
      }
      _pendingZaloLogs.set(data.jobId, {
        profile: accountName || 'zalo',
        profileName: accountName || 'Zalo',
        groupName: groupName || '',
        message: message || '',
        imageCount: imagePaths.length,
        images: zaloImageUrls,
        batchId: batchId || null,
        pendingLogId: zaloPendingLogId,
        ts: Date.now(),
      });
    } else {
      // Kết quả đồng bộ (hiếm) — ghi log ngay
      postLogger.logPost({
        profile: accountName || 'zalo',
        profileName: accountName || 'Zalo',
        platform: 'zalo',
        target: 'group',
        groupName: groupName || '',
        message: message || '',
        imageCount: imagePaths.length,
        success: !!data.success,
        error: data.error || null,
        postUrl: data.postUrl || null,
        source: 'web',
        images: zaloImageUrls,
        batchId: batchId || null,
      });
    }

    // Trả pendingLogId về frontend để tracking giống FB
    const responseData = zaloPendingLogId ? { ...data, pendingLogId: zaloPendingLogId } : data;
    return res.status(response.status).json(responseData);
  } catch (e) {
    return res.status(500).json({ error: `Lỗi proxy Zalo post: ${e.message}` });
  } finally {
    cleanupFiles(imagePaths);
  }
});

app.get('/api/zalo/status/:jobId', async (req, res) => {
  const jobId = req.params.jobId;

  // Trả ngay từ cache nếu job đã done (local có thể đã xóa job khỏi memory)
  const cached = _zaloJobDoneCache.get(jobId);
  if (cached) return res.json(cached);

  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });
  try {
    const fetchFn = await getFetch();
    const response = await fetchFn(`${LOCAL_URL}/api/zalo/status/${jobId}`, {
      headers: { 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
    });

    // Nếu local trả 404 (job đã bị xóa) nhưng job vẫn đang pending → trả processing
    // Ngoại trừ: nếu pending row trong DB đã được complete (success != -1), job đã xong
    if (response.status === 404 && _pendingZaloLogs.has(jobId)) {
      const meta = _pendingZaloLogs.get(jobId);
      if (meta && meta.pendingLogId) {
        try {
          const rows = postLogger.getPendingPosts();
          const stillPending = rows.some(r => r.id === meta.pendingLogId);
          if (!stillPending) {
            // DB row đã complete → job đã xong, xóa khỏi map, trả done từ cache hoặc unknown
            _pendingZaloLogs.delete(jobId);
            const cached = _zaloJobDoneCache.get(jobId);
            if (cached) return res.json(cached);
            // Không có cache → unknown, báo done/failed dựa theo DB
            return res.json({ status: 'done', success: false, error: 'Job completed (status unknown after local restart)' });
          }
        } catch {}
      }
      return res.json({ status: 'processing' });
    }

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }

    // Khi job xong: cache kết quả trước, complete pending row sau
    if (data && data.status === 'done') {
      _zaloJobDoneCache.set(jobId, { status: 'done', success: !!data.success, error: data.error || null, ts: Date.now() });
      const meta = _pendingZaloLogs.get(jobId);
      const donePayload = { success: !!data.success, error: data.error || null, postUrl: null };
      if (meta) {
        _pendingZaloLogs.delete(jobId);
        try {
          if (meta.pendingLogId) {
            // Có pending row → update thay vì insert mới (giống FB flow)
            const r = postLogger.completePendingPost(meta.pendingLogId, donePayload);
            if (r.changes === 0) {
              // Row đã bị markTimedOut hoặc pendingLogId sai → thử bằng job_id
              logger.warn(`[zalo/status] completePendingPost id=${meta.pendingLogId} → 0 changes, retry bằng job_id=${jobId}`);
              const r2 = postLogger.completePendingByJobId(jobId, donePayload);
              if (r2.changes === 0) logger.error(`[zalo/status] completePendingByJobId job_id=${jobId} → 0 changes cũng thất bại`);
              else logger.info(`[zalo/status] completePendingByJobId job_id=${jobId} → ${r2.changes} row(s) updated`);
            }
          } else {
            // Thử cập nhật pending row bằng job_id trước (tránh duplicate)
            const r = postLogger.completePendingByJobId(jobId, donePayload);
            if (r.changes > 0) {
              logger.info(`[zalo/status] completePendingByJobId (no pendingLogId) job_id=${jobId} → ${r.changes} row(s)`);
            } else {
              // Không có pending row → insert mới
              postLogger.logPost({
                profile: meta.profile,
                profileName: meta.profileName,
                platform: 'zalo',
                target: 'group',
                groupName: meta.groupName,
                message: meta.message,
                imageCount: meta.imageCount,
                success: !!data.success,
                error: data.error || null,
                postUrl: null,
                source: 'web',
                images: meta.images,
                batchId: meta.batchId,
              });
            }
          }
        } catch (logErr) {
          logger.error(`[zalo/status] complete/logPost error: ${logErr.message}`);
        }
      } else {
        // Server restart cleared _pendingZaloLogs → dùng job_id trực tiếp
        try {
          const r = postLogger.completePendingByJobId(jobId, donePayload);
          if (r.changes === 0) logger.warn(`[zalo/status] completePendingByJobId (restart) job_id=${jobId} → 0 changes`);
          else logger.info(`[zalo/status] completePendingByJobId (restart) job_id=${jobId} → ${r.changes} row(s)`);
        } catch (logErr) {
          logger.error(`[zalo/status] completePendingPost-by-jobId error: ${logErr.message}`);
        }
      }
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== Auth & Permissions API =====

// Lấy thông tin user đang login (từ basso.vn) + quyền hạn trong Xeko.
// Public endpoint — dùng để frontend biết redirect login hay không.
app.get('/api/me', async (req, res) => {
  const cookie = req.headers.cookie || '';
  const user = await auth.verifyBassoSession(cookie);
  if (!user) {
    return res.status(401).json({ success: false, code: 'NOT_LOGGED_IN' });
  }
  if (!permissions.hasAccess(user.email)) {
    return res.status(403).json({
      success: false,
      code: 'NO_XEKO_ACCESS',
      email: user.email,
      message: 'Tài khoản chưa được phân quyền sử dụng Xeko',
    });
  }
  const info = permissions.getUser(user.email);
  res.json({
    success: true,
    email: user.email,
    name: (info && info.name) || '',
    roles: user.roles,
    isXekoAdmin: permissions.isXekoAdmin(user.email),
    isSuperAdmin: permissions.isSuperAdmin(user.email),
    allProfiles: permissions.getAllowedProfileKeys(user.email) === null,
    allowedProfiles: permissions.getAllowedProfileKeys(user.email),
  });
});

// Danh sách user (admin Xeko)
app.get('/api/admin/users', auth.requireAdmin(), (req, res) => {
  res.json({ users: permissions.listUsers(), superAdmin: permissions.SUPER_ADMIN_EMAIL });
});

// Tạo / cập nhật user (admin Xeko)
app.post('/api/admin/users', auth.requireAdmin(), (req, res) => {
  try {
    const { email, name, isXekoAdmin: admin, allProfiles, profiles, note } = req.body || {};
    const u = permissions.upsertUser({ email, name, isXekoAdmin: admin, allProfiles, profiles, note });
    res.json({ success: true, user: u });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Xoá user (admin Xeko)
app.delete('/api/admin/users/:email', auth.requireAdmin(), (req, res) => {
  try {
    const ok = permissions.deleteUser(req.params.email);
    if (!ok) return res.status(404).json({ error: 'Không tìm thấy user' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Force-sync permissions từ local server (dùng khi remote mất data sau deploy)
app.post('/api/admin/sync-permissions', auth.requireAdmin(), async (req, res) => {
  try {
    const restored = await permissions.restoreFromLocal();
    if (restored) {
      const data = permissions.load();
      return res.json({ success: true, restored: true, count: Object.keys(data.users).length });
    }
    return res.status(503).json({ error: 'Local server chưa kết nối hoặc chưa có file permissions. Hãy chạy local server trước.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kéo channels từ local server về remote (dùng khi remote mất data sau deploy)
async function syncChannelsFromLocal() {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return false;
  try {
    const fetchFn = await getFetch();
    const res = await fetchFn(`${LOCAL_URL}/api/channels`, {
      headers: { 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
    });
    if (!res.ok) return false;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    if (!data || typeof data !== 'object') return false;
    // Chỉ sync nếu local có data thực (tránh ghi đè remote bằng object rỗng)
    const hasData = (data.fbGroups?.length > 0) || (data.fbPages?.length > 0) || (data.zaloGroups?.length > 0);
    if (!hasData) return false;
    saveChannels(data);
    logger.info(`channels synced from LOCAL (fbGroups=${data.fbGroups?.length || 0}, fbPages=${data.fbPages?.length || 0}, zalo=${data.zaloGroups?.length || 0})`);
    return true;
  } catch (e) {
    logger.info(`syncChannelsFromLocal: ${e.message}`);
    return false;
  }
}

async function syncProxiesFromLocal() {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return false;
  try {
    const fetchFn = await getFetch();
    const res = await fetchFn(`${LOCAL_URL}/api/proxies`, {
      headers: { 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
    });
    if (!res.ok) return false;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    if (!Array.isArray(data) || data.length === 0) return false;
    saveProxyList(data);
    logger.info(`proxies synced from LOCAL (count=${data.length})`);
    return true;
  } catch (e) {
    logger.info(`syncProxiesFromLocal: ${e.message}`);
    return false;
  }
}

async function pushProxyListToLocal(list) {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return;
  try {
    const fetchFn = await getFetch();
    await fetchFn(`${LOCAL_URL}/api/proxies/bulk`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
      body: JSON.stringify({ proxies: list }),
    });
  } catch (e) {
    logger.info(`pushProxyListToLocal: ${e.message}`);
  }
}

app.post('/api/proxies/sync-from-local', auth.requireAdmin(), async (req, res) => {
  try {
    const ok = await syncProxiesFromLocal();
    if (ok) return res.json({ success: true, count: loadProxyList().length });
    return res.status(503).json({ error: 'Local server chưa kết nối hoặc chưa có data proxies.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/channels/sync-from-local', auth.requireAdmin(), async (req, res) => {
  try {
    const ok = await syncChannelsFromLocal();
    if (ok) {
      const data = loadChannels();
      return res.json({ success: true, fbGroups: data.fbGroups?.length || 0, fbPages: data.fbPages?.length || 0, zaloGroups: data.zaloGroups?.length || 0 });
    }
    return res.status(503).json({ error: 'Local server chưa kết nối hoặc chưa có data channels. Hãy chạy local server trước.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Local server tự đăng ký URL tunnel mới khi khởi động
let dynamicLocalUrl = process.env.PLAYWRIGHT_LOCAL_URL || null;

const apiKeyHelper = require('./src/utils/api-key');
app.post('/api/register-local', (req, res) => {
  const { url } = req.body;
  if (!apiKeyHelper.verify(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!url) return res.status(400).json({ error: 'Missing url' });
  dynamicLocalUrl = url;
  process.env.PLAYWRIGHT_LOCAL_URL = url; // Cập nhật để playwright-proxy đọc URL mới
  logger.info(`Local server đã đăng ký URL mới: ${url}`);
  res.json({ success: true, message: `Đã cập nhật URL: ${url}` });

  // Sync user-permissions với LOCAL (LOCAL là source of truth).
  permissions.syncOnRegister().catch(e => logger.warn(`syncOnRegister: ${e.message}`));
  // Sync channels từ LOCAL nếu remote chưa có data (chỉ sync khi channels.json trống).
  const existing = loadChannels();
  const remoteEmpty = !existing.fbGroups?.length && !existing.fbPages?.length && !existing.zaloGroups?.length;
  if (remoteEmpty) syncChannelsFromLocal().catch(e => logger.info(`autoSyncChannels: ${e.message}`));
  // Sync proxies từ LOCAL nếu remote chưa có data.
  const remoteProxiesEmpty = !loadProxyList().length;
  if (remoteProxiesEmpty) syncProxiesFromLocal().catch(e => logger.info(`autoSyncProxies: ${e.message}`));
});

// Override PLAYWRIGHT_LOCAL_URL bằng dynamicLocalUrl nếu có
function getLocalUrl() {
  return dynamicLocalUrl || process.env.PLAYWRIGHT_LOCAL_URL;
}

// Wire permissions module với LOCAL endpoint để sync data
permissions.configureSync({
  getLocalUrl,
  apiKey: process.env.LOCAL_API_KEY || 'change-this-secret-key',
});

// ===== KHO BÀI (saved post templates) =====
const SAVED_POSTS_FILE = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/saved-posts.json')
  : path.resolve(__dirname, '../data/saved-posts.json');
const SAVED_POSTS_IMG_DIR = process.env.XEKO_DATA_DIR
  ? path.join(path.resolve(process.env.XEKO_DATA_DIR), 'data/saved-posts-images')
  : path.resolve(__dirname, '../data/saved-posts-images');
if (!fs.existsSync(SAVED_POSTS_IMG_DIR)) fs.mkdirSync(SAVED_POSTS_IMG_DIR, { recursive: true });

function loadSavedPosts() {
  try { if (fs.existsSync(SAVED_POSTS_FILE)) return JSON.parse(fs.readFileSync(SAVED_POSTS_FILE, 'utf8')); } catch {}
  return [];
}
function writeSavedPosts(posts) {
  const dir = path.dirname(SAVED_POSTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SAVED_POSTS_FILE, JSON.stringify(posts, null, 2));
  scheduleDataCommit('chore: auto-save saved-posts');
}

app.get('/api/saved-posts', (req, res) => {
  res.json({ posts: loadSavedPosts() });
});

app.post('/api/saved-posts', upload.array('images', 20), (req, res) => {
  const { message, category, profile, channel } = req.body;
  const id = Date.now();
  const posts = loadSavedPosts();
  const imagePaths = [];
  if (req.files && req.files.length > 0) {
    const dir = path.join(SAVED_POSTS_IMG_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    req.files.forEach((f, i) => {
      const dest = path.join(dir, `${i}${path.extname(f.path) || '.jpg'}`);
      fs.renameSync(f.path, dest);
      imagePaths.push(dest);
    });
  }
  const post = { id, message: message || '', category: category || '', profile: profile || '', channel: channel || '', imagePaths, createdAt: new Date().toISOString() };
  posts.push(post);
  writeSavedPosts(posts);
  res.json({ success: true, post });
});

app.put('/api/saved-posts/:id', upload.array('images', 20), (req, res) => {
  const id = parseInt(req.params.id);
  const posts = loadSavedPosts();
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) {
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(404).json({ error: 'Không tìm thấy' });
  }
  const post = posts[idx];
  const { message, category, profile, channel } = req.body;
  if (message !== undefined) post.message = message;
  if (category !== undefined) post.category = category;
  if (profile !== undefined) post.profile = profile;
  if (channel !== undefined) post.channel = channel;
  if (req.files && req.files.length > 0) {
    (post.imagePaths || []).forEach(p => { try { fs.unlinkSync(p); } catch {} });
    try { fs.rmSync(path.join(SAVED_POSTS_IMG_DIR, String(id)), { recursive: true, force: true }); } catch {}
    const dir = path.join(SAVED_POSTS_IMG_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    post.imagePaths = req.files.map((f, i) => {
      const dest = path.join(dir, `${i}${path.extname(f.path) || '.jpg'}`);
      fs.renameSync(f.path, dest);
      return dest;
    });
  }
  writeSavedPosts(posts);
  res.json({ success: true, post });
});

app.delete('/api/saved-posts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const posts = loadSavedPosts();
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });
  const post = posts[idx];
  (post.imagePaths || []).forEach(p => { try { fs.unlinkSync(p); } catch {} });
  try { fs.rmSync(path.join(SAVED_POSTS_IMG_DIR, String(id)), { recursive: true, force: true }); } catch {}
  posts.splice(idx, 1);
  writeSavedPosts(posts);
  res.json({ success: true });
});

app.post('/api/saved-posts/batch-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids phải là mảng' });
  let posts = loadSavedPosts();
  let deleted = 0;
  for (const rawId of ids) {
    const id = parseInt(rawId);
    const idx = posts.findIndex(p => p.id === id);
    if (idx !== -1) {
      const post = posts[idx];
      (post.imagePaths || []).forEach(p => { try { fs.unlinkSync(p); } catch {} });
      try { fs.rmSync(path.join(SAVED_POSTS_IMG_DIR, String(id)), { recursive: true, force: true }); } catch {}
      posts.splice(idx, 1);
      deleted++;
    }
  }
  writeSavedPosts(posts);
  res.json({ success: true, deleted });
});

app.get('/api/saved-post-image/:id/:index', (req, res) => {
  const id = parseInt(req.params.id);
  const index = parseInt(req.params.index);
  if (isNaN(id) || isNaN(index)) return res.status(400).send('Bad request');
  const post = loadSavedPosts().find(p => p.id === id);
  if (!post || !(post.imagePaths || [])[index]) return res.status(404).send('Not found');
  const filePath = post.imagePaths[index];
  if (!path.resolve(filePath).startsWith(SAVED_POSTS_IMG_DIR)) return res.status(400).send('Bad request');
  if (fs.existsSync(filePath)) return res.sendFile(path.resolve(filePath));
  res.status(404).send('Not found');
});

// ===== SEEDING API =====

app.post('/api/seed', upload.array('images', 10), async (req, res) => {
  const { postLogId, postUrl, profile, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!postUrl) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu postUrl' });
  }
  if (!profile) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu profile' });
  }
  if (!playwright.profileExists(profile)) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: `Profile "${profile}" không tồn tại` });
  }

  const imageUrls = await persistImages(imagePaths);
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  queuePost(async () => {
    try {
      const result = await playwright.postComment({ postUrl, message, imagePaths, profile });
      const profileData = playwright.getActiveProfile();
      seedStore.logSeed({
        postLogId: postLogId ? Number(postLogId) : null,
        postUrl,
        profile,
        profileName: profileData ? profileData.name : profile,
        platform: 'facebook',
        message,
        imageCount: imagePaths.length,
        images: imageUrls,
        success: result.success,
        error: result.error,
      });
      setJobResult(jobId, result);
    } catch (e) {
      seedStore.logSeed({
        postLogId: postLogId ? Number(postLogId) : null,
        postUrl,
        profile,
        profileName: profile,
        platform: 'facebook',
        message,
        imageCount: imagePaths.length,
        images: imageUrls,
        success: false,
        error: e.message,
      });
      setJobError(jobId, e.message);
    } finally {
      cleanupFiles(imagePaths);
    }
  });
});

app.get('/api/seed-logs', (req, res) => {
  const { postLogId, postUrl } = req.query;
  try {
    let rows;
    if (postLogId) rows = seedStore.getSeedLogs(Number(postLogId));
    else if (postUrl) rows = seedStore.getSeedLogsByUrl(postUrl);
    else rows = [];
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint nhẹ cho proxy: chỉ thực thi comment, không log DB, trả jobId
app.post('/api/do-comment', upload.array('images', 10), async (req, res) => {
  const { postUrl, profile, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);
  if (!postUrl) { cleanupFiles(imagePaths); return res.status(400).json({ error: 'Thiếu postUrl' }); }
  if (!profile) { cleanupFiles(imagePaths); return res.status(400).json({ error: 'Thiếu profile' }); }

  const jobId = createJob();
  res.json({ jobId });

  queuePost(async () => {
    try {
      const result = await playwright.postComment({ postUrl, message: message || '', imagePaths, profile });
      setJobResult(jobId, result);
    } catch (e) {
      setJobError(jobId, e.message);
    } finally {
      cleanupFiles(imagePaths);
    }
  });
});

app.delete('/api/seed-logs/:id', (req, res) => {
  try {
    seedStore.deleteSeedLog(Number(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Global error middleware: tra JSON ro rang thay vi plain text "Internal Server"
// (rat huu ich khi multer/playwright/db throw uncaught -> client se thay nguyen nhan that)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Multer errors
  if (err && err.name === 'MulterError') {
    const map = {
      LIMIT_FILE_SIZE: 'Ảnh quá lớn (>25MB/ảnh). Resize trước khi upload nhé!',
      LIMIT_FILE_COUNT: 'Vượt quá 20 ảnh / bài. Chia thành nhiều bài nha.',
      LIMIT_UNEXPECTED_FILE: 'Vượt quá 20 ảnh / bài.',
      LIMIT_PART_COUNT: 'Form data quá nhiều phần.',
    };
    const msg = map[err.code] || `Upload lỗi: ${err.message}`;
    logger.warn(`Multer error: ${err.code} - ${err.message}`);
    return res.status(400).json({ error: msg, code: err.code });
  }

  // FileFilter error (custom Error throw từ fileFilter)
  if (err && err.message && err.message.startsWith('File "')) {
    logger.warn(`File filter reject: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }

  // Generic uncaught error
  logger.error(`Unhandled error: ${err && err.stack || err}`);
  res.status(500).json({
    error: (err && err.message) || 'Lỗi server không xác định',
  });
});

app.listen(config.server.port, () => {
  logger.info(`Web server đang chạy: http://localhost:${config.server.port}`);
  // Khoi phuc lich tu DB: re-schedule lich tuong lai + catch-up lich qua han
  try {
    scheduler.init();
  } catch (e) {
    logger.error(`Scheduler init error: ${e.message}`);
  }
  // Direct-IP mode: PLAYWRIGHT_LOCAL_URL set static → sync permissions từ LOCAL ngay khi start.
  // (Tunnel mode dùng /api/register-local handler để trigger sync khi LOCAL phone home.)
  if (getLocalUrl()) {
    permissions.syncOnRegister({ maxRetries: 3, retryDelay: 3000 }).catch(e => logger.warn(`startup syncOnRegister: ${e.message}`));
  }
});

process.on('SIGINT', async () => {
  await playwright.closeBrowser();
  process.exit(0);
});
