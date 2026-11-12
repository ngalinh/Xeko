'use strict';
const { safeLaunch } = require('../utils/playwright-launch');

// RedNote (Xiaohongshu) là SPA — ảnh được JS render vào <meta property="og:image">
// (và lặp lại trong DOM bài viết) sau khi trang load, không có trong HTML tĩnh ban đầu.
async function fetchRednoteImages(url) {
  // headed (không headless) — để sếp xem trực tiếp trên VPS Windows lúc debug/chạy
  const browser = await safeLaunch({ headless: false, args: ['--start-maximized'] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await page.waitForTimeout(2000);

    const metaImages = await page.$$eval(
      'meta[property="og:image"]',
      (els) => els.map((el) => el.content).filter(Boolean)
    );
    if (metaImages.length > 0) return [...new Set(metaImages)];

    const domImages = await page.$$eval('img', (els) =>
      els.map((el) => el.src).filter((src) => /xhscdn\.com/.test(src))
    );
    return [...new Set(domImages)];
  } finally {
    await browser.close();
  }
}

module.exports = { fetchRednoteImages };
