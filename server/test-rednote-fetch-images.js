/**
 * TEST-REDNOTE-FETCH-IMAGES.JS - Lấy danh sách URL ảnh từ 1 link bài viết RedNote
 * (Xiaohongshu) công khai, không cần đăng nhập. Dùng để tham khảo mẫu nội bộ.
 *
 * Cách dùng:
 *   node server/test-rednote-fetch-images.js "<link bài RedNote>"
 */
'use strict';
const { fetchRednoteImages } = require('./src/rednote/fetch-images');

const [url] = process.argv.slice(2);
if (!url) {
  console.log('Usage: node server/test-rednote-fetch-images.js "<link bài RedNote>"');
  process.exit(1);
}

(async () => {
  console.log(`\n=== Lấy ảnh từ: ${url} ===\n`);
  const images = await fetchRednoteImages(url);
  if (images.length === 0) {
    console.log('❌ Không tìm thấy ảnh nào.');
    process.exit(1);
  }
  console.log(`✓ Tìm thấy ${images.length} ảnh:`);
  images.forEach((src, i) => console.log(`${i + 1}. ${src}`));
})().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
