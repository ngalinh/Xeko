const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('./config/default');
const logger = require('./src/utils/logger');
const playwright = process.env.PLAYWRIGHT_LOCAL_URL
  ? require('./playwright-proxy')
  : require('./src/playwright/post');
const postLogger = require('./src/database/post-logger');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// Multer: luu anh upload vao temp/
const TEMP_DIR = path.resolve(__dirname, '../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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
    else cb(new Error('Chi chap nhan file anh'));
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
app.post('/api/profile', (req, res) => {
  const { profile } = req.body;
  try {
    const p = playwright.setProfile(profile);
    res.json({ success: true, name: p.name || profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Dang bai
app.post('/api/post', upload.array('images', 10), async (req, res) => {
  checkDailyReset();

  const { message, target, groupId } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  // Kiem tra profile
  try {
    playwright.getActiveProfile();
  } catch {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chua chon profile!' });
  }

  if (postCount >= config.posting.maxPostsPerDay) {
    cleanupFiles(imagePaths);
    return res.json({ error: `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.` });
  }

  try {
    // Dang len ca nhan + tat ca group
    if (target === 'all') {
      const results = [];

      // Dang FB ca nhan truoc
      const activeProfile = playwright.getActiveProfile();
      if (postCount < config.posting.maxPostsPerDay) {
        logger.info('Dang len FB ca nhan...');
        const result = await playwright.postToPersonal(message, imagePaths);
        postCount++;
        postLogger.logPost({ profile: activeProfile.key, profileName: activeProfile.name, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
        results.push({
          target: 'FB Cá nhân',
          success: result.success,
          postUrl: result.postUrl,
          screenshot: !!result.screenshot,
          error: result.error,
        });

        const delay = Math.floor(Math.random() * 30000) + 30000;
        await new Promise(r => setTimeout(r, delay));
      }

      // Dang len cac group
      const groups = Object.values(config.groups);
      for (const group of groups) {
        if (postCount >= config.posting.maxPostsPerDay) break;

        logger.info(`Dang len ${group.name}...`);
        const result = await playwright.postToGroup(group.id, message, imagePaths);
        postCount++;
        postLogger.logPost({ profile: activeProfile.key, profileName: activeProfile.name, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
        results.push({
          target: group.name,
          success: result.success,
          postUrl: result.postUrl,
          screenshot: !!result.screenshot,
          error: result.error,
        });

        if (groups.indexOf(group) < groups.length - 1) {
          const delay = Math.floor(Math.random() * 30000) + 30000;
          await new Promise(r => setTimeout(r, delay));
        }
      }

      cleanupFiles(imagePaths);
      return res.json({ results });
    }

    // Dang len FB + Zalo (tat ca)
    if (target === 'fb_zalo') {
      const results = [];
      const fbToZalo = { linhthao: 'Linh Thảo Us Authentic', linhduong: 'Linh Duong Us' };
      const zaloGroups = {
        'Linh Thảo Us Authentic': ['SỈ HÀNG ORDER MỸ - LINH THẢO', 'TỔNG KHO HÀNG SẴN US - LINH THẢO', 'DEAL NGON MỸ PHẨM US'],
        'Linh Duong Us': ['Sỉ Hàng Order Mỹ, Anh - Linh Dương', 'KHO HÀNG MỸ CÓ SẴN - LINH DƯƠNG', 'SĂN SALE HÀNG HIỆU US'],
      };

      // 1. Dang FB ca nhan
      let fbZaloProfile;
      try { fbZaloProfile = playwright.getActiveProfile(); } catch {}
      if (postCount < config.posting.maxPostsPerDay) {
        logger.info('FB+Zalo: Dang FB ca nhan...');
        const r = await playwright.postToPersonal(message, imagePaths);
        postCount++;
        postLogger.logPost({ profile: fbZaloProfile?.key || 'unknown', profileName: fbZaloProfile?.name, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web' });
        results.push({ target: 'FB Cá nhân', success: r.success, error: r.error });
        await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      }

      // 2. Dang FB groups
      const fbGroups = Object.values(config.groups);
      for (const group of fbGroups) {
        if (postCount >= config.posting.maxPostsPerDay) break;
        logger.info(`FB+Zalo: Dang FB group ${group.name}...`);
        const r = await playwright.postToGroup(group.id, message, imagePaths);
        postCount++;
        postLogger.logPost({ profile: fbZaloProfile?.key || 'unknown', profileName: fbZaloProfile?.name, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: r.success, error: r.error, postUrl: r.postUrl, source: 'web' });
        results.push({ target: `FB:${group.name}`, success: r.success, error: r.error });
        await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      }

      // 3. Dang Zalo groups
      const zaloProfileName = fbToZalo[req.body.fbProfile || Object.keys(fbToZalo)[0]] || 'Linh Thảo Us Authentic';
      const zaloGroupList = zaloGroups[zaloProfileName] || [];

      for (const groupName of zaloGroupList) {
        logger.info(`FB+Zalo: Dang Zalo ${groupName}...`);
        const r = await salework.postToZaloGroup(zaloProfileName, groupName, message, imagePaths);
        postLogger.logPost({ profile: zaloProfileName, profileName: zaloProfileName, platform: 'zalo', target: 'group', groupName, message, imageCount: imagePaths.length, success: r.success, error: r.error, source: 'web' });
        results.push({ target: `Zalo:${groupName}`, success: r.success, error: r.error });
        await new Promise(r => setTimeout(r, 20000 + Math.random() * 20000));
      }

      cleanupFiles(imagePaths);
      return res.json({ results });
    }

    // Dang len tat ca group
    if (target === 'allgroup') {
      const groups = Object.values(config.groups);
      const results = [];
      const agProfile = playwright.getActiveProfile();

      for (const group of groups) {
        if (postCount >= config.posting.maxPostsPerDay) break;

        logger.info(`Dang len ${group.name}...`);
        const result = await playwright.postToGroup(group.id, message, imagePaths);
        postCount++;
        postLogger.logPost({ profile: agProfile.key, profileName: agProfile.name, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
        results.push({
          target: group.name,
          success: result.success,
          postUrl: result.postUrl,
          screenshot: !!result.screenshot,
          error: result.error,
        });

        // Delay giua cac group
        if (groups.indexOf(group) < groups.length - 1) {
          const delay = Math.floor(Math.random() * 30000) + 30000;
          await new Promise(r => setTimeout(r, delay));
        }
      }

      cleanupFiles(imagePaths);
      return res.json({ results });
    }

    // Dang len group shortcut (asale, tongkho)
    if (target === 'shortcut') {
      const group = config.groups[groupId];
      if (!group) {
        cleanupFiles(imagePaths);
        return res.status(400).json({ error: `Group "${groupId}" khong ton tai` });
      }

      const result = await playwright.postToGroup(group.id, message, imagePaths);
      postCount++;
      const scProfile = playwright.getActiveProfile();
      postLogger.logPost({ profile: scProfile.key, profileName: scProfile.name, platform: 'facebook', target: 'group', groupName: group.name, groupId: group.id, message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
      cleanupFiles(imagePaths);
      return res.json({
        success: result.success,
        postUrl: result.postUrl,
        screenshot: !!result.screenshot,
        error: result.error,
      });
    }

    // Dang len group (custom ID)
    if (target === 'group') {
      const result = await playwright.postToGroup(groupId, message, imagePaths);
      postCount++;
      const gProfile = playwright.getActiveProfile();
      postLogger.logPost({ profile: gProfile.key, profileName: gProfile.name, platform: 'facebook', target: 'group', groupId, message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
      cleanupFiles(imagePaths);
      return res.json({
        success: result.success,
        postUrl: result.postUrl,
        screenshot: !!result.screenshot,
        error: result.error,
      });
    }

    // Dang len ca nhan
    const result = await playwright.postToPersonal(message, imagePaths);
    postCount++;
    const pProfile = playwright.getActiveProfile();
    postLogger.logPost({ profile: pProfile.key, profileName: pProfile.name, platform: 'facebook', target: 'personal', message, imageCount: imagePaths.length, success: result.success, error: result.error, postUrl: result.postUrl, source: 'web' });
    cleanupFiles(imagePaths);
    return res.json({
      success: result.success,
      postUrl: result.postUrl,
      screenshot: !!result.screenshot,
      error: result.error,
    });

  } catch (error) {
    cleanupFiles(imagePaths);
    logger.error(`Loi: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

// Lay screenshot moi nhat
app.get('/api/screenshot', (req, res) => {
  const screenshotPath = path.resolve(__dirname, '../logs/latest-post.png');
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).json({ error: 'Khong co screenshot' });
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

// === Zalo API ===
const salework = require('./src/playwright/salework');

app.post('/api/zalo/post', upload.array('images', 10), async (req, res) => {
  const { profile, groupName, message } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!profile || !groupName) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Thiếu profile hoặc tên nhóm' });
  }

  try {
    const result = await salework.postToZaloGroup(profile, groupName, message, imagePaths);
    postLogger.logPost({ profile, profileName: profile, platform: 'zalo', target: 'group', groupName, message, imageCount: imagePaths.length, success: result.success, error: result.error, source: 'web' });
    cleanupFiles(imagePaths);
    res.json(result);
  } catch (error) {
    postLogger.logPost({ profile, profileName: profile, platform: 'zalo', target: 'group', groupName, message, imageCount: imagePaths.length, success: false, error: error.message, source: 'web' });
    cleanupFiles(imagePaths);
    res.status(500).json({ error: error.message });
  }
});

// === Session Check API ===
const sessionCheck = require('./src/utils/session-check');

const loginHistory = require('./src/utils/login-history');

// Them tai khoan moi + mo trinh duyet de login thu cong
app.post('/api/accounts', async (req, res) => {
  const { type, key, name, email, password } = req.body;

  if (!key || !name) {
    return res.status(400).json({ error: 'Thiếu tên profile hoặc tên hiển thị' });
  }

  // Neu dang chay o che do proxy (remote server), forward sang local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const getFetch = async () => {
        if (typeof fetch !== 'undefined') return fetch;
        const { default: nodeFetch } = await import('node-fetch');
        return nodeFetch;
      };
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ type, key, name, email, password }),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  if (type === 'facebook') {
    // Tao thu muc profile moi
    const profileDir = path.resolve(__dirname, `../playwright-data/${key}`);
    if (!require('fs').existsSync(profileDir)) {
      require('fs').mkdirSync(profileDir, { recursive: true });
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

      // Neu co email/pass thi dien san
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

      // Doi trinh duyet dong (user dong thu cong)
      browser.on('close', () => {
        loginHistory.addEntry(key, name, 'login', 'Đã đóng trình duyệt - session được lưu');
        logger.info(`Profile ${name}: da dong trinh duyet, session luu tai ${profileDir}`);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else if (type === 'zalo') {
    // Mo Salework de login
    try {
      const { chromium } = require('playwright');
      const profileDir = path.resolve(__dirname, '../playwright-data/salework');
      if (!require('fs').existsSync(profileDir)) {
        require('fs').mkdirSync(profileDir, { recursive: true });
      }

      const browser = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        slowMo: 500,
        viewport: { width: 1400, height: 800 },
      });

      const page = browser.pages()[0] || await browser.newPage();
      await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });

      loginHistory.addEntry(key, name, 'login', 'Mở Salework Zalo đăng nhập thủ công');

      res.json({
        success: true,
        message: `Đã mở Chromium cho Salework Zalo. Hãy đăng nhập trên trình duyệt, sau đó đóng lại.`,
      });

      browser.on('close', () => {
        loginHistory.addEntry(key, name, 'login', 'Đã đóng trình duyệt Salework');
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

  // Neu dang chay o che do proxy, forward sang local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const getFetch = async () => {
        if (typeof fetch !== 'undefined') return fetch;
        const { default: nodeFetch } = await import('node-fetch');
        return nodeFetch;
      };
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

  const rimraf = require('fs');

  try {
    let profileDir;
    if (type === 'facebook') {
      profileDir = path.resolve(__dirname, `../playwright-data/${key}`);
    } else if (type === 'zalo') {
      // Zalo dung chung 1 thu muc salework, khong xoa
      loginHistory.addEntry(key, key, 'delete', 'Xoá profile Zalo (chỉ xoá khỏi danh sách)');
      return res.json({ success: true, message: `Đã xoá profile Zalo "${key}" khỏi danh sách` });
    } else {
      return res.status(400).json({ error: 'Loại không hợp lệ' });
    }

    // Xoa thu muc chromium profile
    if (rimraf.existsSync(profileDir)) {
      rimraf.rmSync(profileDir, { recursive: true, force: true });
      logger.info(`Da xoa profile dir: ${profileDir}`);
    }

    loginHistory.addEntry(key, key, 'delete', `Đã xoá profile và dữ liệu session`);
    res.json({ success: true, message: `Đã xoá profile "${key}" và dữ liệu session` });
  } catch (e) {
    logger.error(`Loi xoa profile: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Lay danh sach profiles tu thu muc playwright-data
app.get('/api/accounts', async (req, res) => {
  // Neu dang chay o che do proxy, lay tu local server
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const getFetch = async () => {
        if (typeof fetch !== 'undefined') return fetch;
        const { default: nodeFetch } = await import('node-fetch');
        return nodeFetch;
      };
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts`, {
        headers: { 'x-api-key': API_KEY },
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  const dataDir = path.resolve(__dirname, '../playwright-data');
  const knownNonProfiles = [
    'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
    'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
    'segmentation_platform', 'Safe Browsing', 'salework',
  ];
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    const fbProfiles = entries
      .filter(e => e.isDirectory() && !knownNonProfiles.includes(e.name) && !e.name.startsWith('.'))
      .filter(e => !e.name.includes('.') && e.name !== 'salework')
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

    const zaloProfiles = [];
    if (fs.existsSync(path.join(dataDir, 'salework'))) {
      // Zalo profiles from known list (managed via Salework)
      const knownZalo = ['Basso Order Hàng Mỹ', 'Linh Duong Us', 'Linh Thảo Us Authentic', 'Shipus Mua Hàng Mỹ'];
      knownZalo.forEach(name => zaloProfiles.push({ name }));
    }

    res.json({ facebook: fbProfiles, zalo: zaloProfiles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Luu thong tin profile dong vao file JSON
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

// Cap nhat thong tin profile
app.put('/api/accounts/:key', async (req, res) => {
  const { key } = req.params;
  const { name, email, password } = req.body;

  if (!name) return res.status(400).json({ error: 'Thiếu tên hiển thị' });

  // Proxy sang local server de dong bo voi GET /api/accounts
  if (getLocalUrl()) {
    try {
      const LOCAL_URL = getLocalUrl();
      const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
      const getFetch = async () => {
        if (typeof fetch !== 'undefined') return fetch;
        const { default: nodeFetch } = await import('node-fetch');
        return nodeFetch;
      };
      const fetchFn = await getFetch();
      const response = await fetchFn(`${LOCAL_URL}/api/accounts/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: `Không thể kết nối local server: ${e.message}` });
    }
  }

  try {
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
      const getFetch = async () => {
        if (typeof fetch !== 'undefined') return fetch;
        const { default: nodeFetch } = await import('node-fetch');
        return nodeFetch;
      };
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

// Len lich dang bai
app.post('/api/schedule', upload.array('images', 10), (req, res) => {
  const { time, target, groupId, message, profile, type, groupName } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!profile) {
    cleanupFiles(imagePaths);
    return res.status(400).json({ error: 'Chưa chọn profile' });
  }

  try {
    const job = scheduler.addSchedule({ time, target, groupId, message, imagePaths, profile, type, groupName });
    res.json({
      success: true,
      message: `Đã lên lịch đăng bài lúc ${job.time.toLocaleString('vi-VN')}`,
      id: job.id,
    });
  } catch (e) {
    cleanupFiles(imagePaths);
    res.status(400).json({ error: e.message });
  }
});

// Xem danh sach lich
app.get('/api/schedules', (req, res) => {
  res.json(scheduler.getSchedules());
});

// Xoa lich
app.delete('/api/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (scheduler.removeSchedule(id)) {
    res.json({ success: true, message: `Đã xoá lịch #${id}` });
  } else {
    res.status(404).json({ error: 'Không tìm thấy lịch' });
  }
});

// Polling notifications (lich da chay xong)
app.get('/api/notifications', (req, res) => {
  res.json(scheduler.getNotifications());
});

// Serve anh tu temp/schedule folders
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
  const { profile, platform, success, from, to, limit, offset } = req.query;
  try {
    const result = postLogger.getPostHistory({
      profile, platform,
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

app.get('/api/statistics', (req, res) => {
  const { from, to } = req.query;
  try {
    const stats = postLogger.getStatistics({ from, to });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== CHANNELS PROXY =====
async function proxyToLocal(req, res, method, path, body = null) {
  const LOCAL_URL = getLocalUrl();
  if (!LOCAL_URL) return res.status(503).json({ error: 'Local server chưa kết nối' });
  try {
    const getFetch = async () => {
      if (typeof fetch !== 'undefined') return fetch;
      const { default: nodeFetch } = await import('node-fetch');
      return nodeFetch;
    };
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
app.delete('/api/channels/fb-groups/:key', (req, res) => proxyToLocal(req, res, 'DELETE', `/api/channels/fb-groups/${req.params.key}`));
app.post('/api/channels/zalo-profiles', (req, res) => proxyToLocal(req, res, 'POST', '/api/channels/zalo-profiles', req.body));
app.delete('/api/channels/zalo-profiles/:name', (req, res) => proxyToLocal(req, res, 'DELETE', `/api/channels/zalo-profiles/${req.params.name}`));
app.post('/api/channels/zalo-groups', (req, res) => proxyToLocal(req, res, 'POST', '/api/channels/zalo-groups', req.body));
app.delete('/api/channels/zalo-groups', (req, res) => proxyToLocal(req, res, 'DELETE', '/api/channels/zalo-groups', req.body));
app.put('/api/channels/profile-channels', (req, res) => proxyToLocal(req, res, 'PUT', '/api/channels/profile-channels', req.body));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Local server tu dang ky URL tunnel moi khi khoi dong
let dynamicLocalUrl = process.env.PLAYWRIGHT_LOCAL_URL || null;

app.post('/api/register-local', (req, res) => {
  const { url } = req.body;
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== (process.env.LOCAL_API_KEY || 'change-this-secret-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!url) return res.status(400).json({ error: 'Missing url' });
  dynamicLocalUrl = url;
  logger.info(`Local server da dang ky URL moi: ${url}`);
  res.json({ success: true, message: `Đã cập nhật URL: ${url}` });
});

// Override PLAYWRIGHT_LOCAL_URL bang dynamicLocalUrl neu co
function getLocalUrl() {
  return dynamicLocalUrl || process.env.PLAYWRIGHT_LOCAL_URL;
}

app.listen(config.server.port, () => {
  logger.info(`Web server dang chay: http://localhost:${config.server.port}`);
});

process.on('SIGINT', async () => {
  await playwright.closeBrowser();
  process.exit(0);
});
