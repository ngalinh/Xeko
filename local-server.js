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

const app = express();
app.use(express.json());

// ===== API KEY AUTH =====
const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';

app.use((req, res, next) => {
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
      const activeProfile = playwright.getActiveProfile();

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
app.post('/api/zalo/post', upload.array('images', 10), async (req, res) => {
  const { profile, groupName, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!profile || !groupName) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu profile hoặc tên nhóm' });
  }

  try {
    const result = await salework.postToZaloGroup(profile, groupName, message, imagePaths);
    cleanupFiles(imagePaths);
    res.json(result);
  } catch (error) {
    cleanupFiles(imagePaths);
    res.status(500).json({ error: error.message });
  }
});

// ===== ĐĂNG FB + ZALO =====
app.post('/api/fb_zalo', upload.array('images', 10), async (req, res) => {
  const { message, fbProfile } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  const config = require('./config/default');
  const fbToZalo = { linhthao: 'Linh Thảo Us Authentic', linhduong: 'Linh Duong Us' };
  const zaloGroups = {
    'Linh Thảo Us Authentic': ['SỈ HÀNG ORDER MỸ - LINH THẢO', 'TỔNG KHO HÀNG SẴN US - LINH THẢO', 'DEAL NGON MỸ PHẨM US'],
    'Linh Duong Us': ['Sỉ Hàng Order Mỹ, Anh - Linh Dương', 'KHO HÀNG MỸ CÓ SẴN - LINH DƯƠNG', 'SĂN SALE HÀNG HIỆU US'],
  };

  const results = [];
  try {
    const r = await playwright.postToPersonal(message, imagePaths);
    results.push({ target: 'FB Cá nhân', success: r.success, error: r.error });
    await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));

    const groups = Object.values(config.groups);
    for (const group of groups) {
      const gr = await playwright.postToGroup(group.id, message, imagePaths);
      results.push({ target: `FB:${group.name}`, success: gr.success, error: gr.error });
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
    }

    const zaloProfileName = fbToZalo[fbProfile || Object.keys(fbToZalo)[0]] || 'Linh Thảo Us Authentic';
    const zaloGroupList = zaloGroups[zaloProfileName] || [];
    for (const groupName of zaloGroupList) {
      const zr = await salework.postToZaloGroup(zaloProfileName, groupName, message, imagePaths);
      results.push({ target: `Zalo:${groupName}`, success: zr.success, error: zr.error });
      await new Promise(r => setTimeout(r, 20000 + Math.random() * 20000));
    }

    cleanupFiles(imagePaths);
    return res.json({ results });
  } catch (error) {
    cleanupFiles(imagePaths);
    return res.status(500).json({ error: error.message });
  }
});

// ===== ACCOUNTS =====
app.post('/api/accounts', (req, res) => {
  const { type, key, name, email, password } = req.body;
  if (!key || !name) return res.status(400).json({ error: 'Thiếu key hoặc tên' });

  // Respond ngay truoc khi launch Chromium — browser khoi dong + goto
  // facebook.com co the mat >30s va Cloudflare tunnel cut o 60s. Neu cho
  // launch xong moi res.json() thi client nhan 504 Gateway Timeout ngay ca
  // khi Chromium van mo thanh cong o may local.
  res.json({ success: true, message: `Đang mở Chromium cho "${name}". Chờ cửa sổ hiện ra để đăng nhập.` });

  (async () => {
    try {
      const { chromium } = require('playwright');
      const profileDir = path.resolve(__dirname, `playwright-data/${type === 'zalo' ? 'salework' : key}`);
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      const browser = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1280, height: 720 },
      });
      const page = browser.pages()[0] || await browser.newPage();
      await page.goto(type === 'zalo' ? 'https://zalo.salework.net' : 'https://www.facebook.com/', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });

      if (type === 'facebook' && email && password) {
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
      const data = readChannels();
      data.zaloProfiles = (data.zaloProfiles || []).filter(p => p.name !== key);
      saveChannels(data);
    } else {
      return res.status(400).json({ error: 'Loại không hợp lệ' });
    }
    loginHistory.addEntry(key, key, 'delete', 'Đã xoá profile');
    res.json({ success: true, message: `Đã xoá profile "${key}"` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts', (req, res) => {
  const dataDir = path.resolve(__dirname, 'playwright-data');
  const config = require('./config/default');
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing', 'salework',
  ];
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    const fbProfiles = entries
      .filter(e => e.isDirectory() && !knownNonProfiles.includes(e.name) && !e.name.startsWith('.'))
      .map(e => ({
        key: e.name,
        name: config.profiles[e.name]?.name || e.name,
        email: config.profiles[e.name]?.email || '',
      }));

    // Zalo profiles: doc tu channels.json (quan ly qua tab "Cai dat kenh")
    // thay vi hardcode. Empty neu chua co file hoac chua co profile nao.
    let zaloProfiles = [];
    try {
      const ch = readChannels();
      zaloProfiles = (ch.zaloProfiles || []).map(p => ({ name: p.name }));
    } catch (e) {
      logger.error(`Loi doc channels.json: ${e.message}`);
    }

    res.json({ facebook: fbProfiles, zalo: zaloProfiles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:key', (req, res) => {
  const { key } = req.params;
  const { name, email, password } = req.body;
  const metaFile = path.resolve(__dirname, 'config/profiles-meta.json');
  try {
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

// ===== SCREENSHOT =====
app.get('/api/screenshot', (req, res) => {
  const screenshotPath = path.resolve(__dirname, 'logs/latest-post.png');
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).json({ error: 'Không có screenshot' });
  }
});

// ===== CHANNELS CONFIG =====
const CHANNELS_FILE = path.resolve(__dirname, 'config/channels.json');

function readChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    // Auto-populate from config/default.js on first use
    try {
      const cfg = require('./config/default');
      const fbGroups = Object.entries(cfg.groups || {}).map(([key, g]) => ({ key, id: g.id, name: g.name }));
      return { fbGroups, zaloProfiles: [], profileChannels: {} };
    } catch { return { fbGroups: [], zaloProfiles: [], profileChannels: {} }; }
  }
  return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
}

function saveChannels(data) {
  const dir = path.dirname(CHANNELS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/channels', (req, res) => res.json(readChannels()));

app.post('/api/channels/fb-groups', (req, res) => {
  const { key, id, name } = req.body;
  if (!key || !id || !name) return res.status(400).json({ error: 'Thiếu key, id, hoặc name' });
  const data = readChannels();
  if (data.fbGroups.find(g => g.key === key)) return res.status(400).json({ error: 'Key đã tồn tại' });
  data.fbGroups.push({ key, id, name });
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/fb-groups/:key', (req, res) => {
  const { key } = req.params;
  const data = readChannels();
  data.fbGroups = data.fbGroups.filter(g => g.key !== key);
  saveChannels(data);
  res.json({ success: true });
});

app.post('/api/channels/zalo-profiles', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Thiếu tên profile' });
  const data = readChannels();
  if (data.zaloProfiles.find(p => p.name === name)) return res.status(400).json({ error: 'Profile đã tồn tại' });
  data.zaloProfiles.push({ name, groups: [] });
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/zalo-profiles/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const data = readChannels();
  data.zaloProfiles = data.zaloProfiles.filter(p => p.name !== name);
  saveChannels(data);
  res.json({ success: true });
});

app.post('/api/channels/zalo-groups', (req, res) => {
  const { profileName, groupName } = req.body;
  if (!profileName || !groupName) return res.status(400).json({ error: 'Thiếu thông tin' });
  const data = readChannels();
  const profile = data.zaloProfiles.find(p => p.name === profileName);
  if (!profile) return res.status(404).json({ error: 'Profile không tồn tại' });
  if (!profile.groups.includes(groupName)) profile.groups.push(groupName);
  saveChannels(data);
  res.json({ success: true });
});

app.delete('/api/channels/zalo-groups', (req, res) => {
  const { profileName, groupName } = req.body;
  const data = readChannels();
  const profile = data.zaloProfiles.find(p => p.name === profileName);
  if (profile) profile.groups = profile.groups.filter(g => g !== groupName);
  saveChannels(data);
  res.json({ success: true });
});

app.put('/api/channels/profile-channels', (req, res) => {
  const { profileChannels } = req.body;
  const data = readChannels();
  data.profileChannels = profileChannels || {};
  saveChannels(data);
  res.json({ success: true });
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
