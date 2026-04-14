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
const ALBUM_WAIT_MS = 2000; // Doi 2 giay de gom het anh trong album

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
 * Phan tich caption de xac dinh target va noi dung
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
 * Xu ly dang bai (goi sau khi da gom het anh)
 */
async function processPost(chatId, parsed, photoFileIds) {
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(chatId, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.`);
    return;
  }

  const downloadedFiles = [];
  try {
    // Tai tat ca anh
    for (const fileId of photoFileIds) {
      const localPath = await downloadTelegramPhoto(fileId);
      downloadedFiles.push(localPath);
    }
    logger.info(`Da tai ${downloadedFiles.length} anh`);

    // Dang len tat ca group
    if (parsed.target === 'allgroup') {
      const groups = Object.values(config.groups);
      bot.sendMessage(chatId, `Dang tai ${downloadedFiles.length} anh va dang len ${groups.length} group...`);

      for (const group of groups) {
        if (postCount >= config.posting.maxPostsPerDay) {
          bot.sendMessage(chatId, `Da dat gioi han. Dung lai.`);
          break;
        }

        bot.sendMessage(chatId, `⏳ Dang len ${group.name}...`);
        const result = await playwright.postToGroup(group.id, parsed.message, downloadedFiles);
        postCount++;

        if (result.success) {
          await sendResult(chatId, `✅ ${group.name} thanh cong!`, result);
        } else {
          bot.sendMessage(chatId, `❌ ${group.name} loi: ${result.error}`);
        }

        if (groups.indexOf(group) < groups.length - 1) {
          const delay = Math.floor(Math.random() * (config.posting.maxDelay - config.posting.minDelay)) + config.posting.minDelay;
          bot.sendMessage(chatId, `⏰ Doi ${Math.round(delay/1000)}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      bot.sendMessage(chatId, `🏁 Hoan tat dang ${groups.length} group!`);
      return;
    }

    // Dang 1 group hoac ca nhan
    const targetLabel = parsed.target === 'group' ? `Group ${parsed.groupId}` : 'trang ca nhan';
    bot.sendMessage(chatId, `Dang tai ${downloadedFiles.length} anh va dang bai len ${targetLabel}...`);

    let result;
    if (parsed.target === 'group') {
      result = await playwright.postToGroup(parsed.groupId, parsed.message, downloadedFiles);
    } else {
      result = await playwright.postToPersonal(parsed.message, downloadedFiles);
    }
    postCount++;

    if (result.success) {
      await sendResult(chatId, `Dang bai ${targetLabel} kem ${downloadedFiles.length} anh thanh cong!`, result);
    } else {
      bot.sendMessage(chatId, `Loi: ${result.error}`);
    }
  } catch (error) {
    logger.error(`Loi: ${error.message}`);
    bot.sendMessage(chatId, `Loi: ${error.message}`);
  } finally {
    cleanupTempFiles(downloadedFiles);
  }
}

/**
 * Gui ket qua ve Telegram: text + link (neu co) + screenshot
 */
async function sendResult(chatId, message, result) {
  let text = message;
  if (result.postUrl) {
    text += `\nLink: ${result.postUrl}`;
  }
  await bot.sendMessage(chatId, text);

  // Gui screenshot bai viet
  if (result.screenshot && fs.existsSync(result.screenshot)) {
    try {
      await bot.sendPhoto(chatId, result.screenshot, { caption: 'Screenshot bai viet' });
    } catch (e) {
      logger.error(`Loi gui screenshot: ${e.message}`);
    }
  }
}

// Chon profile va gui thong bao
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
    bot.sendMessage(chatId, `Loi: ${e.message}`);
  }
}

// Chon profile /linhthao
bot.onText(/\/linhthao/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  selectProfile(msg.chat.id, 'linhthao');
});

// Chon profile /linhduong
bot.onText(/\/linhduong/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  selectProfile(msg.chat.id, 'linhduong');
});

// Kiem tra profile truoc khi dang bai
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

// Xu ly callback buttons
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

// Lenh /start
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

// Dang len trang ca nhan (chi text)
bot.onText(/\/post(?!_) (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.`);
    return;
  }

  const content = match[1];
  bot.sendMessage(msg.chat.id, 'Dang xu ly dang bai len trang ca nhan...');

  const result = await playwright.postToPersonal(content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, 'Dang bai ca nhan thanh cong!', result);
  } else {
    bot.sendMessage(msg.chat.id, `Loi: ${result.error}`);
  }
});

// Dang len Group (chi text)
bot.onText(/\/post_group (\S+) (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.`);
    return;
  }

  const groupId = match[1];
  const content = match[2];
  bot.sendMessage(msg.chat.id, `Dang xu ly dang bai len Group ${groupId}...`);

  const result = await playwright.postToGroup(groupId, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, 'Dang bai Group thanh cong!', result);
  } else {
    bot.sendMessage(msg.chat.id, `Loi: ${result.error}`);
  }
});

// Xu ly khi nguoi dung gui ANH
bot.on('photo', async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  if (!requireProfile(msg.chat.id)) return;

  const caption = msg.caption || '';
  const photoSizes = msg.photo;
  const largestPhoto = photoSizes[photoSizes.length - 1];
  const mediaGroupId = msg.media_group_id;

  // Truong hop 1 anh (khong co media_group_id)
  if (!mediaGroupId) {
    const parsed = parseCaption(caption);
    if (!parsed) {
      bot.sendMessage(msg.chat.id, 'Caption khong hop le. Dung: /post <noi dung> hoac /post_group <id> <noi dung>');
      return;
    }
    await processPost(msg.chat.id, parsed, [largestPhoto.file_id]);
    return;
  }

  // Truong hop album (nhieu anh) - gom lai
  if (pendingAlbums.has(mediaGroupId)) {
    // Album da co, them anh vao
    const album = pendingAlbums.get(mediaGroupId);
    album.photos.push(largestPhoto.file_id);
    // Cap nhat caption neu anh nay co caption (chi anh dau tien co caption)
    if (caption) album.caption = caption;
  } else {
    // Album moi
    pendingAlbums.set(mediaGroupId, {
      photos: [largestPhoto.file_id],
      caption: caption,
      chatId: msg.chat.id,
    });
  }

  // Reset timer moi khi co anh moi
  const album = pendingAlbums.get(mediaGroupId);
  if (album.timer) clearTimeout(album.timer);

  album.timer = setTimeout(async () => {
    // Da gom het anh, xu ly
    const finalAlbum = pendingAlbums.get(mediaGroupId);
    pendingAlbums.delete(mediaGroupId);

    const parsed = parseCaption(finalAlbum.caption);
    if (!parsed) {
      bot.sendMessage(finalAlbum.chatId, 'Caption khong hop le. Dung: /post <noi dung> hoac /post_group <id> <noi dung>');
      return;
    }

    logger.info(`Album ${mediaGroupId}: ${finalAlbum.photos.length} anh, caption: ${finalAlbum.caption}`);
    await processPost(finalAlbum.chatId, parsed, finalAlbum.photos);
  }, ALBUM_WAIT_MS);
});

// Dang nhanh vao group Asale (chi text)
bot.onText(/\/asale (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.`);
    return;
  }

  const content = match[1];
  const group = config.groups.asale;
  bot.sendMessage(msg.chat.id, `Dang xu ly dang bai len ${group.name}...`);

  const result = await playwright.postToGroup(group.id, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, `Dang bai ${group.name} thanh cong!`, result);
  } else {
    bot.sendMessage(msg.chat.id, `Loi: ${result.error}`);
  }
});

// Dang nhanh vao group Tong Kho (chi text)
bot.onText(/\/tongkho (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  if (postCount >= config.posting.maxPostsPerDay) {
    bot.sendMessage(msg.chat.id, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay.`);
    return;
  }

  const content = match[1];
  const group = config.groups.tongkho;
  bot.sendMessage(msg.chat.id, `Dang xu ly dang bai len ${group.name}...`);

  const result = await playwright.postToGroup(group.id, content);
  postCount++;

  if (result.success) {
    await sendResult(msg.chat.id, `Dang bai ${group.name} thanh cong!`, result);
  } else {
    bot.sendMessage(msg.chat.id, `Loi: ${result.error}`);
  }
});

// Dang vao tat ca group (chi text)
bot.onText(/\/allgroup (.+)/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  if (msg.photo) return;
  if (!requireProfile(msg.chat.id)) return;
  checkDailyReset();

  const content = match[1];
  const groups = Object.values(config.groups);

  bot.sendMessage(msg.chat.id, `Dang xu ly dang bai len ${groups.length} group...`);

  for (const group of groups) {
    if (postCount >= config.posting.maxPostsPerDay) {
      bot.sendMessage(msg.chat.id, `Da dat gioi han ${config.posting.maxPostsPerDay} bai/ngay. Dung lai.`);
      break;
    }

    bot.sendMessage(msg.chat.id, `⏳ Dang len ${group.name}...`);
    const result = await playwright.postToGroup(group.id, content);
    postCount++;

    if (result.success) {
      await sendResult(msg.chat.id, `✅ ${group.name} thanh cong!`, result);
    } else {
      bot.sendMessage(msg.chat.id, `❌ ${group.name} loi: ${result.error}`);
    }

    // Delay giua cac group de tranh bi Facebook chan
    if (groups.indexOf(group) < groups.length - 1) {
      const delay = Math.floor(Math.random() * (config.posting.maxDelay - config.posting.minDelay)) + config.posting.minDelay;
      bot.sendMessage(msg.chat.id, `⏰ Doi ${Math.round(delay/1000)}s truoc khi dang group tiep...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  bot.sendMessage(msg.chat.id, `🏁 Da hoan tat dang bai len ${groups.length} group!`);
});

// Xem trang thai
bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  checkDailyReset();

  bot.sendMessage(msg.chat.id,
    `Trang thai:
- Bai da dang hom nay: ${postCount}/${config.posting.maxPostsPerDay}
- Ngay: ${lastResetDate}`
  );
});

// Cleanup khi tat
process.on('SIGINT', async () => {
  logger.info('Dang tat bot...');
  await playwright.closeBrowser();
  process.exit(0);
});

logger.info('Telegram bot da khoi dong!');
logger.info(`Cho phep user IDs: ${config.telegram.allowedUsers.join(', ')}`);
