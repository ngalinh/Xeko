/**
 * Playwright launch wrapper:
 * 1) Set PLAYWRIGHT_BROWSERS_PATH = <server>/.playwright-browsers (writable) —
 *    tránh EPERM khi PM2-Service không có quyền tạo folder trong %LOCALAPPDATA%.
 * 2) safeLaunch / safeLaunchPersistentContext: nếu launch fail vì thiếu binary
 *    (Playwright vừa upgrade version, hoặc thiếu chromium-headless-shell), tự
 *    chạy `playwright install chromium chromium-headless-shell` rồi retry.
 *
 * QUAN TRỌNG: file này phải được require TRƯỚC require('playwright') để env
 * có hiệu lực. Trong local-server.js đặt ở đầu, trước mọi require khác liên
 * quan đến Playwright.
 */

const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.resolve(__dirname, '../..');
const BROWSERS_PATH = path.resolve(SERVER_DIR, '.playwright-browsers');

// Override env nếu user chưa set tay (qua PM2 env / .env)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  try {
    fs.mkdirSync(BROWSERS_PATH, { recursive: true });
    process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
  } catch {
    // Folder không tạo được — giữ nguyên default, để Playwright tự xử lý lỗi
  }
}

// Require Playwright SAU khi set env
const { chromium } = require('playwright');

function isMissingBrowserError(e) {
  return /Executable doesn'?t exist|chromium_headless_shell|chrome-headless-shell|Looks like Playwright was just installed/i.test(e?.message || '');
}

let _installPromise = null;
function ensureBrowsers() {
  if (_installPromise) return _installPromise;
  _installPromise = new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const playwrightCli = path.resolve(SERVER_DIR, 'node_modules/playwright/cli.js');

    let executable, args, useShell;
    if (fs.existsSync(playwrightCli)) {
      // Gọi thẳng node binary đang chạy → tránh PATH/npx issue trên PM2-Service
      executable = process.execPath;
      args = [playwrightCli, 'install', 'chromium', 'chromium-headless-shell'];
      useShell = false;
    } else {
      executable = 'npx';
      args = ['playwright', 'install', 'chromium', 'chromium-headless-shell'];
      useShell = process.platform === 'win32';
    }

    console.log('[playwright-install] Cài browsers vào ' + (process.env.PLAYWRIGHT_BROWSERS_PATH || '(default)') + ' — 1-3 phút, ~200MB...');

    let stderr = '';
    let stdout = '';
    const proc = spawn(executable, args, {
      shell: useShell,
      cwd: SERVER_DIR,
      env: { ...process.env }, // truyền env mới (PLAYWRIGHT_BROWSERS_PATH) cho child
    });
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      _installPromise = null;
      if (code === 0) {
        console.log('[playwright-install] OK');
        return resolve();
      }
      const detail = (stderr || stdout || '(no output)').replace(/\s+/g, ' ').trim().slice(0, 500);
      reject(new Error(
        `playwright install exit ${code}. Detail: ${detail}. ` +
        `Chạy tay: cd C:\\xeko\\server && npx playwright install chromium chromium-headless-shell`
      ));
    });
    proc.on('error', err => {
      _installPromise = null;
      reject(new Error(`Không spawn được "${executable}": ${err.message}`));
    });
  });
  return _installPromise;
}

async function safeLaunch(opts = {}) {
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!isMissingBrowserError(e)) throw e;
    await ensureBrowsers();
    return await chromium.launch(opts);
  }
}

async function safeLaunchPersistentContext(userDataDir, opts = {}) {
  try {
    return await chromium.launchPersistentContext(userDataDir, opts);
  } catch (e) {
    if (!isMissingBrowserError(e)) throw e;
    await ensureBrowsers();
    return await chromium.launchPersistentContext(userDataDir, opts);
  }
}

module.exports = {
  safeLaunch,
  safeLaunchPersistentContext,
  ensureBrowsers,
  isMissingBrowserError,
  chromium, // re-export để các module khác không cần require playwright riêng
  BROWSERS_PATH,
};
