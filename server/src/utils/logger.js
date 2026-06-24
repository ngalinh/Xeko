const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3,
      // tailable=true: app.log LUÔN là file mới nhất; file cũ dồn sang app1/app2.
      // Không có flag này (mặc định false), khi đầy 5MB winston ghi tiếp sang
      // app1.log và để app.log đông cứng — dashboard /api/logs/tail đọc app.log
      // sẽ tưởng log ngừng cập nhật.
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
    }),
  ],
});

module.exports = logger;
