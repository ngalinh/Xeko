const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const config = require('./config/default');
const logger = require('./src/utils/logger');
const playwright = process.env.PLAYWRIGHT_LOCAL_URL
  ? require('./playwright-proxy')
  : require('./src/playwright/post');
const postLogger = require('./src/database/post-logger');
const { queuePost } = require('./src/utils/post-queue');

const permissions = require('./src/utils/permissions');
const auth = require('./src/utils/auth');

const app = express();
app.use(express.json());

// Auth gate: cần login basso.vn + được admin Xeko phân quyền mới được vào trang.
// /admin, /platform, /api/auth (basso.vn) đi route khác — chỉ chặn frontend Xeko.
// /api/me: frontend tự kiểm tra session — public.
// /api/register-local: local server tự xác thực bằng x-api-key — public.
const PUBLIC_PATHS = ['/health', '/api/me', '/api/register-local'];
app.use(async (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_PATHS.includes(req.path)) return next();

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
const UPLOADS_DIR = path.resolve(__dirname, '../data/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.get('/api/image/:date/:filename', (req, res) => {
  const { date, filename } = req.params;
  // Chặn path traversal
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || /[/\\]/.test(filename)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(UPLOADS_DIR, date, filename);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(400).send('Bad request');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

function persistImages(imagePaths) {
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
      logger.error(`persistImages: ${e.message}`);
    }
  }
  return urls;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file ảnh'));
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

// Job queue: post chạy async để tránh reverse proxy timeout ở ~60s.
// Browser POST /api/post → trả ngay {jobId}, rồi polling /api/job/:id.
const postJobs = new Map();

function createJob() {
  const id = crypto.randomBytes(8).toString('hex');
  postJobs.set(id, { status: 'pending', createdAt: Date.now() });
  return id;
}

function setJobResult(id, result) {
  postJobs.set(id, { status: 'done', result, createdAt: Date.now() });
}

function setJobError(id, message) {
  postJobs.set(id, { status: 'failed', error: message, createdAt: Date.now() });
}

// Dọn job cũ mỗi giờ
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of postJobs) {
    if (now - job.createdAt > 3600_000) postJobs.delete(id);
  }
}, 3600_000);

async function executePost({ profile, message, target, groupId, imagePaths, imageUrls, batchId }) {
  if (profile) playwright.setProfile(profile);

  // Snapshot 1 lần ngay đầu — không gọi getActiveProfile() sau await (global có thể bị đổi)
  const _pData = playwright.getActiveProfile();
  const profileKey  = profile || _pData.key || '';
  const profileName = _pData.name || profileKey;

  if (!batchId) batchId = crypto.randomUUID();

  // Đăng lên cá nhân + tất cả group
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
    postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
  }

  if (target === 'group') {
    const r = await playwright.postToGroup(groupId, message, imagePaths);
    postCount++;
    postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'group', groupId, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
    return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
  }

  // personal (default)
  const r = await playwright.postToPersonal(message, imagePaths);
  postCount++;
  postLogger.logPost({ profile: profileKey, profileName, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web', images: imageUrls, batchId });
  return { success: r.success, postUrl: r.postUrl, screenshot: !!r.screenshot, error: r.error };
}

// Dang bai (async job)
app.post('/api/post', upload.array('images', 10), async (req, res) => {
  checkDailyReset();

  const { message, target, groupId, profile, batchId } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  // Kiem tra nhanh (sync) — trả lỗi luôn nếu sai
  try {
    if (profile) playwright.setProfile(profile);
    else playwright.getActiveProfile();
  } catch {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile!' });
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
  const imageUrls = persistImages(imagePaths);

  // Tạo job, trả jobId ngay
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  // Chạy post qua serial queue — tránh race condition profile
  queuePost(() => executePost({ profile, message, target, groupId, imagePaths, imageUrls, batchId }))
    .then(result => setJobResult(jobId, result))
    .catch(error => {
      logger.error(`Lỗi job ${jobId}: ${error.message}`);
      setJobError(jobId, error.message);
    })
    .finally(() => cleanupFiles(imagePaths));
});

app.get('/api/job/:id', (req, res) => {
  const job = postJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại hoặc đã hết hạn' });
  res.json(job);
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

// Commands
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  checkDailyReset();

  if (command === '/status') {
    let profileName = 'Chưa chọn';
    try {
      const p = playwright.getActiveProfile();
      profileName = p.name;
    } catch {}

    return res.json({
      message: `📊 Báo cáo hôm nay:\n\n👤 Profile: ${profileName}\n📝 Bài đã đăng: ${postCount}/${config.posting.maxPostsPerDay}\n📅 Ngày: ${lastResetDate}`,
    });
  }

  res.json({ message: 'Lệnh không hợp lệ' });
});

// === Session Check API ===
const sessionCheck = require('./src/utils/session-check');

const loginHistory = require('./src/utils/login-history');

// Thêm tài khoản mới + mở trình duyệt để login thủ công
app.post('/api/accounts', async (req, res) => {
  const { type, key, name, email, password, saleworkName } = req.body;

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
        body: JSON.stringify({ type, key, name, email, password, saleworkName }),
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
      const { chromium } = require('playwright');
      const browser = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1280, height: 720 },
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
      });
      const data = await response.json();
      if (!wantAll && req.user) {
        if (Array.isArray(data.facebook)) data.facebook = permissions.filterProfiles(req.user.email, data.facebook);
        if (Array.isArray(data.zalo)) data.zalo = permissions.filterProfiles(req.user.email, data.zalo);
      }
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  const dataDir = path.resolve(__dirname, '../playwright-data');
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing',
  ];
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    let fbProfiles = entries
      .filter(e => e.isDirectory() && !knownNonProfiles.includes(e.name) && !e.name.startsWith('.'))
      .filter(e => !e.name.includes('.'))
      .map(e => {
        const key = e.name;
        const cfgProfile = config.profiles[key];
        const meta = loadProfilesMeta()[key];
        return {
          key,
          name: (meta && meta.name) || (cfgProfile ? cfgProfile.name : key),
          email: (meta && meta.email) || (cfgProfile ? (cfgProfile.email || '') : ''),
          fromConfig: !!cfgProfile,
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

// Lưu thông tin profile động vào file JSON
const PROFILES_META_FILE = path.resolve(__dirname, './config/profiles-meta.json');
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
}

// Cập nhật thông tin profile
app.put('/api/accounts/:key', async (req, res) => {
  const { key } = req.params;
  const { name, email, password, type, saleworkName } = req.body;

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
        body: JSON.stringify({ name, email, password, type, saleworkName }),
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
    meta[key] = { name, email: email || '', password: password || (meta[key] && meta[key].password) || '' };
    saveProfilesMeta(meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/login-history', (req, res) => {
  const profile = req.query.profile || null;
  const limit = parseInt(req.query.limit) || 50;
  res.json(loginHistory.getHistory(profile, limit));
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
app.post('/api/schedule', upload.array('images', 10), (req, res) => {
  const { time, target, groupId, message, profile, type, groupName, zaloAccount } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!profile) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile' });
  }

  try {
    const job = scheduler.addSchedule({ time, target, groupId, message, imagePaths, profile, type, groupName, zaloAccount });
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
    res.json(result);
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

// ===== CHANNELS PROXY =====
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
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
  }
}

app.get('/api/channels', (req, res) => proxyToLocal(req, res, 'GET', '/api/channels'));
app.post('/api/channels/fb-groups', (req, res) => proxyToLocal(req, res, 'POST', '/api/channels/fb-groups', req.body));
app.patch('/api/channels/fb-groups/:key', (req, res) => proxyToLocal(req, res, 'PATCH', `/api/channels/fb-groups/${req.params.key}`, req.body));
app.delete('/api/channels/fb-groups/:key', (req, res) => proxyToLocal(req, res, 'DELETE', `/api/channels/fb-groups/${req.params.key}`));
app.post('/api/channels/zalo-groups', (req, res) => proxyToLocal(req, res, 'POST', '/api/channels/zalo-groups', req.body));
app.patch('/api/channels/zalo-groups/:key', (req, res) => proxyToLocal(req, res, 'PATCH', `/api/channels/zalo-groups/${req.params.key}`, req.body));
app.delete('/api/channels/zalo-groups/:key', (req, res) => proxyToLocal(req, res, 'DELETE', `/api/channels/zalo-groups/${req.params.key}`));
app.put('/api/channels/profile-channels', (req, res) => proxyToLocal(req, res, 'PUT', '/api/channels/profile-channels', req.body));

// ===== RESTART LOCAL SERVER =====
app.post('/api/restart', (req, res) => proxyToLocal(req, res, 'POST', '/api/restart'));

// ===== ZALO POST =====
app.post('/api/zalo/post', upload.array('images', 10), async (req, res) => {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });

  const imagePaths = (req.files || []).map(f => f.path);
  // Persist ảnh trước khi proxy — đảm bảo files còn tồn tại (ReadStream chưa consume)
  const zaloImageUrls = persistImages(imagePaths);
  try {
    const fetchFn = await getFetch();
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    const { profile, zaloAccountName, groupName, message } = req.body;
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

    // Ghi log vào thống kê
    postLogger.logPost({
      profile: accountName || 'zalo',
      profileName: accountName || 'Zalo',
      platform: 'zalo',
      target: 'group',
      groupName: groupName || '',
      message: message || '',
      imageCount: imagePaths.length,
      success: !!(data.success || data.processing),
      error: data.error || null,
      postUrl: data.postUrl || null,
      source: 'web',
      images: zaloImageUrls,
    });

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: `Lỗi proxy Zalo post: ${e.message}` });
  } finally {
    cleanupFiles(imagePaths);
  }
});

app.get('/api/zalo/status/:jobId', async (req, res) => {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });
  try {
    const fetchFn = await getFetch();
    const response = await fetchFn(`${LOCAL_URL}/api/zalo/status/${req.params.jobId}`, {
      headers: { 'x-api-key': process.env.LOCAL_API_KEY || 'change-this-secret-key' },
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
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
    roles: user.roles,
    isXekoAdmin: permissions.isXekoAdmin(user.email),
    isSuperAdmin: permissions.isSuperAdmin(user.email),
    allProfiles: !!(info && info.allProfiles) || permissions.isXekoAdmin(user.email),
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
    const { email, isXekoAdmin: admin, allProfiles, profiles, note } = req.body || {};
    const u = permissions.upsertUser({ email, isXekoAdmin: admin, allProfiles, profiles, note });
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

// Local server tự đăng ký URL tunnel mới khi khởi động
let dynamicLocalUrl = process.env.PLAYWRIGHT_LOCAL_URL || null;

app.post('/api/register-local', (req, res) => {
  const { url } = req.body;
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== (process.env.LOCAL_API_KEY || 'change-this-secret-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!url) return res.status(400).json({ error: 'Missing url' });
  dynamicLocalUrl = url;
  process.env.PLAYWRIGHT_LOCAL_URL = url; // Cập nhật để playwright-proxy đọc URL mới
  logger.info(`Local server đã đăng ký URL mới: ${url}`);
  res.json({ success: true, message: `Đã cập nhật URL: ${url}` });
});

// Override PLAYWRIGHT_LOCAL_URL bằng dynamicLocalUrl nếu có
function getLocalUrl() {
  return dynamicLocalUrl || process.env.PLAYWRIGHT_LOCAL_URL;
}

app.listen(config.server.port, () => {
  logger.info(`Web server đang chạy: http://localhost:${config.server.port}`);
  // Khoi phuc lich tu DB: re-schedule lich tuong lai + catch-up lich qua han
  try {
    scheduler.init();
  } catch (e) {
    logger.error(`Scheduler init error: ${e.message}`);
  }
});

process.on('SIGINT', async () => {
  await playwright.closeBrowser();
  process.exit(0);
});
