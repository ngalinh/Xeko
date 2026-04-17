/**
 * START.JS - Script khởi động tự động
 * 1. Chạy local-server.js
 * 2. Chạy cloudflared tunnel
 * 3. Tự lấy URL mới và đăng ký với remote server
 *
 * Cách dùng: node start.js
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
const CLOUDFLARED = path.resolve(__dirname, 'cloudflared.exe.exe');

async function registerUrl(tunnelUrl) {
  const getFetch = async () => {
    if (typeof fetch !== 'undefined') return fetch;
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch;
  };
  try {
    const fetchFn = await getFetch();
    const res = await fetchFn(`${REMOTE_BOT_URL}/api/register-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ url: tunnelUrl }),
    });
    const data = await res.json();
    console.log('[✓] Đã đăng ký URL với remote server:', data.message);
  } catch (e) {
    console.error('[✗] Không đăng ký được URL:', e.message);
  }
}

// Khởi động local-server.js
console.log('[1/2] Khởi động local server...');
const server = spawn('node', ['server/local-server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
});
server.on('error', e => console.error('Local server error:', e.message));

// Đợi local server sẵn sàng rồi mới chạy tunnel
setTimeout(() => {
  console.log('[2/2] Khởi động Cloudflare Tunnel...');
  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', 'http://localhost:3001'], {
    cwd: __dirname,
  });

  tunnel.stderr.on('data', (data) => {
    const output = data.toString();
    // Tìm URL tunnel trong output
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const tunnelUrl = match[0];
      console.log('\n[✓] Tunnel URL:', tunnelUrl);
      registerUrl(tunnelUrl);
    }
  });

  tunnel.on('error', e => console.error('Tunnel error:', e.message));
  tunnel.on('close', () => console.log('Tunnel đã dừng'));
}, 2000);

process.on('SIGINT', () => {
  console.log('\nĐang dừng...');
  process.exit(0);
});

console.log('\n=== Xeko Local Server ===');
console.log('Nhấn Ctrl+C để dừng\n');
