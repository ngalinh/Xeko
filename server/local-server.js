/**
 * LOCAL-SERVER.JS - Chạy trên máy local
 * Nhận lệnh từ server ai.basso.vn và chạy Playwright
 *
 * Cách dùng: node local-server.js
 */

const path = require('path');
require('dotenv').config({
  path: [
    path.resolve(__dirname, '.env'),       // server/.env (theo .env.example)
    path.resolve(__dirname, '../.env'),    // root .env (theo start.js)
  ],
});
// Set PLAYWRIGHT_BROWSERS_PATH TRƯỚC require playwright/post.js — đảm bảo
// browsers được lưu vào folder writable dưới project, tránh EPERM khi PM2
// chạy như Windows Service không có quyền ghi vào %LOCALAPPDATA%\ms-playwright
require('./src/utils/playwright-launch');

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

const playwright = require('./src/playwright/post');
const salework = require('./src/playwright/salework');
const sessionCheck = require('./src/utils/session-check');
const loginHistory = require('./src/utils/login-history');
const logger = require('./src/utils/logger');
const { parseProxy } = require('./src/utils/proxy');
const apiKey = require('./src/utils/api-key');
const rateLimit = require('./src/utils/rate-limit');
const zaloQueue = require('./src/utils/zalo-queue');
const { groupDelayMs } = require('./src/utils/post-delays');

// Fail-fast nếu LOCAL_API_KEY chưa đặt / còn placeholder mặc định.
// Server local accept request từ tunnel public → key yếu = mở cửa.
apiKey.assertConfigured('local-server');

const ZALO_ACCOUNTS_FILE = path.resolve(__dirname, 'config/zalo-accounts.json');

// File user-permissions persistent — REMOTE (Basso) sync xuống đây để sống sót container restart.
// Cùng path với REMOTE để format/migration nhất quán nếu sau này swap chỗ lưu.
const PERMISSIONS_DATA_DIR = process.env.XEKO_DATA_DIR
  ? path.resolve(process.env.XEKO_DATA_DIR)
  : path.resolve(__dirname, '..');
const PERMISSIONS_FILE = path.join(PERMISSIONS_DATA_DIR, 'config/user-permissions.json');

function loadZaloAccounts() {
  try {
    if (fs.existsSync(ZALO_ACCOUNTS_FILE)) return JSON.parse(fs.readFileSync(ZALO_ACCOUNTS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveZaloAccounts(accounts) {
  const dir = path.dirname(ZALO_ACCOUNTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ZALO_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

const app = express();
app.use(express.json());

// ===== API KEY AUTH (timing-safe compare, đã assertConfigured ở trên) =====
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // bỏ qua auth cho health check
  if (!apiKey.verify(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ===== MULTER: nhận ảnh từ server =====
const TEMP_DIR = path.resolve(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Format mở rộng để chấp nhận ảnh từ iPhone (HEIC/HEIF), webp, ...
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
    fileSize: 25 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || ACCEPTED_IMAGE_EXTS.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`File "${file.originalname}" không phải ảnh (${file.mimetype})`));
    }
  },
});

function cleanupFiles(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// ===== PROFILE =====
app.post('/api/profile', (req, res) => {
  const { profile } = req.body;
  try {
    const p = playwright.setProfile(profile);
    const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
    let displayName = p.name || profile;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta[profile] && meta[profile].name) displayName = meta[profile].name;
    } catch (_) {}
    res.json({ success: true, name: displayName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== ASYNC JOB QUEUE (tránh proxy timeout khi Playwright chạy lâu) =====
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
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of postJobs) {
    if (now - job.createdAt > 3600_000) postJobs.delete(id);
  }
  for (const [id, job] of zaloJobs) {
    if (job.createdAt && now - job.createdAt > 3600_000) zaloJobs.delete(id);
  }
}, 3600_000);

app.get('/api/job/:id', (req, res) => {
  const job = postJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại hoặc đã hết hạn' });
  res.json(job);
});

// ===== ĐĂNG BÀI FACEBOOK =====
app.post('/api/post', upload.array('images', 20), async (req, res) => {
  const { message, target, groupId } = req.body;
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

  let activeProfile;
  try {
    activeProfile = playwright.getActiveProfile();
  } catch {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile!' });
  }

  // Rate limit theo profile — tránh spam đẩy đến FB
  const rl = rateLimit.check(activeProfile.key);
  if (!rl.ok) {
    cleanupFiles(imagePaths);
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: rl.reason, retryAfterMs: rl.retryAfterMs });
  }

  // Trả jobId ngay, Playwright chạy ở background tránh proxy timeout
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  // Safety net: nếu Playwright bị kẹt và IIFE không bao giờ gọi setJobResult/setJobError,
  // job sẽ ở pending mãi mãi. Force-fail sau 9 phút (< 10 phút của pollLocalJob ở cloud)
  // để cloud thấy "failed" thay vì tự timeout với message chung chung hơn.
  const _jobTimeoutId = setTimeout(() => {
    const j = postJobs.get(jobId);
    if (j && j.status === 'pending') {
      logger.error(`[job ${jobId}] TIMEOUT sau 9 phút — force setJobError`);
      setJobError(jobId, 'Timeout: Playwright bị kẹt quá 9 phút. Có thể đã đăng thành công — kiểm tra Facebook trước khi đăng lại.');
    }
  }, 9 * 60 * 1000);

  (async () => {
    try {
      const cfg = require('./config/default');

      if (target === 'all') {
        const results = [];
        logger.info('Đăng lên FB cá nhân...');
        const r = await playwright.postToPersonal(message, imagePaths);
        results.push({ target: 'FB Cá nhân', success: r.success, error: r.error, postUrl: r.postUrl });
        await new Promise(r => setTimeout(r, groupDelayMs()));
        const groups = Object.values(cfg.groups);
        for (const group of groups) {
          logger.info(`Đăng lên ${group.name}...`);
          const gr = await playwright.postToGroup(group.id, message, imagePaths);
          results.push({ target: group.name, success: gr.success, error: gr.error, postUrl: gr.postUrl });
          if (groups.indexOf(group) < groups.length - 1) {
            await new Promise(r => setTimeout(r, groupDelayMs()));
          }
        }
        setJobResult(jobId, { results });
        return;
      }

      if (target === 'allgroup') {
        const groups = Object.values(cfg.groups);
        const results = [];
        for (const group of groups) {
          const gr = await playwright.postToGroup(group.id, message, imagePaths);
          results.push({ target: group.name, success: gr.success, error: gr.error, postUrl: gr.postUrl });
          if (groups.indexOf(group) < groups.length - 1) {
            await new Promise(r => setTimeout(r, groupDelayMs()));
          }
        }
        setJobResult(jobId, { results });
        return;
      }

      if (target === 'shortcut' || target === 'group') {
        const gId = target === 'shortcut' ? cfg.groups[groupId]?.id : groupId;
        if (!gId) { setJobError(jobId, `Group "${groupId}" không tồn tại`); return; }
        const result = await playwright.postToGroup(gId, message, imagePaths);
        setJobResult(jobId, { success: result.success, error: result.error, postUrl: result.postUrl });
        return;
      }

      if (target === 'page') {
        if (!groupId) { setJobError(jobId, 'Thiếu pageId'); return; }
        const result = await playwright.postToPage(groupId, message, imagePaths);
        setJobResult(jobId, { success: result.success, error: result.error, postUrl: result.postUrl });
        return;
      }

      if (target === 'personal-share-groups') {
        if (groupKeywords.length === 0) {
          const r = await playwright.postToPersonal(message, imagePaths);
          setJobResult(jobId, { success: r.success, error: r.error, postUrl: r.postUrl });
          return;
        }
        // Swap sang quickPostToPersonalAndGroups (đã verified work) thay cho
        // postPersonalAndShareToGroups cũ (unstable). Hỗ trợ "Đăng nhanh FB" mode.
        const r = await playwright.quickPostToPersonalAndGroups(message, imagePaths, groupKeywords);
        setJobResult(jobId, {
          success: r.success,
          error: r.error,
          postUrl: r.postUrl,
          sharedGroups: r.sharedGroups != null ? r.sharedGroups : groupKeywords.length,
          missedGroups: r.missedGroups || [],
          partialSuccess: r.partialSuccess === true,
          steps: r.steps,
        });
        return;
      }

      // Mặc định: đăng cá nhân
      const result = await playwright.postToPersonal(message, imagePaths);
      setJobResult(jobId, { success: result.success, error: result.error, postUrl: result.postUrl });

    } catch (error) {
      logger.error(`Lỗi job ${jobId}: ${error.message}`);
      setJobError(jobId, error.message);
    } finally {
      clearTimeout(_jobTimeoutId);
      cleanupFiles(imagePaths);
    }
  })();
});

// ===== DO-COMMENT: execute comment only, no DB logging (called by cloud via playwright-proxy) =====
app.post('/api/do-comment', upload.array('images', 10), async (req, res) => {
  const { postUrl, profile, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);
  if (!postUrl) { cleanupFiles(imagePaths); return res.status(400).json({ error: 'Thiếu postUrl' }); }
  if (!profile) { cleanupFiles(imagePaths); return res.status(400).json({ error: 'Thiếu profile' }); }

  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  const _timeoutId = setTimeout(() => {
    const j = postJobs.get(jobId);
    if (j && j.status === 'pending') setJobError(jobId, 'Timeout: Playwright bị kẹt quá 9 phút.');
  }, 9 * 60 * 1000);

  (async () => {
    try {
      const result = await playwright.postComment({ postUrl, message: message || '', imagePaths, profile });
      setJobResult(jobId, result);
    } catch (e) {
      setJobError(jobId, e.message);
    } finally {
      clearTimeout(_timeoutId);
      cleanupFiles(imagePaths);
    }
  })();
});

// ===== TEST: FB QUICK POST V2 — ASYNC JOB pattern =====
// Tránh tunnel/proxy timeout khi test chạy > 1-2 phút.
// Trả jobId ngay, chạy background, store result vào postJobs.
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

  try {
    playwright.setProfile(profile);
  } catch (e) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: e.message });
  }

  // Rate limit per profile (từ main)
  const rl = rateLimit.check(profile);
  if (!rl.ok) {
    cleanupFiles(imagePaths);
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: rl.reason, retryAfterMs: rl.retryAfterMs });
  }

  // Trả jobId ngay, chạy background (async job pattern — tránh tunnel timeout)
  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  const _qpTimeoutId = setTimeout(() => {
    const j = postJobs.get(jobId);
    if (j && j.status === 'pending') {
      logger.error(`[fb-quick-post-test job ${jobId}] TIMEOUT sau 9 phút`);
      setJobError(jobId, 'Timeout: Playwright bị kẹt quá 9 phút. Có thể đã đăng thành công — kiểm tra Facebook trước khi đăng lại.');
    }
  }, 9 * 60 * 1000);

  (async () => {
    try {
      const result = await playwright.quickPostToPersonalAndGroups(message || '', imagePaths, groupKeywords);
      setJobResult(jobId, result);
    } catch (e) {
      logger.error(`[fb-quick-post-test] job ${jobId} FAILED: ${e.message}`);
      setJobError(jobId, e.message);
    } finally {
      clearTimeout(_qpTimeoutId);
      cleanupFiles(imagePaths);
    }
  })();
});

// ===== ĐĂNG ZALO =====
const zaloJobs = new Map(); // jobId → { status, success, error }

app.post('/api/zalo/post', upload.array('images', 20), async (req, res) => {
  const { profile, zaloAccountName, groupName, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);
  const accountName = zaloAccountName || profile;

  logger.info(`[zalo/post] Nhận: account="${accountName}", group="${groupName}", ảnh=${imagePaths.length}, files=${JSON.stringify(imagePaths)}`);

  if (!accountName || !groupName) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu zaloAccountName/profile hoặc groupName' });
  }

  // Chỉ chặn theo giới hạn/giờ (chống spam dài hạn). Min-interval giữa 2 post
  // cùng account KHÔNG còn từ chối ở đây — đã được xử lý bằng hàng đợi tự giãn
  // cách bên dưới, để tick nhiều group cùng account vẫn đăng được lần lượt.
  const rl = rateLimit.checkHourly(`zalo:${accountName}`);
  if (!rl.ok) {
    cleanupFiles(imagePaths);
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: rl.reason, retryAfterMs: rl.retryAfterMs });
  }

  // Look up accountKey from zaloAccounts (match by key, name, or saleworkName)
  const accounts = loadZaloAccounts();
  const acct = accounts.find(a => a.key === accountName || a.name === accountName || a.saleworkName === accountName);
  const accountKey = acct ? acct.key : accountName;

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  zaloJobs.set(jobId, { status: 'processing', createdAt: Date.now() });

  // Respond immediately so cloud proxy never hits 504 timeout
  res.json({ success: true, processing: true, jobId });

  // Xếp hàng theo account: tuần tự hoá (tránh xung đột profile browser) + tự
  // giãn cách ≥ MIN_INTERVAL giữa 2 post cùng account (chống Zalo flag spam).
  zaloQueue.enqueue(`zalo:${accountKey || accountName}`, () =>
    salework.postToZaloGroup({ zaloAccountName: accountName, accountKey, groupName, message: message || '', imagePaths }))
    .then(result => {
      cleanupFiles(imagePaths);
      zaloJobs.set(jobId, { status: 'done', success: result.success, error: result.error || null, completedAt: Date.now() });
      if (!result.success) logger.error(`[zalo/post] Thất bại "${groupName}": ${result.error}`);
      else logger.info(`[zalo/post] Thành công: ${groupName}`);
    })
    .catch(err => {
      cleanupFiles(imagePaths);
      zaloJobs.set(jobId, { status: 'done', success: false, error: err.message, completedAt: Date.now() });
      logger.error(`[zalo/post] Exception: ${err.message}`);
    });
});

app.get('/api/zalo/status/:jobId', (req, res) => {
  const job = zaloJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại' });
  res.json(job);
  // Giữ done result 5 phút để cloud có thể poll lại nếu request đầu bị lỗi mạng
  if (job.status === 'done' && job.completedAt && Date.now() - job.completedAt > 5 * 60 * 1000) {
    zaloJobs.delete(req.params.jobId);
  }
});

// ===== ACCOUNTS =====
app.post('/api/accounts', (req, res) => {
  const { type, key, name, email, password, saleworkName, proxy } = req.body;
  if (!key || !name) return res.status(400).json({ error: 'Thiếu key hoặc tên' });

  if (type === 'zalo') {
    if (!saleworkName) return res.status(400).json({ error: 'Thiếu tên Salework' });

    const accounts = loadZaloAccounts();
    if (accounts.find(a => a.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
    accounts.push({ key, name, saleworkName, fbProfileKey: '', proxy: (proxy || '').trim() });
    saveZaloAccounts(accounts);

    const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
    try {
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
      meta[key] = { name, saleworkName, proxy: (proxy || '').trim() };
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    } catch {}

    // Each Zalo account gets its own persistent browser profile (Hướng B)
    const saleworkProfileDir = salework.getSaleworkProfile(key);
    const alreadyLoggedIn = fs.existsSync(saleworkProfileDir);

    res.json({ success: true, message: alreadyLoggedIn
      ? `Đã thêm tài khoản Zalo "${name}". Profile Salework đã tồn tại — xoá và thêm lại nếu cần setup lại.`
      : `Đang mở Chromium để đăng nhập Salework và chọn tài khoản "${name}". Chọn đúng tài khoản xong thì đóng cửa sổ.` });

    if (!alreadyLoggedIn) {
      (async () => {
        try {
          const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
          fs.mkdirSync(saleworkProfileDir, { recursive: true });
          const proxyOpt = parseProxy(proxy);
          if (proxyOpt) logger.info(`Salework "${name}" dùng proxy: ${proxyOpt.server}`);
          const browser = await safeLaunchPersistentContext(saleworkProfileDir, {
            headless: false,
            slowMo: 500,
            viewport: { width: 1280, height: 720 },
            ...(proxyOpt ? { proxy: proxyOpt } : {}),
          });
          const page = browser.pages()[0] || await browser.newPage();
          await page.goto(salework.ZALO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          loginHistory.addEntry(key, name, 'login', 'Mở Salework Zalo để đăng nhập và chọn tài khoản');
          browser.on('close', () => {
            loginHistory.addEntry(key, name, 'login', 'Đã đóng Salework - session và tài khoản đã lưu');
          });
        } catch (e) {
          logger.error(`Lỗi mở Salework: ${e.message}`);
        }
      })();
    }
    return;
  }

  // Facebook (default)
  // Lưu tên hiển thị + email + proxy vào meta ngay (trước khi launch browser)
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  try {
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    meta[key] = {
      name,
      email: email || '',
      password: password || meta[key]?.password || '',
      proxy: (proxy || '').trim(),
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch {}

  res.json({ success: true, message: `Đang mở Chromium cho "${name}". Chờ cửa sổ hiện ra để đăng nhập.` });

  (async () => {
    try {
      const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
      const profileDir = path.resolve(__dirname, `playwright-data/${key}`);
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      const proxyOpt = parseProxy(proxy);
      if (proxyOpt) logger.info(`FB "${name}" dùng proxy: ${proxyOpt.server}`);
      const { getProfileDeviceFingerprint } = require('./src/utils/device-fingerprint');
      const { userAgent, viewport } = getProfileDeviceFingerprint(key);
      const browser = await safeLaunchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport,
        userAgent,
        ...(proxyOpt ? { proxy: proxyOpt } : {}),
      });
      const page = browser.pages()[0] || await browser.newPage();
      await page.goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });

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

      browser.on('close', () => {
        loginHistory.addEntry(key, name, 'login', 'Đã đóng trình duyệt - session được lưu');
      });
    } catch (e) {
      logger.error(`Loi mo Chromium cho "${name}": ${e.message}`);
      loginHistory.addEntry(key, name, 'session_expired', `Không mở được Chromium: ${e.message}`);
    }
  })();
});

app.post('/api/accounts/:key/login', (req, res) => {
  const { key } = req.params;
  const profileDir = path.resolve(__dirname, `playwright-data/${key}`);
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const profileMeta = meta[key];
  if (!profileMeta) return res.status(404).json({ error: `Không tìm thấy profile "${key}"` });

  const name = profileMeta.name || key;
  res.json({ success: true, message: `Đang mở Chromium cho "${name}". Đăng nhập xong thì đóng cửa sổ.` });

  (async () => {
    try {
      const { safeLaunchPersistentContext } = require('./src/utils/playwright-launch');
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
      const proxyOpt = parseProxy(profileMeta.proxy);
      if (proxyOpt) logger.info(`FB "${name}" dùng proxy: ${proxyOpt.server}`);
      const browser = await safeLaunchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1280, height: 720 },
        ...(proxyOpt ? { proxy: proxyOpt } : {}),
      });
      const page = browser.pages()[0] || await browser.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (profileMeta.email && profileMeta.password) {
        try {
          const emailInput = await page.$('input[name="email"]');
          if (emailInput) {
            await emailInput.fill(profileMeta.email);
            await page.fill('input[name="pass"]', profileMeta.password);
          }
        } catch {}
      }

      loginHistory.addEntry(key, name, 'login', 'Mở lại trình duyệt để đăng nhập');
      browser.on('close', () => {
        loginHistory.addEntry(key, name, 'login', 'Đã đóng trình duyệt - session được lưu');
      });
    } catch (e) {
      logger.error(`Lỗi mở Chromium re-login "${name}": ${e.message}`);
      loginHistory.addEntry(key, name, 'session_expired', `Không mở được Chromium: ${e.message}`);
    }
  })();
});

app.delete('/api/accounts/:type/:key', (req, res) => {
  const { type, key } = req.params;
  try {
    if (type === 'facebook') {
      const profileDir = path.resolve(__dirname, `playwright-data/${key}`);
      if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    } else if (type === 'zalo') {
      const accounts = loadZaloAccounts().filter(a => a.key !== key);
      saveZaloAccounts(accounts);
      // Delete per-account Salework profile so setup runs again on re-add
      const saleworkProfileDir = salework.getSaleworkProfile(key);
      if (fs.existsSync(saleworkProfileDir)) fs.rmSync(saleworkProfileDir, { recursive: true, force: true });
    } else {
      return res.status(400).json({ error: 'Loại không hợp lệ' });
    }
    loginHistory.addEntry(key, key, 'delete', 'Đã xoá tài khoản');
    res.json({ success: true, message: `Đã xoá tài khoản "${key}"` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts', (req, res) => {
  const dataDir = path.resolve(__dirname, 'playwright-data');
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing',
  ];
  try {
    const entries = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir, { withFileTypes: true })
      : [];
    const fbProfiles = entries
      .filter(e => e.isDirectory()
        && !knownNonProfiles.includes(e.name)
        && !e.name.startsWith('.')
        && !e.name.startsWith('salework')) // exclude salework and salework-{key} folders
      .map(e => ({
        key: e.name,
        name: meta[e.name]?.name || e.name,
        email: meta[e.name]?.email || '',
        proxy: meta[e.name]?.proxy || '',
      }));

    const zaloAccounts = loadZaloAccounts();

    res.json({ facebook: fbProfiles, zalo: zaloAccounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:key', (req, res) => {
  const { key } = req.params;
  const { name, email, password, saleworkName, type, proxy } = req.body;
  const proxyTrimmed = typeof proxy === 'string' ? proxy.trim() : undefined;
  try {
    if (type === 'zalo') {
      const accounts = loadZaloAccounts();
      const idx = accounts.findIndex(a => a.key === key);
      if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy tài khoản Zalo' });
      accounts[idx] = {
        ...accounts[idx],
        name: name || accounts[idx].name,
        saleworkName: saleworkName || accounts[idx].saleworkName,
        ...(proxyTrimmed !== undefined ? { proxy: proxyTrimmed } : {}),
      };
      saveZaloAccounts(accounts);
      return res.json({ success: true });
    }
    const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    meta[key] = {
      name,
      email: email || '',
      password: password || meta[key]?.password || '',
      proxy: proxyTrimmed !== undefined ? proxyTrimmed : (meta[key]?.proxy || ''),
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SESSIONS =====
app.get('/api/sessions', async (req, res) => {
  try {
    const results = await sessionCheck.checkAllSessions();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test proxy IP của 1 profile — async job pattern để tránh tunnel/reverse-proxy
// timeout (Chromium launch 2 lần có thể ~15-30s, vượt giới hạn 60s của ngrok free
// hoặc một số gateway). Trả jobId ngay, UI poll /api/test-proxy/job/:id.
const { runProxyTest } = require('./src/utils/test-proxy');
const testProxyJobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of testProxyJobs) {
    if (now - job.createdAt > 600_000) testProxyJobs.delete(id); // dọn sau 10 phút
  }
}, 600_000);

app.post('/api/accounts/:key/test-proxy', (req, res) => {
  const key = req.params.key;
  const jobId = crypto.randomBytes(8).toString('hex');
  testProxyJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  res.json({ jobId, status: 'pending' });

  (async () => {
    try {
      const result = await runProxyTest(key, { headless: true });
      testProxyJobs.set(jobId, { status: 'done', result, createdAt: Date.now() });
    } catch (e) {
      testProxyJobs.set(jobId, {
        status: 'done',
        result: { ok: false, profileKey: key, error: e.message, reason: 'exception' },
        createdAt: Date.now(),
      });
    }
  })();
});

app.get('/api/test-proxy/job/:jobId', (req, res) => {
  const job = testProxyJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại hoặc đã hết hạn' });
  res.json(job);
});

app.get('/api/login-history', (req, res) => {
  const profile = req.query.profile || null;
  const limit = parseInt(req.query.limit) || 50;
  res.json(loginHistory.getHistory(profile, limit));
});

// ===== PROXIES =====
const PROXY_LIST_FILE_LOCAL = path.resolve(__dirname, 'config/proxies.json');

function loadProxyListLocal() {
  try {
    if (fs.existsSync(PROXY_LIST_FILE_LOCAL)) return JSON.parse(fs.readFileSync(PROXY_LIST_FILE_LOCAL, 'utf8'));
  } catch {}
  return [];
}
function saveProxyListLocal(list) {
  const dir = path.dirname(PROXY_LIST_FILE_LOCAL);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROXY_LIST_FILE_LOCAL, JSON.stringify(list, null, 2));
}

app.get('/api/proxies', (req, res) => {
  res.json(loadProxyListLocal());
});

app.put('/api/proxies/bulk', (req, res) => {
  const { proxies } = req.body;
  if (!Array.isArray(proxies)) return res.status(400).json({ error: 'Thiếu proxies array' });
  saveProxyListLocal(proxies);
  res.json({ success: true, count: proxies.length });
});

app.post('/api/proxies', (req, res) => {
  const { id, label, host, port, user, pass, purchaseDate, expirationDate } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Thiếu host hoặc port' });
  const list = loadProxyListLocal();
  const proxyId = id || ('px_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  if (list.find(p => p.id === proxyId)) return res.json(list.find(p => p.id === proxyId));
  const proxy = { id: proxyId, label: label || '', host, port, user: user || '', pass: pass || '', purchaseDate: purchaseDate || '', expirationDate: expirationDate || '' };
  list.push(proxy);
  saveProxyListLocal(list);
  res.status(201).json(proxy);
});

app.put('/api/proxies/:id', (req, res) => {
  const { label, host, port, user, pass, purchaseDate, expirationDate } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Thiếu host hoặc port' });
  const list = loadProxyListLocal();
  const idx = list.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Không tìm thấy proxy' });
  list[idx] = { ...list[idx], label: label || '', host, port, user: user || '', pass: pass || '', purchaseDate: purchaseDate || '', expirationDate: expirationDate || '' };
  saveProxyListLocal(list);
  res.json(list[idx]);
});

app.delete('/api/proxies/:id', (req, res) => {
  const list = loadProxyListLocal();
  const filtered = list.filter(p => p.id !== req.params.id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'Không tìm thấy proxy' });
  saveProxyListLocal(filtered);
  res.json({ success: true });
});

// ===== CHANNELS =====
const CHANNELS_FILE = path.resolve(__dirname, 'config/channels.json');

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

// Ghi đè toàn bộ channels từ remote (push từ Ubuntu về local)
app.put('/api/channels/bulk', (req, res) => {
  const { fbGroups, fbPages, zaloGroups, profileChannels } = req.body;
  if (!fbGroups && !fbPages && !zaloGroups) return res.status(400).json({ error: 'Thiếu data' });
  const current = loadChannels();
  const updated = {
    fbGroups: fbGroups || current.fbGroups || [],
    fbPages: fbPages || current.fbPages || [],
    zaloGroups: zaloGroups || current.zaloGroups || [],
    profileChannels: profileChannels || current.profileChannels || {},
  };
  saveChannels(updated);
  res.json({ success: true });
});

// ===== SCRAPE: Lấy nội dung + ảnh từ link FB post =====
app.post('/api/fb-scrape', async (req, res) => {
  const { url, profile } = req.body;
  if (!url) return res.status(400).json({ error: 'Thiếu url bài viết' });

  if (profile) {
    try { playwright.setProfile(profile); } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  try { playwright.getActiveProfile(); } catch {
    return res.status(400).json({ error: 'Chưa chọn profile!' });
  }

  const jobId = createJob();
  res.json({ jobId, status: 'pending' });

  (async () => {
    try {
      const result = await playwright.scrapePost(url);
      setJobResult(jobId, { success: result.success, text: result.text || '', imageUrls: result.imageUrls || [], error: result.error });
    } catch (e) {
      logger.error(`[fb-scrape] job ${jobId} FAILED: ${e.message}`);
      setJobError(jobId, e.message);
    }
  })();
});

// ===== SCREENSHOT =====
// ?name=<file>.png → trả ảnh debug cụ thể (vd debug-failed-<ts>.png) trong logs/.
// Không có name → ảnh post mới nhất. Chỉ cho phép file .png trong thư mục logs
// (path.basename + regex chặn path traversal).
app.get('/api/screenshot', (req, res) => {
  const logsDir = path.resolve(__dirname, 'logs');
  let target;
  if (req.query.name) {
    const safe = path.basename(String(req.query.name));
    if (!/^[\w.\-]+\.png$/i.test(safe)) {
      return res.status(400).json({ error: 'Tên ảnh không hợp lệ' });
    }
    target = path.join(logsDir, safe);
  } else {
    target = path.join(logsDir, 'latest-post.png');
  }
  if (fs.existsSync(target)) {
    res.sendFile(target);
  } else {
    res.status(404).json({ error: 'Không có ảnh lỗi (có thể đã bị xoá hoặc ghi đè)' });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', machine: 'local', timestamp: new Date().toISOString() });
});

// ===== RESTART =====
app.post('/api/restart', (req, res) => {
  res.json({ success: true, message: 'Đang khởi động lại server...' });
  setTimeout(() => process.exit(0), 500);
});

// ===== PERMISSIONS STORE (proxy file cho REMOTE) =====
// REMOTE container (Basso) ephemeral nên ghi/đọc data ở đây, sống sót khi restart.
app.get('/api/permissions', (req, res) => {
  try {
    if (!fs.existsSync(PERMISSIONS_FILE)) {
      return res.status(404).json({ error: 'No permissions file' });
    }
    const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/permissions', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || !data.users) {
      return res.status(400).json({ error: 'Invalid payload (cần { users: {...} })' });
    }
    const dir = path.dirname(PERMISSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true, count: Object.keys(data.users).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== START =====
// Global error middleware: tra JSON ro rang thay vi plain text "Internal Server"
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
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
  if (err && err.message && err.message.startsWith('File "')) {
    logger.warn(`File filter reject: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
  logger.error(`Unhandled error: ${err && err.stack || err}`);
  res.status(500).json({
    error: (err && err.message) || 'Lỗi server không xác định',
  });
});

const PORT = process.env.LOCAL_PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Local Playwright server đang chạy: http://localhost:${PORT}`);
  logger.info(`Đang chờ lệnh từ server ai.basso.vn...`);
});

process.on('SIGINT', async () => {
  await playwright.closeBrowser();
  process.exit(0);
});
