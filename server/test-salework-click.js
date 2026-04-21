/**
 * Test script: thử từng cách click dropdown tài khoản trên zalo.salework.net
 * Chạy: node server/test-salework-click.js
 * Browser sẽ mở và tự thử 5 cách click, xem screenshot tại /tmp/salework-debug/
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SALEWORK_PROFILE = path.resolve(__dirname, '../playwright-data/salework');
const DEBUG_DIR = '/tmp/salework-debug';

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function ss(page, label) {
  const p = `${DEBUG_DIR}/${Date.now()}-TEST-${label}.png`;
  await page.screenshot({ path: p });
  console.log(`[screenshot] ${p}`);
}

async function isDropdownOpen(page) {
  return page.isVisible('input[placeholder*="tài khoản"]');
}

(async () => {
  const browser = await chromium.launchPersistentContext(SALEWORK_PROFILE, {
    headless: false,
    slowMo: 500,
    viewport: { width: 1280, height: 720 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://zalo.salework.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await ss(page, '00-loaded');

  console.log('\n=== Bắt đầu test click dropdown tài khoản ===\n');

  // Thử từng method, log kết quả
  const methods = [
    {
      name: 'Method 1: locator(.el-select__caret).click(force)',
      fn: async () => {
        await page.locator('.el-select__caret').first().click({ force: true, timeout: 3000 });
      },
    },
    {
      name: 'Method 2: locator(.el-select).first().click()',
      fn: async () => {
        await page.locator('.el-select').first().click({ timeout: 3000 });
      },
    },
    {
      name: 'Method 3: locator(.el-input__inner[readonly]).click()',
      fn: async () => {
        await page.locator('input.el-input__inner[readonly]').first().click({ timeout: 3000 });
      },
    },
    {
      name: 'Method 4: JS dispatchEvent click trên .el-select .el-input__inner',
      fn: async () => {
        await page.evaluate(() => {
          const el = document.querySelector('.el-select .el-input__inner');
          if (el) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        });
      },
    },
    {
      name: 'Method 5: locator(.el-select .el-input__suffix).click(force)',
      fn: async () => {
        await page.locator('.el-select .el-input__suffix').first().click({ force: true, timeout: 3000 });
      },
    },
    {
      name: 'Method 6: focus input rồi bấm ArrowDown',
      fn: async () => {
        await page.locator('.el-select .el-input__inner').first().click({ force: true, timeout: 3000 });
        await page.waitForTimeout(300);
        await page.keyboard.press('ArrowDown');
      },
    },
  ];

  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];

    // Đóng dropdown nếu đang mở trước khi thử method tiếp theo
    if (await isDropdownOpen(page)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    console.log(`\nThử: ${m.name}`);
    try {
      await m.fn();
      await page.waitForTimeout(800);
      const open = await isDropdownOpen(page);
      console.log(`  → Dropdown mở: ${open ? '✅ CÓ' : '❌ KHÔNG'}`);
      await ss(page, `M${i + 1}-${open ? 'OPEN' : 'CLOSED'}`);

      if (open) {
        console.log(`\n✅ METHOD ${i + 1} HOẠT ĐỘNG! Đang thử chọn tài khoản...`);

        // Log tất cả li items trong dropdown
        const items = await page.$$eval('li', els => els.map(e => e.textContent.trim()));
        console.log('  Các items trong dropdown:', items.filter(Boolean));

        // Thử click "Linh Thảo Us Authentic" nếu có
        const target = items.find(t => t.includes('Linh Thảo') || t.includes('Linh Thao'));
        if (target) {
          await page.locator('li').filter({ hasText: target }).first().click({ timeout: 3000 });
          await page.waitForTimeout(500);
          await ss(page, `M${i + 1}-SELECTED`);
          console.log(`  → Đã click: "${target}"`);
        }
        break;
      }
    } catch (e) {
      console.log(`  → Lỗi: ${e.message}`);
      await ss(page, `M${i + 1}-ERROR`);
    }
  }

  console.log('\n=== Test xong. Giữ browser mở 30 giây để kiểm tra ===');
  await page.waitForTimeout(30000);
  await browser.close();
  console.log('Browser đã đóng.');
})();
