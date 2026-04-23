const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../../config/default');
const logger = require('../utils/logger');
const playwright = require('../playwright/post');

const bot = new TelegramBot(config.telegram.token, { polling: true });

const TEMP_DIR = path.resolve(__dirname, '../../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let postCount = 0;
let lastResetDate = new Date().toDateString();

// Gom album: media_group_id -> { photos, caption, chatId, timer }
const pendingAlbums = new Map();
const ALBUM_WAIT_MS = 2000; // Đợi 2 giây để gom hết ảnh trong album

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    postCount = 0;
    lastResetDate = today;
  }
}

function isAuthorized(userId) {
  return config.telegram.allowedUsers.includes(userId);
}

async function downloadTelegramPhoto(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${fileInfo.file_path}`;
  const ext = path.extname(fileInfo.file_path) || '.jpg';
  const localPath = path.join(TEMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

  const response = await axios({ url: fileUrl, responseType: 'stream' });
  const writer = fs.createWriteStream(localPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(localPath));
    writer.on('error', reject);
  });
}

function cleanupTempFiles(filePaths) {
  for (const f of filePaths) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * Phân tích caption để xác định target và nội dung
 */
function parseCaption(caption) {
  const groupMatch = caption.match(/^\/post_group\s+(\S+)\s*(.*)/s);
  const personalMatch = caption.match(/^\/post\s+(.*)/s);
  const asaleMatch = caption.match(/^\/asale\s*(.*)/s);
  const tongkhoMatch = caption.match(/^\/tongkho\s*(.*)/s);
  const allgroupMatch = caption.match(/^\/allgroup\s*(.*)/s);

  if (allgroupMatch) {
    return { target: 'allgroup', groupId: null, message: allgroupMatch[1] || '' };
  } else if (asaleMatch) {
    return { target: 'group', groupId: config.groups.asale.id, message: asaleMatch[1] || '' };
  } else if (tongkhoMatch) {
    return { target: 'group', groupId: config.groups.tongkho.id, message: tongkhoMatch[1] || '' };
  } else if (groupMatch) {
    return { target: 'group', groupId: groupMatch[1], message: groupMatch[2] || '' };
  } else if (personalMatch) {
    return { target: 'personal', groupId: null, message: personalMatch[1] || '' };
  } else if (!caption.startsWith('/')) {
    return { target: 'personal', groupId: null, message: caption };
  }
  return null;
}

/**
 * Xử lý đăng bài (gọi sau khi đã gom hết ảnh)
 */
async function processPost(chatId, parsed, photoFileIds) {
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(chatId, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.`);
    return;
  }

  const downloadedFiles = [];
  try {
    // Tải tất cả ảnh
    for (const fileId of photoFileIds) {
      const localPath = await downloadTelegramPhoto(fileId);
      downloadedFiles.push(localPath);
    }
    logger.info(`Đã tải ${downloadedFiles.length} ảnh`);

    // Đăng lên tất cả group
    if (parsed.target === 'allgroup') {
      const groups = Object.values(config.groups);
      bot.sendMessage(chatId, `Đang tải ${downloadedFiles.length} ảnh và đăng lên ${groups.length} group...`);

      for (const group of groups) {
        if (postCount >= config.posting.maxPostsPerDay) {
          bot.sendMessage(chatId, `Đã đạt giới hạn. Dừng lại.`);
          break;
        }

        bot.sendMessage(chatId, `⏳ Đang đăng lên ${group.name}...`);
        const result = await playwright.postToGroup(group.id, parsed.message, downloadedFiles);
        postCount++;

        if (result.success) {
          await sendResult(chatId, `✅ ${group.name} thành công!`, result);
        } else {
          bot.sendMessage(chatId, `❌ ${group.name} lỗi: ${result.error}`);
        }

        if (groups.indexOf(group) < groups.length - 1) {
          const delay = Math.floor(Math.random() * (config.posting.maxDelay - config.posting.minDelay)) + config.posting.minDelay;
          bot.sendMessage(chatId, `⏰ Đợi ${Math.round(delay/1000)}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      bot.sendMessage(chatId, `🏁 Hoàn tất đăng ${groups.length} group!`);
      return;
    }

    // Đăng 1 group hoặc cá nhân
    const targetLabel = parsed.target === 'group' ? `Group ${parsed.groupId}` : 'trang cá nhân';
    bot.sendMessage(chatId, `Đang tải ${downloadedFiles.length} ảnh và đăng bài lên ${targetLabel}...`);

    let result;
    if (parsed.target === 'group') {
      result = await playwright.postToGroup(parsed.groupId, parsed.message, downloadedFiles);
    } else {
      result = await playwright.postToPersonal(parsed.message, downloadedFiles);
    }
    postCount++;

    if (result.success) {
      await sendResult(chatId, `Đăng bài ${targetLabel} kèm ${downloadedFiles.length} ảnh thành công!`, result);
    } else {
      bot.sendMessage(chatId, `Lỗi: ${result.error}`);
    }
  } catch (error) {
    logger.error(`Lỗi: ${error.message}`);
    bot.sendMessage(chatId, `Lỗi: ${error.message}`);
  } finally {
    cleanupTempFiles(downloadedFiles);
  }
}

/**
 * Gửi kết quả về Telegram: text + link (nếu có) + screenshot
 */
async function sendResult(chatId, message, result) {
  let text = message;
  if (result.postUrl) {
    text += `\nLink: ${result.postUrl}`;
  }
  await bot.sendMessage(chatId, text);

  // Gửi screenshot bài viết
  if (result.screenshot && fs.existsSync(result.screenshot)) {
    try {
      await bot.sendPhoto(chatId, result.screenshot, { caption: 'Screenshot bài viết' });
    } catch (e) {
      logger.error(`Lỗi gửi screenshot: ${e.message}`);
    }
  }
}

// Chọn profile và gửi thông báo
function selectProfile(chatId, profileKey) {
  try {
    playwright.setProfile(profileKey);
    const profile = config.profiles[profileKey];
    bot.sendMessage(chatId, `✅ Đã chọn profile: *${profile.name}*\n\nBây giờ hãy chọn cách đăng bài:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Đăng FB cá nhân', callback_data: 'help_post' },
            { text: '👥 Đăng Group', callback_data: 'help_group' },
          ],
          [
            { text: '📊 Trạng thái', callback_data: 'status' },
            { text: '🔄 Đổi profile', callback_data: 'choose_profile' },
          ],
        ],
      },
    });
  } catch (e) {
    bot.sendMessage(chatId, `Lỗi: ${e.message}`);
  }
}

// Chọn profile /linhthao
bot.onText(/\/linhthao/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  selectProfile(msg.chat.id, 'linhthao');
});

// Chọn profile /linhduong
bot.onText(/\/linhduong/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  selectProfile(msg.chat.id, 'linhduong');
});

// Kiểm tra profile trước khi đăng bài
function requireProfile(chatId) {
  try {
    playwright.getActiveProfile();
    return true;
  } catch {
    bot.sendMessage(chatId, '⚠️ Chưa chọn profile! Vui lòng chọn:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👩 Linh Thảo', callback_data: 'profile_linhthao' },
            { text: '👩 Linh Dương', callback_data: 'profile_linhduong' },
          ],
        ],
      },
    });
    return false;
  }
}

// Xử lý callback buttons
bot.on('callback_query', async (query) => {
  if (!isAuthorized(query.from.id)) return;
  const chatId = query.message.chat.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  switch (data) {
    case 'profile_linhthao':
      selectProfile(chatId, 'linhthao');
      break;

    case 'profile_linhduong':
      selectProfile(chatId, 'linhduong');
      break;

    case 'choose_profile':
      bot.sendMessage(chatId, '👩 Chọn profile đăng bài:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👩 Linh Thảo', callback_data: 'profile_linhthao' },
              { text: '👩 Linh Dương', callback_data: 'profile_linhduong' },
            ],
          ],
        },
      });
      break;

    case 'help_post':
      bot.sendMessage(chatId,
        `📝 *Đăng FB cá nhân:*

*Chỉ text:*
\`/post nội dung bài viết\`

*Text + ảnh:*
Gửi ảnh + caption \`/post nội dung\`

*Nhiều ảnh:*
Gửi album + caption \`/post nội dung\``, { parse_mode: 'Markdown' });
      break;

    case 'help_group':
      bot.sendMessage(chatId,
        `👥 *Đăng Group:*

*Group nhanh (chỉ text):*
\`/asale nội dung\` → Asale
\`/tongkho nội dung\` → Tổng Kho
\`/allgroup nội dung\` → Cả 2 group

*Group nhanh (text + ảnh):*
Gửi ảnh + caption \`/asale nội dung\`
Gửi ảnh + caption \`/tongkho nội dung\`
Gửi ảnh + caption \`/allgroup nội dung\`

*Group khác (chỉ text):*
\`/post_group <group_id> nội dung\`

*Group khác (text + ảnh):*
Gửi ảnh + caption \`/post_group <group_id> nội dung\``, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏪 Asale', callback_data: 'info_asale' },
              { text: '📦 Tổng Kho', callback_data: 'info_tongkho' },
            ],
          ],
        },
      });
      break;

    case 'info_asale':
      bot.sendMessage(chatId, `🏪 *Asale*\nGroup ID: \`${config.groups.asale.id}\`\n\nDùng: \`/asale nội dung bài viết\``, { parse_mode: 'Markdown' });
      break;

    case 'info_tongkho':
      bot.sendMessage(chatId, `📦 *Tổng Kho*\nGroup ID: \`${config.groups.tongkho.id}\`\n\nDùng: \`/tongkho nội dung bài viết\``, { parse_mode: 'Markdown' });
      break;

    case 'status':
      checkDailyReset();
      let profileInfo = 'Chưa chọn';
      try {
        const p = playwright.getActiveProfile();
        profileInfo = p.name;
      } catch {}
      bot.sendMessage(chatId,
        `📊 *Trạng thái:*
- Profile: *${profileInfo}*
- Bài đã đăng hôm nay: *${postCount}/${config.posting.maxPostsPerDay}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Đổi profile', callback_data: 'choose_profile' },
              { text: '📝 Hướng dẫn', callback_data: 'help_post' },
            ],
          ],
        },
      });
      break;
  }
});

// Lệnh /start
bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Bạn không có quyền sử dụng bot này.');
    return;
  }

  bot.sendMessage(msg.chat.id,
    `Hello! Đây là *FB Auto Post* 🚀\nHãy chọn profile trình duyệt để bắt đầu:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👩 Linh Thảo', callback_data: 'profile_linhthao' },
          { text: '👩 Linh Dương', callback_data: 'profile_linhduong' },
        ],
        [
          { text: '📝 Hướng dẫn đăng bài', callback_data: 'help_post' },
          { text: '👥 Hướng dẫn đăng group', callback_data: 'help_group' },
        ],
        [
          { text: '📊 Trạng thái', callback_data: 'status' },
        ],
      ],
    },
  });
});

// Đăng lên trang cá nhân (chỉ text)
bot.onText(/\/post(?!_) (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.`);
    return;
  }

  const content = match[1];
  bot.sendMessage(msg.chat.id, 'Đang xử lý đăng bài lên trang cá nhân...');

  const result = await playwright.postToPersonal(content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, 'Đăng bài cá nhân thành công!', result);
  } else {
    bot.sendMessage(msg.chat.id, `Lỗi: ${result.error}`);
  }
});

// Đăng lên Group (chỉ text)
bot.onText(/\/post_group (\S+) (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.`);
    return;
  }

  const groupId = match[1];
  const content = match[2];
  bot.sendMessage(msg.chat.id, `Đang xử lý đăng bài lên Group ${groupId}...`);

  const result = await playwright.postToGroup(groupId, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, 'Đăng bài Group thành công!', result);
  } else {
    bot.sendMessage(msg.chat.id, `Lỗi: ${result.error}`);
  }
});

// Xử lý khi người dùng gửi ẢNH
bot.on('photo', async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  if (!requireProfile(msg.chat.id)) return;

  const caption = msg.caption || '';
  const photoSizes = msg.photo;
  const largestPhoto = photoSizes[photoSizes.length - 1];
  const mediaGroupId = msg.media_group_id;

  // Trường hợp 1 ảnh (không có media_group_id)
  if (!mediaGroupId) {
    const parsed = parseCaption(caption);
    if (!parsed) {
      bot.sendMessage(msg.chat.id, 'Caption không hợp lệ. Dùng: /post <nội dung> hoặc /post_group <id> <nội dung>');
      return;
    }
    await processPost(msg.chat.id, parsed, [largestPhoto.file_id]);
    return;
  }

  // Trường hợp album (nhiều ảnh) - gom lại
  if (pendingAlbums.has(mediaGroupId)) {
    // Album đã có, thêm ảnh vào
    const album = pendingAlbums.get(mediaGroupId);
    album.photos.push(largestPhoto.file_id);
    // Cập nhật caption nếu ảnh này có caption (chỉ ảnh đầu tiên có caption)
    if (caption) album.caption = caption;
  } else {
    // Album mới
    pendingAlbums.set(mediaGroupId, {
      photos: [largestPhoto.file_id],
      caption: caption,
      chatId: msg.chat.id,
    });
  }

  // Reset timer mỗi khi có ảnh mới
  const album = pendingAlbums.get(mediaGroupId);
  if (album.timer) clearTimeout(album.timer);

  album.timer = setTimeout(async () => {
    // Đã gom hết ảnh, xử lý
    const finalAlbum = pendingAlbums.get(mediaGroupId);
    pendingAlbums.delete(mediaGroupId);

    const parsed = parseCaption(finalAlbum.caption);
    if (!parsed) {
      bot.sendMessage(finalAlbum.chatId, 'Caption không hợp lệ. Dùng: /post <nội dung> hoặc /post_group <id> <nội dung>');
      return;
    }

    logger.info(`Album ${mediaGroupId}: ${finalAlbum.photos.length} ảnh, caption: ${finalAlbum.caption}`);
    await processPost(finalAlbum.chatId, parsed, finalAlbum.photos);
  }, ALBUM_WAIT_MS);
});

// Đăng nhanh vào group Asale (chỉ text)
bot.onText(/\/asale (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.`);
    return;
  }

  const content = match[1];
  const group = config.groups.asale;
  bot.sendMessage(msg.chat.id, `Đang xử lý đăng bài lên ${group.name}...`);

  const result = await playwright.postToGroup(group.id, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, `Đăng bài ${group.name} thành công!`, result);
  } else {
    bot.sendMessage(msg.chat.id, `Lỗi: ${result.error}`);
  }
});

// Đăng nhanh vào group Tổng Kho (chỉ text)
bot.onText(/\/tongkho (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày.`);
    return;
  }

  const content = match[1];
  const group = config.groups.tongkho;
  bot.sendMessage(msg.chat.id, `Đang xử lý đăng bài lên ${group.name}...`);

  const result = await playwright.postToGroup(group.id, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, `Đăng bài ${group.name} thành công!`, result);
  } else {
    bot.sendMessage(msg.chat.id, `Lỗi: ${result.error}`);
  }
});

// Đăng vào tất cả group (chỉ text)
bot.onText(/\/allgroup (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  const content = match[1];
  const groups = Object.values(config.groups);

  bot.sendMessage(msg.chat.id, `Đang xử lý đăng bài lên ${groups.length} group...`);

  for (const group of groups) {
    if (postCount >= config.posting.maxPostsPerDay) {
      bot.sendMessage(msg.chat.id, `Đã đạt giới hạn ${config.posting.maxPostsPerDay} bài/ngày. Dừng lại.`);
      break;
    }

    bot.sendMessage(msg.chat.id, `⏳ Đang đăng lên ${group.name}...`);
    const result = await playwright.postToGroup(group.id, content);
    postCount++;

    if (result.success) {
      await sendResult(msg.chat.id, `✅ ${group.name} thành công!`, result);
    } else {
      bot.sendMessage(msg.chat.id, `❌ ${group.name} lỗi: ${result.error}`);
    }

    // Delay giữa các group để tránh bị Facebook chặn
    if (groups.indexOf(group) < groups.length - 1) {
      const delay = Math.floor(Math.random() * (config.posting.maxDelay - config.posting.minDelay)) + config.posting.minDelay;
      bot.sendMessage(msg.chat.id, `⏰ Đợi ${Math.round(delay/1000)}s trước khi đăng group tiếp...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  bot.sendMessage(msg.chat.id, `🏁 Đã hoàn tất đăng bài lên ${groups.length} group!`);
});

// Xem trạng thái
bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  checkDailyReset();

  bot.sendMessage(msg.chat.id,
    `Trạng thái:
- Bài đã đăng hôm nay: ${postCount}/${config.posting.maxPostsPerDay}
- Ngày: ${lastResetDate}`
  );
});

// Cleanup khi tắt
process.on('SIGINT', async () => {
  logger.info('Đang tắt bot...');
  await playwright.closeBrowser();
  process.exit(0);
});

logger.info('Telegram bot đã khởi động!');
logger.info(`Cho phép user IDs: ${config.telegram.allowedUsers.join(', ')}`);
