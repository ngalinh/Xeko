/**
 * START.JS - Script khởi động tự động
 * 1. Chạy local-server.js
 * 2. Đăng ký IP trực tiếp với remote server (không dùng Cloudflare tunnel)
 *
 * Cách dùng: node start.js
 * Yêu cầu: PLAYWRIGHT_LOCAL_URL trong .env hoặc tự detect IP public
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Đọc .env thủ công không cần dotenv
const envFile = path.resolve(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const REMOTE_BOT_URL = process.env.REMOTE_BOT_URL || 'https://ai.basso.vn/b/9cdc3e8d6a564b5e';
const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';
const LOCAL_PORT = process.env.LOCAL_PORT || 3001;

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

async function getPublicIp() {
  try {
    const fetchFn = await getFetch();
    const res = await fetchFn('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(5000) });
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

async function registerUrl(localUrl) {
  try {
    const fetchFn = await getFetch();
    const res = await fetchFn(`${REMOTE_BOT_URL}/api/register-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ url: localUrl }),
    });
    const data = await res.json();
    console.log('[✓] Đã đăng ký URL với remote server:', data.message);
  } catch (e) {
    console.error('[✗] Không đăng ký được URL:', e.message);
  }
}

// Khởi động local-server.js
console.log('[1/1] Khởi động local server...');
const server = spawn('node', ['server/local-server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
});
server.on('error', e => console.error('Local server error:', e.message));

// Đợi server sẵn sàng rồi đăng ký URL
setTimeout(async () => {
  // Ưu tiên URL trong .env, nếu không có thì tự detect IP public
  let localUrl = process.env.PLAYWRIGHT_LOCAL_URL;
  if (!localUrl) {
    const ip = await getPublicIp();
    if (ip) {
      localUrl = `http://${ip}:${LOCAL_PORT}`;
      console.log(`[✓] Detect IP public: ${ip}`);
    } else {
      console.error('[✗] Không lấy được IP public. Hãy đặt PLAYWRIGHT_LOCAL_URL trong .env');
      return;
    }
  }
  console.log(`[✓] Local URL: ${localUrl}`);
  await registerUrl(localUrl);
}, 2000);

process.on('SIGINT', () => {
  console.log('\nĐang dừng...');
  process.exit(0);
});

console.log('\n=== Xeko Local Server ===');
console.log('Nhấn Ctrl+C để dừng\n');
