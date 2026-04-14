/**
 * PLAYWRIGHT-PROXY.JS - Chạy trên server ai.basso.vn
 * Thay thế direct Playwright calls bằng HTTP calls về máy local
 */

const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const LOCAL_URL = process.env.PLAYWRIGHT_LOCAL_URL; // vd: https://automation.basso.vn
const API_KEY = process.env.LOCAL_API_KEY || 'change-this-secret-key';

// State active profile (lưu trên server để trả lời nhanh)
let _activeProfile = null;
let _activeProfileName = null;

/**
 * Gọi API về máy local
 */
async function callLocal(method, endpoint, data = null, files = []) {
  if (!LOCAL_URL) {
    throw new Error('PLAYWRIGHT_LOCAL_URL chưa được set trong .env');
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

    const fetch = await getFetch();
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...form.getHeaders() },
      body: form,
    });
    return response.json();
  }

  // Không có file → dùng JSON
  const fetch = await getFetch();
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  return response.json();
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

async function postToPersonal(message, imagePaths = []) {
  return callLocal('POST', '/api/post',
    { message, target: 'personal' },
    imagePaths
  );
}

async function postToGroup(groupId, message, imagePaths = []) {
  return callLocal('POST', '/api/post',
    { message, target: 'group', groupId },
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
  closeBrowser,
};
