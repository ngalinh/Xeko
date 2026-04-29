require('dotenv').config();

module.exports = {
  profiles: {
    linhthao: {
      email: process.env.FB_LINHTHAO_EMAIL,
      password: process.env.FB_LINHTHAO_PASSWORD,
      name: process.env.FB_LINHTHAO_NAME || 'Linh Thảo US',
      userDataDir: './playwright-data/linhthao',
    },
    linhduong: {
      email: process.env.FB_LINHDUONG_EMAIL,
      password: process.env.FB_LINHDUONG_PASSWORD,
      name: process.env.FB_LINHDUONG_NAME || 'Linh Duong',
      userDataDir: './playwright-data/linhduong',
    },
  },
  groups: {
    asale: { id: '350987965423767', name: 'Asale' },
    tongkho: { id: '532093344311571', name: 'Tổng Kho' },
  },
  playwright: {
    headless: false,
    slowMo: 800,
  },
  posting: {
    maxPostsPerDay: 50,
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
  },
};
