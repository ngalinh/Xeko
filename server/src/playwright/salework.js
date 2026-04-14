const { chromium } = require('playwright');
const path = require('path');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');

let browserContext = null;
const USER_DATA_DIR = path.resolve(__dirname, '../../', config.salework.userDataDir);

/**
 * Khoi tao browser cho Salework
 */
async function getBrowser() {
  if (browserContext) {
    try {
      browserContext.pages();
      return browserContext;
    } catch {
      browserContext = null;
    }
  }

  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 500,
    viewport: { width: 1400, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  return browserContext;
}

/**
 * Dang nhap Salework neu chua dang nhap
 */
async function ensureLoggedIn(page) {
  const url = page.url();

  // Neu dang o trang login
  if (url.includes('/login')) {
    logger.info('Dang nhap Salework...');

    // Nhap username
    const usernameInput = await page.$('input[type="text"], input[placeholder*="tài khoản"], input[placeholder*="username"]');
    if (usernameInput) {
      await usernameInput.fill('');
      await usernameInput.fill(config.salework.username);
      await randomDelay(500, 1000);
    }

    // Nhap password
    const passInput = await page.$('input[type="password"]');
    if (passInput) {
      await passInput.fill('');
      await passInput.fill(config.salework.password);
      await randomDelay(500, 1000);
    }

    // Click Dang nhap
    const loginBtn = await page.$('button:has-text("Đăng nhập"), button:has-text("Login")');
    if (loginBtn) {
      await loginBtn.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await randomDelay(3000, 5000);
      logger.info('Dang nhap Salework thanh cong!');
    }
  }
}

/**
 * Vao trang Salework Zalo (truy cap thang zalo.salework.net)
 */
async function goToSaleworkZalo(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes('zalo.salework.net')) {
    await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(4000, 6000);
  }
}

/**
 * Chon profile Zalo
 */
async function selectZaloProfile(page, profileName) {
  logger.info(`Chon profile Zalo: ${profileName}`);

  // Click vao dropdown "Tat ca tai khoan"
  let clicked = false;
  try {
    // Tim o dropdown nam canh "Tin nhan" - click vao chinh no
    const dropdownSelectors = [
      'div.ant-select',
      '[class*="ant-select-selector"]',
      'span.ant-select-selection-item',
    ];

    for (const sel of dropdownSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ force: true });
        clicked = true;
        logger.info(`Click dropdown: ${sel}`);
        break;
      }
    }

    // Fallback: click bang text
    if (!clicked) {
      await page.click('text=Tất cả tài khoản', { force: true, timeout: 5000 });
      clicked = true;
      logger.info('Click dropdown bang text');
    }
  } catch (e) {
    logger.error(`Loi click dropdown: ${e.message}`);
  }

  await randomDelay(2000, 3000);

  // Chup screenshot sau khi click dropdown
  await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-zalo-after-dropdown.png') });

  // Chon profile - click bang JS de tranh loi "not visible"
  const selected = await page.evaluate((name) => {
    const els = document.querySelectorAll('div, span, li, a, [class*="option"], [class*="item"]');
    for (const el of els) {
      const text = el.textContent?.trim();
      if (text === name) {
        el.click();
        return true;
      }
    }
    return false;
  }, profileName);

  if (selected) {
    logger.info(`Da chon profile: ${profileName}`);
    await randomDelay(1000, 2000);

    // Click ra ngoai de dong dropdown
    await page.click('body', { position: { x: 600, y: 400 }, force: true });
    await randomDelay(1500, 2500);
    return true;
  }

  // Fallback: thu tim va click truc tiep
  try {
    await page.click(`text="${profileName}"`, { timeout: 5000 });
    logger.info(`Da chon profile (playwright click): ${profileName}`);
    await randomDelay(1000, 2000);

    // Click ra ngoai de dong dropdown
    await page.click('body', { position: { x: 600, y: 400 }, force: true });
    await randomDelay(1500, 2500);
    return true;
  } catch {}

  logger.error(`Khong tim thay profile: ${profileName}`);
  return false;
}

/**
 * Click vao tab Nhom (icon thu 4 trong hang icon filter)
 */
async function clickGroupTab(page) {
  // Chup screenshot de debug
  await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-zalo-tabs.png') });

  // Tim tab "Lien he" truoc de click vao do
  try {
    const lienhe = await page.$('text=Liên hệ');
    if (lienhe) {
      await lienhe.click({ force: true });
      await randomDelay(1000, 1500);
      logger.info('Click tab Lien he');
    }
  } catch {}

  await randomDelay(1000, 1500);

  // Tim hang icon filter - icon nhom la icon hinh 2 nguoi voi dau +
  // Thu click bang index: icon thu 4 (0-indexed: 3) trong hang icon
  try {
    // Tim tat ca icon/button trong khu vuc filter (duoi tab Lien he/Tin nhan)
    const filterIcons = await page.$$('div[class*="filter"] svg, div[class*="filter"] span, div[class*="tab"] svg');

    if (filterIcons.length > 0) {
      // Click icon thu 4 (index 3) - icon nhom
      for (const icon of filterIcons) {
        try {
          const parent = await icon.$('xpath=..');
          const title = await parent?.getAttribute('title').catch(() => '');
          const cls = await parent?.getAttribute('class').catch(() => '');
          logger.info(`Filter icon: title="${title}", class="${cls?.substring(0, 30)}"`);
        } catch {}
      }
    }
  } catch {}

  // Cach 1: Tim icon co title "Nhom" hoac tuong tu
  const iconSelectors = [
    '[title="Nhóm"]',
    '[title="Group"]',
    '[title*="nhóm"]',
    '[title*="group"]',
    '[data-type="group"]',
  ];

  for (const sel of iconSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ force: true });
        logger.info(`Click icon nhom: ${sel}`);
        await randomDelay(1500, 2500);
        return true;
      }
    } catch { continue; }
  }

  // Cach 2: Click bang vi tri - tim tat ca icon trong hang filter row
  // Icon nhom thuong la icon co 2 nguoi voi dau cong
  try {
    const clicked = await page.evaluate(() => {
      // Tim hang chua cac icon filter (duoi tab Lien he)
      const rows = document.querySelectorAll('div, span, ul');
      for (const row of rows) {
        const children = row.children;
        // Hang co 6-8 icon nho
        if (children.length >= 5 && children.length <= 10) {
          let allSmall = true;
          for (const child of children) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 50 || rect.height > 50) { allSmall = false; break; }
          }
          if (allSmall && children.length >= 5) {
            // Click icon thu 4 (index 3) - icon nhom
            const target = children[3];
            if (target) {
              target.click();
              return true;
            }
          }
        }
      }
      return false;
    });

    if (clicked) {
      logger.info('Click icon nhom bang vi tri (index 3)');
      await randomDelay(1500, 2500);
      return true;
    }
  } catch (e) {
    logger.error(`Loi click icon nhom: ${e.message}`);
  }

  // Cach 3: Tim svg icon co path giong icon 2 nguoi
  try {
    const svgs = await page.$$('svg');
    logger.info(`Tim thay ${svgs.length} svg icons`);

    // Icon nhom thuong la svg thu 4-5 trong khu vuc sidebar trai
    // Thu click tung svg de xem
    let svgIndex = 0;
    for (const svg of svgs) {
      const box = await svg.boundingBox();
      // Chi xet icon nho (< 30px) nam o khu vuc ben trai (x < 400) va giua trang (y: 250-350)
      if (box && box.width < 30 && box.height < 30 && box.x < 400 && box.y > 200 && box.y < 400) {
        svgIndex++;
        // Icon nhom la icon thu 3 hoac 4 trong hang nay
        if (svgIndex === 3 || svgIndex === 4) {
          await svg.click({ force: true });
          logger.info(`Click svg icon #${svgIndex} tai (${Math.round(box.x)}, ${Math.round(box.y)})`);
          await randomDelay(1500, 2500);
          return true;
        }
      }
    }
  } catch (e) {
    logger.error(`Loi tim svg: ${e.message}`);
  }

  await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-zalo-group-fail.png') });
  return false;
}

/**
 * Tim va click vao group
 */
async function searchAndClickGroup(page, groupName) {
  logger.info(`Tim nhom: ${groupName}`);

  // Tim o tim kiem
  const searchInput = await page.$('input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], input[placeholder*="Search"]');
  if (searchInput) {
    await searchInput.fill('');
    await searchInput.fill(groupName);
    await randomDelay(2000, 3000);
  }

  // Click vao ket qua tim kiem (group name)
  const results = await page.$$('div, span, li, a');
  for (const el of results) {
    const text = await el.textContent().catch(() => '');
    if (text.includes(groupName) && text.length < groupName.length + 50) {
      // Kiem tra co phai element clickable khong
      const tag = await el.evaluate(e => e.tagName).catch(() => '');
      await el.click();
      logger.info(`Click vao nhom: ${groupName}`);
      await randomDelay(2000, 3000);
      return true;
    }
  }

  logger.error(`Khong tim thay nhom: ${groupName}`);
  return false;
}

/**
 * Gui tin nhan vao group (text + hinh anh)
 */
async function sendMessage(page, message, imagePaths = []) {
  logger.info(`Gui tin nhan: "${message?.substring(0, 30)}..." + ${imagePaths.length} anh`);

  // Upload hinh anh truoc (neu co)
  if (imagePaths.length > 0) {
    // Tim icon hinh anh (thuong la icon thu 2 o thanh cong cu duoi)
    const imgIconSelectors = [
      'input[type="file"][accept*="image"]',
    ];

    // Thu tim input file truc tiep
    let uploaded = false;
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      try {
        await input.setInputFiles(imagePaths);
        uploaded = true;
        logger.info(`Upload ${imagePaths.length} anh thanh cong (direct)`);
        break;
      } catch { continue; }
    }

    // Fallback: click icon anh roi dung filechooser
    if (!uploaded) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            // Tim icon hinh anh (icon thu 2 tren toolbar)
            const toolbar = await page.$$('[class*="toolbar"] button, [class*="toolbar"] div[role="button"], [class*="action"] svg');
            for (const btn of toolbar) {
              const title = await btn.getAttribute('title').catch(() => '');
              if (title?.includes('nh') || title?.includes('image') || title?.includes('hoto')) {
                await btn.click();
                return;
              }
            }
            // Click icon hinh (vi tri thu 2 trong toolbar duoi)
            const icons = await page.$$('svg, [class*="icon"]');
            for (const icon of icons) {
              const parent = await icon.$('xpath=..');
              const title = await parent?.getAttribute('title').catch(() => '');
              if (title?.includes('Hình') || title?.includes('ảnh') || title?.includes('image')) {
                await icon.click();
                return;
              }
            }
          })(),
        ]);
        await fileChooser.setFiles(imagePaths);
        uploaded = true;
        logger.info(`Upload ${imagePaths.length} anh thanh cong (filechooser)`);
      } catch (e) {
        logger.error(`Loi upload anh: ${e.message}`);
      }
    }

    await randomDelay(2000, 3000);
  }

  // Nhap tin nhan
  if (message) {
    const msgInput = await page.$('[placeholder*="Nhập tin nhắn"], [placeholder*="nhập tin nhắn"], [contenteditable="true"], textarea');
    if (msgInput) {
      await msgInput.click();
      await randomDelay(300, 500);
      await msgInput.fill(message);
      logger.info('Da nhap tin nhan');
      await randomDelay(500, 1000);
    }
  }

  // Click nut Gui
  await randomDelay(1000, 2000);
  const sendSelectors = [
    'button:has-text("Gửi")',
    'button:has-text("Send")',
    '[class*="send"] button',
  ];

  for (const sel of sendSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        logger.info('Da click nut Gui');
        await randomDelay(2000, 3000);
        return true;
      }
    } catch { continue; }
  }

  // Fallback: Enter
  await page.keyboard.press('Enter');
  logger.info('Da gui bang Enter');
  await randomDelay(2000, 3000);
  return true;
}

/**
 * Dang bai Zalo qua Salework
 * Flow: Login -> Salework Zalo -> Chon profile -> Tab Nhom -> Tim nhom -> Gui tin nhan
 */
async function postToZaloGroup(profileName, groupName, message, imagePaths = []) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    logger.info(`=== Dang bai Zalo: profile=${profileName}, group=${groupName} ===`);

    // 1. Vao thang Salework Zalo
    await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(3000, 5000);

    // 2. Neu bi redirect ve trang login -> dang nhap
    if (page.url().includes('/login')) {
      await ensureLoggedIn(page);
      // Sau khi login, vao lai zalo.salework.net
      await page.goto('https://zalo.salework.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(4000, 6000);
    }

    await randomDelay(2000, 3000);

    // 4. Chon profile
    if (!(await selectZaloProfile(page, profileName))) {
      throw new Error(`Không tìm thấy profile: ${profileName}`);
    }

    // 5. Click tab Nhom
    if (!(await clickGroupTab(page))) {
      throw new Error('Không tìm thấy tab Nhóm');
    }

    // 6. Tim va click vao group
    if (!(await searchAndClickGroup(page, groupName))) {
      throw new Error(`Không tìm thấy nhóm: ${groupName}`);
    }

    // 7. Gui tin nhan
    const sent = await sendMessage(page, message, imagePaths);
    if (!sent) {
      throw new Error('Không gửi được tin nhắn');
    }

    logger.info(`Da gui tin nhan Zalo thanh cong! Profile: ${profileName}, Group: ${groupName}`);
    return { success: true, target: `Zalo:${groupName}`, profile: profileName };
  } catch (error) {
    logger.error(`Loi Zalo: ${error.message}`);
    await page.screenshot({ path: path.resolve(__dirname, '../../logs/debug-zalo.png') }).catch(() => {});
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

/**
 * Dong browser Salework
 */
async function closeBrowser() {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
  }
}

module.exports = { postToZaloGroup, closeBrowser };
