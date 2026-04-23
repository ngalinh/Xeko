/**
 * PLAYWRIGHT-PROXY.JS - Chạy trên server ai.basso.vn
 * Thay thế direct Playwright calls bằng HTTP calls về máy local
 */

const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// Không cache LOCAL_URL — đọc động mỗi lần gọi để nhận URL tunnel mới sau register-local
const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';

// State active profile (lưu trên server để trả lời nhanh)
let _activeProfile = null;
let _activeProfileName = null;

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(
      `Local server trả về không phải JSON (HTTP ${response.status}). ` +
      `Kiểm tra: máy local có đang chạy? Tunnel còn sống? Response: ${snippet}`
    );
  }
}

/**
 * Gọi API về máy local
 */
async function callLocal(method, endpoint, data = null, files = []) {
  const LOCAL_URL = process.env.PLAYWRIGHT_LOCAL_URL; // Đọc động mỗi lần
  if (!LOCAL_URL) {
    throw new Error('Local server chưa kết nối. Hãy chạy start.js trên máy local!');
  }

  const url = `${LOCAL_URL}${endpoint}`;
  const headers = { 'x-api-key': API_KEY };

  // Nếu có file → dùng FormData (multipart)
  if (files && files.length > 0) {
    const form = new FormData();

    // Thêm các field text
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) {
          form.append(key, String(value));
        }
      }
    }

    // Thêm file
    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        form.append('images', fs.createReadStream(filePath), {
          filename: path.basename(filePath),
          contentType: 'image/jpeg',
        });
      }
    }

    // Buffer toàn bộ multipart để có Content-Length chính xác.
    // form-data là CombinedStream (không hỗ trợ async iteration), nên pipe qua
    // PassThrough rồi collect chunks. Thiếu Content-Length → tunnel/Multer
    // có thể cắt stream giữa chừng và báo "Unexpected end of form".
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      const sink = new PassThrough();
      sink.on('data', c => chunks.push(c));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      form.on('error', reject);
      form.pipe(sink);
    });

    const fetch = await getFetch();
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...form.getHeaders(),
        'Content-Length': String(body.length),
      },
      body,
    });
    return safeJson(response);
  }

  // Không có file → dùng JSON
  const fetch = await getFetch();
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  return safeJson(response);
}

async function getFetch() {
  // Node 18+ có built-in fetch, Node cũ dùng node-fetch
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

// ===== API tương thích với playwright/post.js =====

function setProfile(profileName) {
  _activeProfile = profileName;
  _activeProfileName = profileName;
  // Gọi async nhưng không await (để tương thích sync interface)
  callLocal('POST', '/api/profile', { profile: profileName })
    .then(r => { if (r.name) _activeProfileName = r.name; })
    .catch(() => {});
  return { name: profileName, key: profileName };
}

function getActiveProfile() {
  if (!_activeProfile) throw new Error('Chưa chọn profile!');
  return { name: _activeProfileName || _activeProfile, key: _activeProfile };
}

// Poll /api/job/:id trên máy local cho đến khi xong
async function pollLocalJob(jobId, maxWaitMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const data = await callLocal('GET', `/api/job/${jobId}`);
    if (data.status === 'done') return data.result;
    if (data.status === 'failed') throw new Error(data.error || 'Job thất bại');
  }
  throw new Error('Quá 10 phút chưa xong — kiểm tra FB/Zalo tay.');
}

async function postToPersonal(message, imagePaths = []) {
  const res = await callLocal('POST', '/api/post', { message, target: 'personal' }, imagePaths);
  if (res.jobId) return pollLocalJob(res.jobId);
  return res;
}

async function postToGroup(groupId, message, imagePaths = []) {
  const res = await callLocal('POST', '/api/post', { message, target: 'group', groupId }, imagePaths);
  if (res.jobId) return pollLocalJob(res.jobId);
  return res;
}

async function postToZaloGroup({ zaloAccountName, groupName, message, imagePaths = [] }) {
  return callLocal('POST', '/api/zalo/post',
    { profile: zaloAccountName, groupName, message },
    imagePaths
  );
}

async function closeBrowser() {
  // Không cần làm gì trên server — browser chạy ở local
  return Promise.resolve();
}

module.exports = {
  setProfile,
  getActiveProfile,
  postToPersonal,
  postToGroup,
  postToZaloGroup,
  closeBrowser,
};
