const { chromium } = require('playwright');
const path = require('path');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');

// Luu browser context theo profile: { linhthao: ctx, linhduong: ctx }
const browsers = {};

// Profile dang active
let activeProfile = null;
let activeProfileData = null;

/**
 * Chon profile
 */
function setProfile(profileName) {
  let profile = config.profiles[profileName];
  if (!profile) {
    // Check if profile dir exists in playwright-data (dynamically added profile)
    const profileDir = path.resolve(__dirname, `../../playwright-data/${profileName}`);
    if (require('fs').existsSync(profileDir)) {
      profile = {
        name: profileName,
        userDataDir: profileDir,
      };
    } else {
      throw new Error(`Profile "${profileName}" khong ton tai. Co: ${Object.keys(config.profiles).join(', ')}`);
    }
  }
  activeProfile = profileName;
  activeProfileData = profile;
  logger.info(`Da chon profile: ${profileName} (${profile.name})`);
  return profile;
}

function getActiveProfile() {
  if (!activeProfile) {
    throw new Error('Chua chon profile! Dung /linhthao hoac /linhduong truoc.');
  }
  return activeProfileData || config.profiles[activeProfile];
}

async function getBrowser() {
  const profile = getActiveProfile();
  const key = activeProfile;

  if (browsers[key]) {
    try {
      browsers[key].pages();
      return browsers[key];
    } catch {
      browsers[key] = null;
    }
  }

  const userDataDir = path.resolve(__dirname, '../../', profile.userDataDir);

  browsers[key] = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: config.playwright.slowMo,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  return browsers[key];
}

async function ensureLoggedIn(page) {
  const profile = getActiveProfile();
  const url = page.url();
  if (url.includes('login') || url.includes('checkpoint')) {
    logger.info(`Session het han, dang nhap lai (${profile.name})...`);
    const emailInput = await page.$('input[name="email"]');
    if (emailInput) {
      await emailInput.fill(profile.email);
      await randomDelay(500, 1000);
      await page.fill('input[name="pass"]', profile.password);
      await randomDelay(500, 1000);
      await page.click('button[name="login"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await randomDelay(3000, 5000);
    }
  }
}

async function tryClick(page, selectors, description, timeout = 5000) {
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.scrollIntoViewIfNeeded();
        await randomDelay(300, 800);
        await el.click({ force: true, timeout });
        logger.info(`${description}: ${selector}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  for (const selector of selectors) {
    try {
      const clicked = await page.evaluate((sel) => {
        const elements = document.querySelectorAll('div[role="button"], span, div[aria-label]');
        for (const el of elements) {
          const text = el.textContent?.trim();
          const label = el.getAttribute('aria-label');
          if (text === sel || label === sel) {
            el.click();
            return true;
          }
        }
        return false;
      }, selector.replace(/.*"(.+)".*/, '$1'));
      if (clicked) {
        logger.info(`${description} (JS click): ${selector}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function openCreatePost(page, isGroup = false) {
  // Đợi feed render xong trước khi tìm nút tạo bài
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const selectors = isGroup
    ? [
        '[aria-label*="Tạo bài viết"]',
        '[aria-label*="Create post"]',
        '[aria-label*="Create a post"]',
        'div[role="button"]:has-text("Bạn viết gì đi")',
        'div[role="button"]:has-text("viết gì đi")',
        'div[role="button"]:has-text("Viết gì đó")',
        'div[role="button"]:has-text("Bạn đang nghĩ gì")',
        'div[role="button"]:has-text("Write something")',
        'span:has-text("Bạn viết gì đi")',
        'span:has-text("viết gì đi")',
      ]
    : [
        '[aria-label*="Tạo bài viết"]',
        '[aria-label*="Create post"]',
        'div[role="button"]:has-text("đang nghĩ gì")',
        'div[role="button"]:has-text("on your mind")',
        'span:has-text("bạn đang nghĩ gì")',
        'span:has-text("đang nghĩ gì thế")',
        'span:has-text("đang nghĩ gì")',
        '[aria-label*="nghĩ gì"]',
        '[aria-label*="on your mind"]',
      ];

  return await tryClick(page, selectors, 'Mo popup tao bai');
}

async function typeMessage(page, message) {
  if (!message) return true;

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = 0);
  });
  await randomDelay(500, 1000);

  const selectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="mind"]',
    'div[contenteditable="true"][aria-label*="nghĩ"]',
  ];

  for (const selector of selectors) {
    try {
      const editors = await page.$$(selector);
      for (const editor of editors) {
        const isVisible = await editor.isVisible();
        if (!isVisible) continue;
        await editor.scrollIntoViewIfNeeded();
        await randomDelay(300, 600);
        await editor.click({ force: true });
        await randomDelay(500, 1000);
        for (const char of message) {
          await page.keyboard.type(char, { delay: Math.random() * 50 + 30 });
        }
        logger.info('Da nhap noi dung bai viet');
        return true;
      }
    } catch {
      continue;
    }
  }

  try {
    const placeholder = await page.$('div[role="dialog"] span:has-text("nghĩ gì")');
    if (placeholder) {
      await placeholder.click({ force: true });
      await randomDelay(500, 1000);
      for (const char of message) {
        await page.keyboard.type(char, { delay: Math.random() * 50 + 30 });
      }
      return true;
    }
  } catch {}

  return false;
}

async function attachImages(page, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return true;

  logger.info(`Dinh kem ${imagePaths.length} anh...`);
  let uploaded = false;

  // Tim nut Anh/Video trong popup
  const photoSelectors = [
    'div[aria-label="Ảnh/video"]',
    'div[aria-label="Photo/video"]',
    'div[aria-label="Ảnh/Video"]',
  ];

  // Cach 1: Click nut Anh/Video + bat filechooser (khong mo dialog)
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      (async () => {
        await randomDelay(500, 1000);
        for (const sel of photoSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.click({ force: true });
              logger.info(`Click nut anh: ${sel}`);
              return;
            }
          } catch { continue; }
        }
        // Fallback: tim trong thanh icon
        const icons = await page.$$('div[role="dialog"] div[role="button"]');
        for (const icon of icons) {
          const label = await icon.getAttribute('aria-label');
          if (label && (label.includes('nh') || label.includes('hoto') || label.includes('ideo'))) {
            await icon.click({ force: true });
            logger.info(`Click icon anh: ${label}`);
            return;
          }
        }
      })(),
    ]);

    await fileChooser.setFiles(imagePaths);
    uploaded = true;
    logger.info(`Upload ${imagePaths.length} anh thanh cong (filechooser)`);
  } catch (e) {
    logger.error(`Filechooser failed: ${e.message}`);
  }

  // Cach 2: Fallback - tim input[type=file] truc tiep
  if (!uploaded) {
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        logger.info(`Upload ${imagePaths.length} anh thanh cong (direct input)`);
        break;
      } catch { continue; }
    }
  }

  if (!uploaded) {
    logger.error('KHONG UPLOAD DUOC ANH!');
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-upload.png') });
  }

  await randomDelay(3000, 6000);
  return uploaded;
}

async function submitPost(page) {
  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  const step1 = await tryClick(page, [
    'div[aria-label="Tiếp"]',
    'div[aria-label="Next"]',
    'div[aria-label="Đăng"]',
    'div[aria-label="Post"]',
  ], 'Buoc 1');

  if (!step1) {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await randomDelay(200, 400);
    }
    await page.keyboard.press('Enter');
  }

  await randomDelay(2000, 4000);

  await page.evaluate(() => {
    document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = d.scrollHeight);
  });
  await randomDelay(1000, 1500);

  const step2 = await tryClick(page, [
    'div[aria-label="Đăng"]',
    'div[aria-label="Post"]',
  ], 'Buoc 2 - Dang');

  if (!step2) {
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('div[role="button"]');
      for (const btn of buttons) {
        if (btn.getAttribute('aria-label') === 'Đăng' || btn.getAttribute('aria-label') === 'Post') {
          btn.click();
          return;
        }
      }
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.trim() === 'Đăng' || span.textContent.trim() === 'Post') {
          span.closest('div[role="button"]')?.click();
          return;
        }
      }
    });
  }

  await randomDelay(5000, 8000);

  const stillOpen = await page.$('div[role="dialog"] span:has-text("Tạo bài viết")');
  if (stillOpen) {
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-failed.png') });
    return { success: false };
  }

  return { success: true };
}

/**
 * Chup screenshot bai viet cua profile dang active
 */

async function postToPersonal(message, imagePaths = []) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const profile = getActiveProfile();
    logger.info(`Dang bai len trang ca nhan (${profile.name})...`);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, false))) {
      await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-open.png') });
      throw new Error('Khong mo duoc popup tao bai.');
    }
    await randomDelay(2000, 3000);

    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (!imgOk) throw new Error('Khong upload duoc anh. Xem logs/debug-upload.png');
    }
    await randomDelay(1500, 2500);

    if (message && !(await typeMessage(page, message))) {
      throw new Error('Khong nhap duoc noi dung.');
    }
    await randomDelay(1000, 2000);

    const result = await submitPost(page);
    if (!result.success) {
      throw new Error('Khong dang duoc bai. Xem logs/debug-failed.png');
    }

    logger.info('Da dang bai ca nhan thanh cong!');
    return { success: true, target: 'personal' };
  } catch (error) {
    logger.error(`Loi: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function postToGroup(groupId, message, imagePaths = []) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const profile = getActiveProfile();
    logger.info(`Dang bai len group ${groupId} (${profile.name})...`);
    await page.goto(`https://www.facebook.com/groups/${groupId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);
    await ensureLoggedIn(page);

    if (!(await openCreatePost(page, true))) {
      await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-group-open.png') });
      throw new Error('Khong mo duoc popup tao bai group.');
    }
    await randomDelay(2000, 3000);

    // Dinh kem anh TRUOC
    if (imagePaths.length > 0) {
      const imgOk = await attachImages(page, imagePaths);
      if (!imgOk) throw new Error('Khong upload duoc anh. Xem logs/debug-upload.png');
    }
    await randomDelay(1500, 2500);

    // Nhap text SAU - group co 2 o: "Them tieu de" va "Tao bai viet..."
    // Can click vao o thu 2
    if (message) {
      await page.evaluate(() => {
        document.querySelectorAll('div[role="dialog"]').forEach(d => d.scrollTop = 0);
      });
      await randomDelay(500, 1000);

      let typed = false;
      try {
        // Tim tat ca textbox trong dialog, lay o thu 2 (o "Tao bai viet...")
        const editors = await page.$$('div[role="dialog"] div[contenteditable="true"][role="textbox"]');
        const targetEditor = editors.length >= 2 ? editors[1] : editors[0];
        if (targetEditor) {
          await targetEditor.scrollIntoViewIfNeeded();
          await targetEditor.click({ force: true });
          await randomDelay(500, 1000);
          for (const char of message) {
            await page.keyboard.type(char, { delay: Math.random() * 50 + 30 });
          }
          typed = true;
          logger.info('Da nhap noi dung group (o thu 2)');
        }
      } catch (e) {
        logger.error(`Loi nhap text group: ${e.message}`);
      }

      if (!typed) {
        // Fallback: dung typeMessage binh thuong
        await typeMessage(page, message);
      }
    }
    await randomDelay(1000, 2000);

    // Nhan Dang
    const result = await submitPost(page);
    if (!result.success) {
      throw new Error('Khong dang duoc bai group. Xem logs/debug-failed.png');
    }

    logger.info(`Da dang bai group ${groupId} thanh cong!`);
    return { success: true, target: `group:${groupId}` };
  } catch (error) {
    logger.error(`Loi: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  for (const key of Object.keys(browsers)) {
    if (browsers[key]) {
      await browsers[key].close();
      browsers[key] = null;
    }
  }
}

module.exports = { setProfile, getActiveProfile, postToPersonal, postToGroup, closeBrowser };
