/**
 * LOCAL-SERVER.JS - Chạy trên máy local
 * Nhận lệnh từ server ai.basso.vn và chạy Playwright
 *
 * Cách dùng: node local-server.js
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const playwright = require('./src/playwright/post');
const salework = require('./src/playwright/salework');
const sessionCheck = require('./src/utils/session-check');
const loginHistory = require('./src/utils/login-history');
const logger = require('./src/utils/logger');

const ZALO_ACCOUNTS_FILE = path.resolve(__dirname, 'config/zalo-accounts.json');

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

// ===== API KEY AUTH =====
const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';

app.use((req, res, next) => {
  if (req.path === '/health') return next(); // bỏ qua auth cho health check
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ===== MULTER: nhận ảnh từ server =====
const TEMP_DIR = path.resolve(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
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
    res.json({ success: true, name: p.name || profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== ĐĂNG BÀI FACEBOOK =====
app.post('/api/post', upload.array('images', 10), async (req, res) => {
  const { message, target, groupId } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  try {
    playwright.getActiveProfile();
  } catch {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile!' });
  }

  try {
    if (target === 'all') {
      const results = [];

      logger.info('Đăng lên FB cá nhân...');
      const r = await playwright.postToPersonal(message, imagePaths);
      results.push({ target: 'FB Cá nhân', success: r.success, error: r.error, postUrl: r.postUrl });

      await new Promise(r => setTimeout(r, Math.random() * 30000 + 30000));

      const config = require('./config/default');
      const groups = Object.values(config.groups);
      for (const group of groups) {
        logger.info(`Đăng lên ${group.name}...`);
        const gr = await playwright.postToGroup(group.id, message, imagePaths);
        results.push({ target: group.name, success: gr.success, error: gr.error, postUrl: gr.postUrl });
        if (groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, Math.random() * 30000 + 30000));
        }
      }

      cleanupFiles(imagePaths);
      return res.json({ results });
    }

    if (target === 'allgroup') {
      const config = require('./config/default');
      const groups = Object.values(config.groups);
      const results = [];
      for (const group of groups) {
        const gr = await playwright.postToGroup(group.id, message, imagePaths);
        results.push({ target: group.name, success: gr.success, error: gr.error });
        if (groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, Math.random() * 30000 + 30000));
        }
      }
      cleanupFiles(imagePaths);
      return res.json({ results });
    }

    if (target === 'shortcut' || target === 'group') {
      const config = require('./config/default');
      const gId = target === 'shortcut' ? config.groups[groupId]?.id : groupId;
      if (!gId) {
        cleanupFiles(imagePaths);
        return res.status(400).json({ error: `Group "${groupId}" không tồn tại` });
      }
      const result = await playwright.postToGroup(gId, message, imagePaths);
      cleanupFiles(imagePaths);
      return res.json({ success: result.success, error: result.error, postUrl: result.postUrl });
    }

    // Mặc định: đăng cá nhân
    const result = await playwright.postToPersonal(message, imagePaths);
    cleanupFiles(imagePaths);
    return res.json({ success: result.success, error: result.error, postUrl: result.postUrl });

  } catch (error) {
    cleanupFiles(imagePaths);
    logger.error(`Lỗi: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

// ===== ĐĂNG ZALO =====
const zaloJobs = new Map(); // jobId → { status, success, error }

app.post('/api/zalo/post', upload.array('images', 10), async (req, res) => {
  const { profile, zaloAccountName, groupName, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);
  const accountName = zaloAccountName || profile;

  logger.info(`[zalo/post] Nhận: account="${accountName}", group="${groupName}", ảnh=${imagePaths.length}, files=${JSON.stringify(imagePaths)}`);

  if (!accountName || !groupName) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu zaloAccountName/profile hoặc groupName' });
  }

  // Look up accountKey from zaloAccounts (match by key, name, or saleworkName)
  const accounts = loadZaloAccounts();
  const acct = accounts.find(a => a.key === accountName || a.name === accountName || a.saleworkName === accountName);
  const accountKey = acct ? acct.key : accountName;

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  zaloJobs.set(jobId, { status: 'processing' });

  // Respond immediately so cloud proxy never hits 504 timeout
  res.json({ success: true, processing: true, jobId });

  salework.postToZaloGroup({ zaloAccountName: accountName, accountKey, groupName, message: message || '', imagePaths })
    .then(result => {
      cleanupFiles(imagePaths);
      zaloJobs.set(jobId, { status: 'done', success: result.success, error: result.error || null });
      if (!result.success) logger.error(`[zalo/post] Thất bại "${groupName}": ${result.error}`);
      else logger.info(`[zalo/post] Thành công: ${groupName}`);
    })
    .catch(err => {
      cleanupFiles(imagePaths);
      zaloJobs.set(jobId, { status: 'done', success: false, error: err.message });
      logger.error(`[zalo/post] Exception: ${err.message}`);
    });
});

app.get('/api/zalo/status/:jobId', (req, res) => {
  const job = zaloJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại' });
  res.json(job);
  if (job.status === 'done') zaloJobs.delete(req.params.jobId);
});

// ===== ACCOUNTS =====
app.post('/api/accounts', (req, res) => {
  const { type, key, name, email, password, saleworkName } = req.body;
  if (!key || !name) return res.status(400).json({ error: 'Thiếu key hoặc tên' });

  if (type === 'zalo') {
    if (!saleworkName) return res.status(400).json({ error: 'Thiếu tên Salework' });

    const accounts = loadZaloAccounts();
    if (accounts.find(a => a.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
    accounts.push({ key, name, saleworkName, fbProfileKey: '' });
    saveZaloAccounts(accounts);

    const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
    try {
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
      meta[key] = { name, saleworkName };
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
          const { chromium } = require('playwright');
          fs.mkdirSync(saleworkProfileDir, { recursive: true });
          const browser = await chromium.launchPersistentContext(saleworkProfileDir, {
            headless: false,
            slowMo: 500,
            viewport: { width: 1280, height: 720 },
          });
          const page = browser.pages()[0] || await browser.newPage();
          await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
  // Lưu tên hiển thị + email vào meta ngay (trước khi launch browser)
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  try {
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    meta[key] = { name, email: email || '', password: password || meta[key]?.password || '' };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch {}

  res.json({ success: true, message: `Đang mở Chromium cho "${name}". Chờ cửa sổ hiện ra để đăng nhập.` });

  (async () => {
    try {
      const { chromium } = require('playwright');
      const profileDir = path.resolve(__dirname, `playwright-data/${key}`);
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      const browser = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1280, height: 720 },
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
  const config = require('./config/default');
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing',
  ];
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    const fbProfiles = entries
      .filter(e => e.isDirectory()
        && !knownNonProfiles.includes(e.name)
        && !e.name.startsWith('.')
        && !e.name.startsWith('salework')) // exclude salework and salework-{key} folders
      .map(e => ({
        key: e.name,
        name: (meta[e.name] && meta[e.name].name) || config.profiles[e.name]?.name || e.name,
        email: (meta[e.name] && meta[e.name].email) || config.profiles[e.name]?.email || '',
      }));

    const zaloAccounts = loadZaloAccounts();

    res.json({ facebook: fbProfiles, zalo: zaloAccounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:key', (req, res) => {
  const { key } = req.params;
  const { name, email, password, saleworkName, type } = req.body;
  try {
    if (type === 'zalo') {
      const accounts = loadZaloAccounts();
      const idx = accounts.findIndex(a => a.key === key);
      if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy tài khoản Zalo' });
      accounts[idx] = { ...accounts[idx], name: name || accounts[idx].name, saleworkName: saleworkName || accounts[idx].saleworkName };
      saveZaloAccounts(accounts);
      return res.json({ success: true });
    }
    const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    meta[key] = { name, email: email || '', password: password || meta[key]?.password || '' };
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

app.get('/api/login-history', (req, res) => {
  const profile = req.query.profile || null;
  const limit = parseInt(req.query.limit) || 50;
  res.json(loginHistory.getHistory(profile, limit));
});

// ===== CHANNELS =====
const CHANNELS_FILE = path.resolve(__dirname, 'config/channels.json');

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  } catch {}
  return { fbGroups: [], zaloGroups: [], profileChannels: {} };
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
  const { key, id, name } = req.body;
  if (!key || !id || !name) return res.status(400).json({ error: 'Thiếu key, id hoặc name' });
  const data = loadChannels();
  if (data.fbGroups.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.fbGroups.push({ key, id, name });
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/fb-groups/:key', (req, res) => {
  const data = loadChannels();
  data.fbGroups = data.fbGroups.filter(g => g.key !== req.params.key);
  saveChannels(data);
  res.json({ success: true });
});

app.post('/api/channels/zalo-groups', (req, res) => {
  const { key, oid, name } = req.body;
  if (!key || !oid || !name) return res.status(400).json({ error: 'Thiếu key, oid hoặc name' });
  const data = loadChannels();
  if (!data.zaloGroups) data.zaloGroups = [];
  if (data.zaloGroups.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.zaloGroups.push({ key, oid, name });
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

// ===== SCREENSHOT =====
app.get('/api/screenshot', (req, res) => {
  const screenshotPath = path.resolve(__dirname, 'logs/latest-post.png');
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).json({ error: 'Không có screenshot' });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', machine: 'local', timestamp: new Date().toISOString() });
});

// ===== START =====
const PORT = process.env.LOCAL_PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Local Playwright server đang chạy: http://localhost:${PORT}`);
  logger.info(`Đang chờ lệnh từ server ai.basso.vn...`);
});

process.on('SIGINT', async () => {
  await playwright.closeBrowser();
  process.exit(0);
});
