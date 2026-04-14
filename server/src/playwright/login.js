const { chromium } = require('playwright');
const path = require('path');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');
const loginHistory = require('../utils/login-history');

const profileName = process.argv[2]; // node login.js linhthao

if (!profileName || !config.profiles[profileName]) {
  console.log('Usage: node login.js <profile>');
  console.log(`Profiles: ${Object.keys(config.profiles).join(', ')}`);
  process.exit(1);
}

const profile = config.profiles[profileName];
const USER_DATA_DIR = path.resolve(__dirname, '../../', profile.userDataDir);

async function login() {
  logger.info(`Dang nhap profile: ${profile.name} (${profileName})`);

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 800,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle' });

  const isLoggedIn = await page.$('[aria-label="Facebook"]') !== null
    || await page.$('[aria-label="Trang chủ"]') !== null;

  if (isLoggedIn) {
    logger.info('Da dang nhap san, session hop le!');
    loginHistory.addEntry(profileName, profile.name, 'login', 'Đã đăng nhập sẵn - session hợp lệ');
    await browser.close();
    return;
  }

  await page.fill('input[name="email"]', profile.email);
  await randomDelay(500, 1500);
  await page.fill('input[name="pass"]', profile.password);
  await randomDelay(500, 1000);
  await page.click('button[name="login"]');

  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 });

  const twoFactorInput = await page.$('input[name="approvals_code"]');
  if (twoFactorInput) {
    logger.info('Can nhap ma 2FA thu cong...');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 120000 });
  }

  logger.info(`Dang nhap ${profile.name} thanh cong! Session da luu.`);
  loginHistory.addEntry(profileName, profile.name, 'login', 'Đăng nhập thành công');
  await page.waitForTimeout(5000);
  await browser.close();
}

login().catch(console.error);
