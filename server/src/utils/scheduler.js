const logger = require('./logger');
const postLogger = require('../database/post-logger');
const scheduleStore = require('../database/schedule-store');
const fs = require('fs');
const path = require('path');

// Luu lich dang bai trong RAM (nguon su that la DB, day chi la cache)
const scheduledPosts = [];
let nextId = 1;

// Notifications cho web UI
const notifications = [];

/**
 * Them lich dang bai
 */
function addSchedule({ time, target, groupId, message, imagePaths, profile, type, groupName }) {
  const id = nextId++;
  const scheduleTime = new Date(time);

  if (isNaN(scheduleTime.getTime())) {
    throw new Error('Thời gian không hợp lệ');
  }

  if (scheduleTime <= new Date()) {
    throw new Error('Thời gian phải ở tương lai');
  }

  // Copy file anh rieng cho moi lich (tranh conflict khi nhieu lich cung dung chung file)
  let ownImagePaths = [];
  if (imagePaths && imagePaths.length > 0) {
    const schedDir = path.resolve(__dirname, `../../temp/schedule_${id}`);
    if (!fs.existsSync(schedDir)) fs.mkdirSync(schedDir, { recursive: true });

    ownImagePaths = imagePaths.map((src, i) => {
      const ext = path.extname(src) || '.jpg';
      const dest = path.join(schedDir, `img_${i}${ext}`);
      fs.copyFileSync(src, dest);
      return dest;
    });
    logger.info(`Da copy ${ownImagePaths.length} anh cho lich #${id}`);
  }

  const job = {
    id,
    time: scheduleTime,
    type: type || 'facebook', // 'facebook' hoac 'zalo'
    target,
    groupId,
    groupName,
    message,
    imagePaths: ownImagePaths,
    profile,
    status: 'pending',
    result: null,
    timer: null,
  };

  // Persist xuong DB truoc khi set timer, tranh mat khi crash giua chung
  scheduleStore.insert(job);

  // Dat timer
  const delay = scheduleTime.getTime() - Date.now();
  job.timer = setTimeout(() => {
    executeSchedule(job);
  }, delay);

  scheduledPosts.push(job);
  logger.info(`Len lich #${id}: ${scheduleTime.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} - ${target} - "${message?.substring(0, 30)}..."`);

  return job;
}

/**
 * Thuc thi bai dang theo lich
 */
async function executeSchedule(job) {
  // Khi chay tren server ai.basso.vn, playwright thuc su nam o may local —
  // forward qua proxy. Khong thi cac profile nam trong playwright-data/ cua
  // may local se khong tim thay va nem loi "Profile khong ton tai".
  const playwright = process.env.PLAYWRIGHT_LOCAL_URL
    ? require('../../playwright-proxy')
    : require('../playwright/post');

  job.status = 'running';
  scheduleStore.updateStatus(job.id, 'running');
  logger.info(`Dang thuc thi lich #${job.id} (${job.type})...`);

  try {
    // Zalo
    if (job.type === 'zalo') {
      const salework = require('../playwright/salework');
      const result = await salework.postToZaloGroup(job.profile, job.groupName, job.message, job.imagePaths);

      job.status = result.success ? 'done' : 'error';
      job.result = result;
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'zalo', target: 'group', groupName: job.groupName, message: job.message, imageCount: job.imagePaths?.length || 0, success: result.success, error: result.error, source: 'schedule' });

      notifications.push({
        id: job.id,
        type: result.success ? 'success' : 'error',
        platform: 'zalo',
        time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        scheduledTime: job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        target: `Zalo:${job.groupName}`,
        message: job.message,
        imageCount: job.imagePaths?.length || 0,
        profile: job.profile,
        error: result.error,
      });

      return;
    }

    // Facebook
    // Set profile
    playwright.setProfile(job.profile);

    let result;
    const imgCount = job.imagePaths?.length || 0;
    if (job.target === 'personal') {
      result = await playwright.postToPersonal(job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'personal', message: job.message, imageCount: imgCount, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
    } else if (job.target === 'group') {
      result = await playwright.postToGroup(job.groupId, job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: job.groupId, groupName: job.groupName, message: job.message, imageCount: imgCount, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
    } else if (job.target === 'allgroup') {
      const config = require('../../config/default');
      const groups = Object.values(config.groups);
      const results = [];
      for (const group of groups) {
        const r = await playwright.postToGroup(group.id, job.message, job.imagePaths);
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, success: r.success, error: r.error, postUrl: r.postUrl, source: 'schedule' });
        results.push({ target: group.name, ...r });
        if (groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
        }
      }
      result = { success: results.every(r => r.success), results };
    } else if (job.target === 'shortcut') {
      const config = require('../../config/default');
      const group = config.groups[job.groupId];
      if (group) {
        result = await playwright.postToGroup(group.id, job.message, job.imagePaths);
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
      } else {
        result = { success: false, error: 'Group không tồn tại' };
      }
    } else if (job.target === 'all') {
      const config = require('../../config/default');
      const results = [];
      // Ca nhan
      const r1 = await playwright.postToPersonal(job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'personal', message: job.message, imageCount: imgCount, success: r1.success, error: r1.error, postUrl: r1.postUrl, source: 'schedule' });
      results.push({ target: 'FB Cá nhân', ...r1 });
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      // Groups
      const groups = Object.values(config.groups);
      for (const group of groups) {
        const r = await playwright.postToGroup(group.id, job.message, job.imagePaths);
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, success: r.success, error: r.error, postUrl: r.postUrl, source: 'schedule' });
        results.push({ target: group.name, ...r });
        if (groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
        }
      }
      result = { success: results.every(r => r.success), results };
    }

    job.status = 'done';
    job.result = result;
    logger.info(`Lich #${job.id} hoan tat: ${result?.success ? 'thanh cong' : 'that bai'}`);

    // Gui notification
    notifications.push({
      id: job.id,
      type: 'success',
      time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      scheduledTime: job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      target: job.target,
      groupId: job.groupId,
      message: job.message,
      imageCount: job.imagePaths?.length || 0,
      profile: job.profile,
    });
  } catch (error) {
    job.status = 'error';
    job.result = { success: false, error: error.message };
    logger.error(`Lich #${job.id} loi: ${error.message}`);

    notifications.push({
      id: job.id,
      type: 'error',
      time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      scheduledTime: job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      target: job.target,
      groupId: job.groupId,
      message: job.message,
      imageCount: job.imagePaths?.length || 0,
      profile: job.profile,
      error: error.message,
    });
  } finally {
    // Cleanup file anh cua lich nay
    if (job.imagePaths && job.imagePaths.length > 0) {
      for (const f of job.imagePaths) {
        try { fs.unlinkSync(f); } catch {}
      }
      try {
        const dir = path.dirname(job.imagePaths[0]);
        fs.rmdirSync(dir);
      } catch {}
    }
    // Xoa khoi DB — bai da chay xong, thong tin se nam trong post_logs
    scheduleStore.remove(job.id);
  }
}

/**
 * Lay danh sach lich
 */
function getSchedules() {
  return scheduledPosts.map(j => ({
    id: j.id,
    time: j.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    timeISO: j.time.toISOString(),
    type: j.type || 'facebook',
    target: j.target,
    groupId: j.groupId,
    groupName: j.groupName,
    message: j.message?.substring(0, 50),
    profile: j.profile,
    status: j.status,
    imageCount: j.imagePaths?.length || 0,
    imagePaths: j.imagePaths || [],
  }));
}

/**
 * Xoa lich
 */
function removeSchedule(id) {
  const index = scheduledPosts.findIndex(j => j.id === id);
  if (index === -1) {
    // Khong co trong RAM nhung co the van con trong DB (vd sau crash)
    scheduleStore.remove(id);
    return false;
  }

  const job = scheduledPosts[index];
  if (job.timer) clearTimeout(job.timer);
  scheduledPosts.splice(index, 1);
  scheduleStore.remove(id);
  logger.info(`Da xoa lich #${id}`);
  return true;
}

/**
 * Khoi phuc lich tu DB khi server khoi dong.
 * Lich con trong tuong lai -> re-schedule setTimeout.
 * Lich qua han (server down dung luc no) -> chay ngay (catch-up).
 */
function init() {
  nextId = scheduleStore.nextId();

  const pending = scheduleStore.getPending();
  if (!pending.length) {
    logger.info('Scheduler init: khong co lich pending');
    return;
  }

  const now = Date.now();
  let catchup = 0;
  let restored = 0;

  for (const p of pending) {
    const job = {
      id: p.id,
      time: p.time,
      type: p.type,
      target: p.target,
      groupId: p.groupId,
      groupName: p.groupName,
      message: p.message,
      imagePaths: p.imagePaths,
      profile: p.profile,
      status: 'pending',
      result: null,
      timer: null,
    };
    scheduledPosts.push(job);

    const delay = p.time.getTime() - now;
    if (delay <= 0) {
      // Da qua gio -> chay ngay
      const mins = Math.round(-delay / 60000);
      logger.warn(`Catch-up lich #${p.id}: qua han ${mins} phut, chay ngay`);
      catchup++;
      executeSchedule(job);
    } else {
      // Con trong tuong lai -> re-schedule
      job.timer = setTimeout(() => executeSchedule(job), delay);
      restored++;
      logger.info(`Khoi phuc lich #${p.id}: ${p.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
    }
  }

  logger.info(`Scheduler init: khoi phuc ${restored} lich, catch-up ${catchup} lich qua han`);
}

/**
 * Lay va xoa notifications (polling)
 */
function getNotifications() {
  const items = [...notifications];
  notifications.length = 0;
  return items;
}

module.exports = { addSchedule, getSchedules, removeSchedule, getNotifications, init };
