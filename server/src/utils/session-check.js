const { safeLaunchPersistentContext } = require('./playwright-launch');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const loginHistory = require('./login-history');
const { getFbProxyForProfile } = require('./proxy');

const PLAYWRIGHT_DATA_DIR = path.resolve(__dirname, '../../playwright-data');
const META_FILE = path.resolve(__dirname, '../../config/profiles-meta.json');
const KNOWN_NON_PROFILES = new Set([
  'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache',
  'ShaderCache', 'Variations', 'component_crx_cache', 'extensions_crx_cache',
  'segmentation_platform', 'Safe Browsing',
]);

function listFbProfiles() {
  const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : {};
  if (!fs.existsSync(PLAYWRIGHT_DATA_DIR)) return [];
  return fs.readdirSync(PLAYWRIGHT_DATA_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()
      && !KNOWN_NON_PROFILES.has(e.name)
      && !e.name.startsWith('.')
      && !e.name.startsWith('salework')
      && !e.name.includes('.'))
    .map(e => ({
      key: e.name,
      name: meta[e.name]?.name || e.name,
      userDataDir: path.join(PLAYWRIGHT_DATA_DIR, e.name),
    }));
}

async function checkAllSessions() {
  const results = [];
  for (const profile of listFbProfiles()) {
    const result = await checkSession(profile.key, profile);
    results.push(result);
  }
  return results;
}

async function checkSession(profileKey, profile) {
  const userDataDir = profile.userDataDir;

  let browser = null;
  try {
    const proxy = getFbProxyForProfile(profileKey, profile);
    browser = await safeLaunchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ...(proxy ? { proxy } : {}),
    });

    const page = await browser.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const url = page.url();

    // Kiểm tra có bị redirect về trang login không
    if (url.includes('login') || url.includes('checkpoint') || url.includes('recover')) {
      logger.info(`Session ${profile.name}: HẾT HẠN`);
      loginHistory.addEntry(profileKey, profile.name, 'session_expired', 'Session hết hạn');
      await page.close();
      await browser.close();
      return {
        profile: profileKey,
        name: profile.name,
        status: 'expired',
        message: 'Session hết hạn - cần đăng nhập lại',
      };
    }

    // Kiểm tra có thấy element của trang chủ không
    const isLoggedIn = await page.evaluate(() => {
      // Tìm các dấu hiệu đã đăng nhập
      return document.querySelector('[aria-label="Facebook"]') !== null ||
        document.querySelector('[aria-label="Trang chủ"]') !== null ||
        document.querySelector('[aria-label="Home"]') !== null ||
        document.querySelector('[role="banner"]') !== null ||
        document.querySelector('div[data-pagelet="Stories"]') !== null;
    });

    await page.close();
    await browser.close();

    if (isLoggedIn) {
      logger.info(`Session ${profile.name}: OK`);
      loginHistory.addEntry(profileKey, profile.name, 'session_check', 'Session OK');
      return {
        profile: profileKey,
        name: profile.name,
        status: 'active',
        message: 'Session hoạt động bình thường',
      };
    } else {
      logger.info(`Session ${profile.name}: KHÔNG XÁC ĐỊNH`);
      loginHistory.addEntry(profileKey, profile.name, 'session_check', 'Không xác định');
      return {
        profile: profileKey,
        name: profile.name,
        status: 'unknown',
        message: 'Không xác định được trạng thái - kiểm tra thủ công',
      };
    }
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    logger.error(`Lỗi kiểm tra session ${profile.name}: ${error.message}`);
    return {
      profile: profileKey,
      name: profile.name,
      status: 'error',
      message: `Lỗi kiểm tra: ${error.message}`,
    };
  }
}

module.exports = { checkAllSessions, checkSession };
