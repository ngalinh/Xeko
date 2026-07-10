require('dotenv').config();

module.exports = {
  groups: {
    asale: { id: '350987965423767', name: 'Asale' },
    tongkho: { id: '532093344311571', name: 'Tổng Kho' },
  },
  playwright: {
    headless: false,
    slowMo: 800,
  },
  posting: {
    // Trần bài/ngày tính RIÊNG theo từng profile (xem getPostCount trong index.js).
    // Nâng mặc định 50 → 200 để chạy nhiều account/đăng dày hơn không mau chạm trần.
    // Có thể override qua env MAX_POSTS_PER_DAY mà không cần sửa code.
    maxPostsPerDay: parseInt(process.env.MAX_POSTS_PER_DAY || '200', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
  },
};
