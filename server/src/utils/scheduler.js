const logger = require('./logger');
const postLogger = require('../database/post-logger');
const scheduleStore = require('../database/schedule-store');
const { queuePost } = require('./post-queue');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.resolve(__dirname, '../../../data/uploads');

function persistImages(imagePaths) {
  if (!imagePaths || !imagePaths.length) return [];
  const now = new Date();
  const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const targetDir = path.join(UPLOADS_DIR, dateDir);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const urls = [];
  for (const p of imagePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const filename = path.basename(p);
      const target = path.join(targetDir, filename);
      fs.copyFileSync(p, target);
      urls.push(`/api/image/${dateDir}/${filename}`);
    } catch (e) {
      logger.error(`persistImages: ${e.message}`);
    }
  }
  return urls;
}

// Lưu lịch đăng bài trong RAM (nguồn sự thật là DB, đây chỉ là cache)
const scheduledPosts = [];
let nextId = 1;

// Notifications cho web UI
const notifications = [];

/**
 * Thêm lịch đăng bài
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

  // Copy file ảnh riêng cho mỗi lịch (tránh conflict khi nhiều lịch cùng dùng chung file)
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
    logger.info(`Đã copy ${ownImagePaths.length} ảnh cho lịch #${id}`);
  }

  const job = {
    id,
    time: scheduleTime,
    type: type || 'facebook',
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

  // Persist xuống DB trước khi set timer, tránh mất khi crash giữa chừng
  scheduleStore.insert(job);

  // Đặt timer
  const delay = scheduleTime.getTime() - Date.now();
  job.timer = setTimeout(() => {
    queuePost(() => executeSchedule(job));
  }, delay);

  scheduledPosts.push(job);
  logger.info(`Lên lịch #${id}: ${scheduleTime.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} - ${target} - "${message?.substring(0, 30)}..."`);

  return job;
}

/**
 * Thực thi bài đăng theo lịch
 */
async function executeSchedule(job) {
  // Khi chạy trên server ai.basso.vn, playwright thực sự nằm ở máy local —
  // forward qua proxy. Không thì các profile nằm trong playwright-data/ của
  // máy local sẽ không tìm thấy và ném lỗi "Profile không tồn tại".
  const playwright = process.env.PLAYWRIGHT_LOCAL_URL
    ? require('../../playwright-proxy')
    : require('../playwright/post');

  job.status = 'running';
  scheduleStore.updateStatus(job.id, 'running');
  logger.info(`Đang thực thi lịch #${job.id} (${job.type})...`);

  try {
    // Facebook
    // Set profile
    playwright.setProfile(job.profile);

    // Persist images to permanent storage before posting (temp files deleted in finally)
    const imageUrls = persistImages(job.imagePaths);
    const imgCount = job.imagePaths?.length || 0;

    let result;
    if (job.target === 'personal') {
      result = await playwright.postToPersonal(job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'personal', message: job.message, imageCount: imgCount, images: imageUrls, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
    } else if (job.target === 'group') {
      result = await playwright.postToGroup(job.groupId, job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: job.groupId, groupName: job.groupName, message: job.message, imageCount: imgCount, images: imageUrls, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
    } else if (job.target === 'allgroup') {
      const config = require('../../config/default');
      const groups = Object.values(config.groups);
      const results = [];
      for (const group of groups) {
        const r = await playwright.postToGroup(group.id, job.message, job.imagePaths);
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, images: imageUrls, success: r.success, error: r.error, postUrl: r.postUrl, source: 'schedule' });
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
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, images: imageUrls, success: result.success, error: result.error, postUrl: result.postUrl, source: 'schedule' });
      } else {
        result = { success: false, error: 'Group không tồn tại' };
      }
    } else if (job.target === 'all') {
      const config = require('../../config/default');
      const results = [];
      // Cá nhân
      const r1 = await playwright.postToPersonal(job.message, job.imagePaths);
      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'personal', message: job.message, imageCount: imgCount, images: imageUrls, success: r1.success, error: r1.error, postUrl: r1.postUrl, source: 'schedule' });
      results.push({ target: 'FB Cá nhân', ...r1 });
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      // Groups
      const groups = Object.values(config.groups);
      for (const group of groups) {
        const r = await playwright.postToGroup(group.id, job.message, job.imagePaths);
        postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'facebook', target: 'group', groupId: group.id, groupName: group.name, message: job.message, imageCount: imgCount, images: imageUrls, success: r.success, error: r.error, postUrl: r.postUrl, source: 'schedule' });
        results.push({ target: group.name, ...r });
        if (groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
        }
      }
      result = { success: results.every(r => r.success), results };
    }

    job.status = 'done';
    job.result = result;
    logger.info(`Lịch #${job.id} hoàn tất: ${result?.success ? 'thành công' : 'thất bại'}`);

    // Gửi notification
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
    logger.error(`Lịch #${job.id} lỗi: ${error.message}`);

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
    // Cleanup file ảnh của lịch này
    if (job.imagePaths && job.imagePaths.length > 0) {
      for (const f of job.imagePaths) {
        try { fs.unlinkSync(f); } catch {}
      }
      try {
        const dir = path.dirname(job.imagePaths[0]);
        fs.rmdirSync(dir);
      } catch {}
    }
    // Xoá khỏi DB — bài đã chạy xong, thông tin sẽ nằm trong post_logs
    scheduleStore.remove(job.id);
  }
}

/**
 * Lấy danh sách lịch
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
 * Xoá lịch
 */
function removeSchedule(id) {
  const index = scheduledPosts.findIndex(j => j.id === id);
  if (index === -1) {
    // Không có trong RAM nhưng có thể vẫn còn trong DB (vd sau crash)
    scheduleStore.remove(id);
    return false;
  }

  const job = scheduledPosts[index];
  if (job.timer) clearTimeout(job.timer);
  scheduledPosts.splice(index, 1);
  scheduleStore.remove(id);
  logger.info(`Đã xoá lịch #${id}`);
  return true;
}

/**
 * Khôi phục lịch từ DB khi server khởi động.
 * Lịch còn trong tương lai -> re-schedule setTimeout.
 * Lịch quá hạn (server down đúng lúc nó) -> chạy ngay (catch-up).
 */
function init() {
  nextId = scheduleStore.nextId();

  const pending = scheduleStore.getPending();
  if (!pending.length) {
    logger.info('Scheduler init: không có lịch pending');
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
      // Đã quá giờ -> chạy ngay
      const mins = Math.round(-delay / 60000);
      logger.warn(`Catch-up lịch #${p.id}: quá hạn ${mins} phút, chạy ngay`);
      catchup++;
      queuePost(() => executeSchedule(job));
    } else {
      // Còn trong tương lai -> re-schedule
      job.timer = setTimeout(() => queuePost(() => executeSchedule(job)), delay);
      restored++;
      logger.info(`Khôi phục lịch #${p.id}: ${p.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
    }
  }

  logger.info(`Scheduler init: khôi phục ${restored} lịch, catch-up ${catchup} lịch quá hạn`);
}

/**
 * Lấy và xoá notifications (polling)
 */
function getNotifications() {
  const items = [...notifications];
  notifications.length = 0;
  return items;
}

module.exports = { addSchedule, getSchedules, removeSchedule, getNotifications, init };
