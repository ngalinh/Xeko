/**
 * Cấu hình TẬP TRUNG khoảng cách (delay) giữa các bài đăng — chống FB/Zalo flag spam.
 *
 * Có 2 loại khoảng cách:
 *   1) GROUP   — giữa 2 bài của CÙNG 1 profile/account (đăng lần lượt các kênh/group).
 *   2) PROFILE — giữa 2 bài của 2 profile/account KHÁC nhau (giãn để không "đăng
 *                đồng loạt cùng một giây" → tránh bị phát hiện hành vi bất thường).
 *
 * Mỗi loại là 1 khoảng [min, max]; mỗi lần lấy 1 giá trị NGẪU NHIÊN trong khoảng
 * (giống người thật, khó bị phát hiện hơn so với delay cố định).
 *
 * Chỉnh qua env (ms). Giữ tương thích với env cũ:
 *   ZALO_POST_MIN_INTERVAL_MS / POST_MIN_INTERVAL_MS → fallback cho GROUP min.
 *
 *   POST_GROUP_DELAY_MIN_MS    (mặc định 30000)  — cùng profile, giữa các group
 *   POST_GROUP_DELAY_MAX_MS    (mặc định 60000)
 *   POST_PROFILE_DELAY_MIN_MS  (mặc định 15000)  — giữa 2 profile khác nhau
 *   POST_PROFILE_DELAY_MAX_MS  (mặc định 30000)
 */

function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

// --- GROUP: cùng 1 profile/account, giữa các kênh/group ---
const _groupMinDefault = num('ZALO_POST_MIN_INTERVAL_MS', num('POST_MIN_INTERVAL_MS', 30_000));
const GROUP_DELAY_MIN_MS = num('POST_GROUP_DELAY_MIN_MS', _groupMinDefault);
const GROUP_DELAY_MAX_MS = Math.max(
  GROUP_DELAY_MIN_MS,
  num('POST_GROUP_DELAY_MAX_MS', Math.max(GROUP_DELAY_MIN_MS, 60_000))
);

// --- PROFILE: giữa 2 profile/account KHÁC nhau ---
const PROFILE_DELAY_MIN_MS = num('POST_PROFILE_DELAY_MIN_MS', 15_000);
const PROFILE_DELAY_MAX_MS = Math.max(
  PROFILE_DELAY_MIN_MS,
  num('POST_PROFILE_DELAY_MAX_MS', Math.max(PROFILE_DELAY_MIN_MS, 30_000))
);

function randBetween(min, max) {
  return max > min ? min + Math.random() * (max - min) : min;
}

/** Khoảng cách ngẫu nhiên giữa 2 group cùng profile (ms). */
function groupDelayMs() { return randBetween(GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS); }

/** Khoảng cách ngẫu nhiên giữa 2 profile khác nhau (ms). */
function profileDelayMs() { return randBetween(PROFILE_DELAY_MIN_MS, PROFILE_DELAY_MAX_MS); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_MAX_MS,
  PROFILE_DELAY_MIN_MS,
  PROFILE_DELAY_MAX_MS,
  groupDelayMs,
  profileDelayMs,
  randBetween,
  sleep,
};
