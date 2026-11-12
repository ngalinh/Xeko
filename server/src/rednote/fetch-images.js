'use strict';
const { safeLaunch } = require('../utils/playwright-launch');

// RedNote (Xiaohongshu) là SPA — ảnh được JS render vào <meta property="og:image">
// (và lặp lại trong DOM bài viết) sau khi trang load, không có trong HTML tĩnh ban đầu.
// Ngân sách thời gian phải nằm dưới 30s (giới hạn AbortSignal.timeout của
// playwright-proxy.callLocal khi cloud proxy request này về VPS Windows).
//
// Trả về { images, debug } thay vì chỉ mảng ảnh — debug cho biết mỗi tầng
// (meta/img domain/img size/css background) tìm ra bao nhiêu, để chẩn đoán
// qua kết quả trả về thay vì phải chụp màn hình cửa sổ Chrome mỗi lần test.
async function fetchRednoteImages(url) {
  // headed (không headless) — để sếp xem trực tiếp trên VPS Windows lúc debug/chạy
  const browser = await safeLaunch({ headless: false, args: ['--start-maximized'] });
  try {
    // viewport: null — khớp kích thước cửa sổ thật (--start-maximized), Playwright
    // mặc định ép viewport ~1280x720 bất kể cửa sổ OS được maximize hay không.
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    // Best-effort: đợi trang hết gọi API ngầm (SPA), nhưng không chặn nếu trang
    // có polling/analytics chạy mãi không bao giờ "idle".
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const debug = { title: await page.title(), finalUrl: page.url() };

    const metaImages = await page.$$eval(
      'meta[property="og:image"]',
      (els) => els.map((el) => el.content).filter(Boolean)
    );
    debug.metaCount = metaImages.length;
    if (metaImages.length > 0) return { images: [...new Set(metaImages)], debug };

    debug.totalImgTags = await page.$$eval('img', (els) => els.length);

    // Fallback 1: domain CDN biết trước của Xiaohongshu/RedNote.
    const cdnImages = await page.$$eval('img', (els) =>
      els.map((el) => el.src).filter((src) => /xhscdn\.com/.test(src))
    );
    debug.cdnCount = cdnImages.length;
    if (cdnImages.length > 0) return { images: [...new Set(cdnImages)], debug };

    // Fallback 2: domain CDN có thể đã đổi tên theo thương hiệu RedNote — nhận
    // diện ảnh nội dung theo kích thước thật thay vì theo domain cố định (loại
    // bỏ icon/avatar/logo nhỏ).
    const sizedImages = await page.$$eval('img', (els) =>
      els
        .filter((el) => el.naturalWidth > 200 && el.naturalHeight > 200)
        .map((el) => el.src)
        .filter(Boolean)
    );
    debug.sizedCount = sizedImages.length;
    if (sizedImages.length > 0) return { images: [...new Set(sizedImages)], debug };

    // Fallback 3: RedNote/Xiaohongshu thường hiển thị ảnh bài viết qua CSS
    // background-image trên <div> (carousel), không phải thẻ <img>.
    const bgImages = await page.$$eval('*', (els) =>
      els
        .filter((el) => el.offsetWidth > 200 && el.offsetHeight > 200)
        .map((el) => {
          const m = getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
          return m ? m[1] : null;
        })
        .filter(Boolean)
    );
    debug.bgCount = bgImages.length;
    return { images: [...new Set(bgImages)], debug };
  } finally {
    await browser.close();
  }
}

module.exports = { fetchRednoteImages };
