const logger = require('./logger');
const postLogger = require('../database/post-logger');
const scheduleStore = require('../database/schedule-store');
const { queuePost } = require('./post-queue');
const fs = require('fs');
const path = require('path');

// Persist temp images sang /data/uploads để history tham chiếu được lâu dài.
// Mirror behavior với persistImages() trong server/index.js.
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
      logger.error(`scheduler.persistImages: ${e.message}`);
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
function addSchedule({ time, target, groupId, message, imagePaths, profile, type, groupName, zaloAccount }) {
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
    zaloAccount: zaloAccount || null,
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
    let result;
    const imgCount = job.imagePaths?.length || 0;
    // Persist temp images sang /data/uploads để history giữ thumbnail sau khi schedule fired
    const imageUrls = persistImages(job.imagePaths);

    // Zalo
    if (job.type === 'zalo') {
      const salework = process.env.PLAYWRIGHT_LOCAL_URL
        ? require('../../playwright-proxy')
        : require('../playwright/salework');

      if (!job.zaloAccount || !job.groupName) {
        throw new Error('Thiếu zaloAccount hoặc groupName cho lịch Zalo');
      }

      if (process.env.PLAYWRIGHT_LOCAL_URL) {
        result = await salework.postToZaloGroup({
          zaloAccountName: job.zaloAccount,
          groupName: job.groupName,
          message: job.message,
          imagePaths: job.imagePaths || [],
        });
      } else {
        // Trực tiếp trên máy local: cần lookup accountKey
        const fs = require('fs');
        const accountsFile = require('path').resolve(__dirname, '../../config/zalo-accounts.json');
        let accounts = [];
        try { accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch {}
        const acct = accounts.find(a => a.key === job.zaloAccount || a.name === job.zaloAccount || a.saleworkName === job.zaloAccount);
        result = await salework.postToZaloGroup({
          zaloAccountName: job.zaloAccount,
          accountKey: acct ? acct.key : job.zaloAccount,
          groupName: job.groupName,
          message: job.message,
          imagePaths: job.imagePaths || [],
        });
      }

      postLogger.logPost({ profile: job.profile, profileName: job.profile, platform: 'zalo', target: 'group', groupName: job.groupName, message: job.message, imageCount: imgCount, images: imageUrls, success: result.success, error: result.error, source: 'schedule' });

    } else {
    // Facebook
    playwright.setProfile(job.profile);

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
    } // end else (facebook)

    job.status = 'done';
    job.result = result;

    // Kiểm tra kết quả thực tế — postToGroup/postToPersonal trả về { success: false }
    // thay vì throw, nên phải check tường minh ở đây.
    const overallSuccess = result?.results
      ? result.results.every(r => r.success)
      : result?.success === true;
    const errorMsg = result?.results
      ? result.results.filter(r => !r.success).map(r => `${r.target}: ${r.error}`).join('; ')
      : (result?.error || 'Không rõ lỗi');

    logger.info(`Lịch #${job.id} hoàn tất: ${overallSuccess ? 'thành công' : 'thất bại'}`);

    const baseNotif = {
      id: job.id,
      jobType: job.type || 'facebook',
      time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      scheduledTime: job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      target: job.target,
      groupId: job.groupId,
      groupName: job.groupName,
      zaloAccount: job.zaloAccount,
      message: job.message,
      imageCount: job.imagePaths?.length || 0,
      profile: job.profile,
    };

    if (overallSuccess) {
      notifications.push({ ...baseNotif, type: 'success' });
    } else {
      job.status = 'error';
      notifications.push({ ...baseNotif, type: 'error', error: errorMsg });
    }
  } catch (error) {
    job.status = 'error';
    job.result = { success: false, error: error.message };
    logger.error(`Lịch #${job.id} lỗi: ${error.message}`);

    notifications.push({
      id: job.id,
      type: 'error',
      jobType: job.type || 'facebook',
      time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      scheduledTime: job.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      target: job.target,
      groupId: job.groupId,
      groupName: job.groupName,
      zaloAccount: job.zaloAccount,
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
