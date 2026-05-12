/**
 * SCRAPE.JS — Lấy bài viết từ Facebook (Profile / Page / Group).
 *
 * Bước đầu hỗ trợ Profile. Page/Group sẽ reuse cùng parser ở bước sau vì
 * mbasic.facebook.com render cả 3 loại với DOM tương tự (data-ft div + h3 + abbr).
 *
 * Tại sao dùng mbasic:
 *  - HTML "cổ điển", không React class obfuscate → selector bền
 *  - Pagination link tường minh, không cần xử lý infinite scroll
 *  - Cùng cookie domain với facebook.com → session profile có sẵn dùng được luôn
 */

const cheerio = require('cheerio');
const post = require('./post');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');

const MBASIC = 'https://mbasic.facebook.com';
const MAX_PAGES = 20; // chặn vô hạn nếu FB trả pagination lạ
const PAGE_TIMEOUT = 30000;

function toMbasicProfileUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Thiếu URL/username profile');

  // Đã là URL → chuyển host về mbasic, giữ path
  try {
    const u = new URL(raw);
    u.hostname = 'mbasic.facebook.com';
    u.protocol = 'https:';
    return u.toString();
  } catch {
    // Không phải URL → coi như username hoặc numeric id
    if (/^\d+$/.test(raw)) return `${MBASIC}/profile.php?id=${raw}`;
    return `${MBASIC}/${raw.replace(/^\/+/, '')}`;
  }
}

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return `${MBASIC}${href.startsWith('/') ? '' : '/'}${href}`;
}

// Chuyển link mbasic → www để client dễ mở
function toWww(href) {
  const abs = absUrl(href);
  if (!abs) return null;
  return abs.replace(/^https:\/\/mbasic\.facebook\.com/, 'https://www.facebook.com');
}

// Trích story_fbid hoặc fbid từ link permalink để dedupe
function extractPostId(href) {
  if (!href) return null;
  const m = href.match(/story_fbid=(\d+)/) || href.match(/[?&]fbid=(\d+)/) || href.match(/\/posts\/(\d+)/);
  return m ? m[1] : null;
}

function parsePostsFromHtml(html) {
  const $ = cheerio.load(html);
  const posts = [];

  // mbasic profile: mỗi bài đăng nằm trong div có attr data-ft (JSON metadata).
  // Đôi khi là <article>. Bắt cả hai để bền hơn.
  const candidates = $('div[data-ft], article[data-ft]');

  candidates.each((_, el) => {
    const $el = $(el);

    // Author + link author: <h3> chứa <a> đầu tiên
    const authorLink = $el.find('h3 a').first();
    const author_name = authorLink.text().trim() || null;
    const author_url = toWww(authorLink.attr('href'));

    // Time: <abbr> trong post header
    const time_text = $el.find('abbr').first().text().trim() || null;

    // Permalink: link có "story_fbid" hoặc "/posts/" — thường là link "X giờ trước"
    const permalinkA = $el.find('a').filter((_, a) => {
      const h = $(a).attr('href') || '';
      return /story_fbid=|\/posts\/|permalink\.php|story\.php/.test(h);
    }).first();
    const permalink_raw = permalinkA.attr('href') || null;
    const permalink = toWww(permalink_raw);
    const post_id = extractPostId(permalink_raw) || null;

    // Text content: lấy text của các <p> trong post body (mbasic bọc text trong p)
    // Loại bỏ phần "Hơn" (See more) trailing.
    const text_parts = [];
    $el.find('p').each((_, p) => {
      const t = $(p).text().trim();
      if (t) text_parts.push(t);
    });
    const text = text_parts.join('\n').replace(/\s*Hơn$/i, '').trim() || null;

    // Images: mbasic render thumbnail inline
    const images = [];
    $el.find('img').each((_, img) => {
      const src = $(img).attr('src');
      if (src && /scontent|fbcdn/.test(src)) images.push(src);
    });

    // Reactions/comments count: mbasic show ở footer dạng "12 lượt thích", "3 bình luận"
    // Đơn giản parse số đầu tiên trong text footer.
    const footer_text = $el.find('a').last().parent().text();
    const reaction_count = parseCount(footer_text, /(\d[\d.,]*)\s*(lượt thích|like|reaction)/i);
    const comment_count = parseCount(footer_text, /(\d[\d.,]*)\s*(bình luận|comment)/i);
    const share_count = parseCount(footer_text, /(\d[\d.,]*)\s*(chia sẻ|share)/i);

    // Bỏ qua entry không có author + không có text + không có image (likely là noise)
    if (!author_name && !text && images.length === 0) return;

    posts.push({
      post_id,
      permalink,
      author_name,
      author_url,
      text,
      time_text,
      images,
      reaction_count,
      comment_count,
      share_count,
    });
  });

  // Next page: anchor có text "Xem thêm bài đăng" / "See more posts" hoặc href chứa cursor
  let next_href = null;
  $('a').each((_, a) => {
    const t = $(a).text().trim();
    const h = $(a).attr('href') || '';
    if (/Xem thêm bài đăng|See more posts|See more stories|Hiện thêm/i.test(t)) {
      next_href = h;
      return false;
    }
  });

  return { posts, next_href };
}

function parseCount(text, regex) {
  if (!text) return null;
  const m = text.match(regex);
  if (!m) return null;
  // "1,2K" / "1.234" → number gần đúng
  const raw = m[1].replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return null;
  if (/k$/i.test(text.slice(m.index, m.index + m[0].length + 1))) return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * Scrape bài viết từ profile.
 *
 * @param {object} opts
 * @param {string} opts.profileUrl  URL hoặc username FB của profile target
 * @param {number} [opts.limit=20]  Số post tối đa muốn lấy
 * @returns {Promise<{source_url, scraped_at, posts}>}
 */
async function scrapeProfile({ profileUrl, limit = 20 }) {
  if (!profileUrl) throw new Error('Thiếu profileUrl');
  const maxPosts = Math.max(1, Math.min(Number(limit) || 20, 200));

  const startUrl = toMbasicProfileUrl(profileUrl);
  logger.info(`[scrape] Profile → ${startUrl} (limit=${maxPosts})`);

  const ctx = await post.getBrowser();
  const page = await ctx.newPage();

  try {
    let currentUrl = startUrl;
    const seen = new Set();
    const collected = [];

    for (let pageIdx = 0; pageIdx < MAX_PAGES && collected.length < maxPosts; pageIdx++) {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

      const url = page.url();
      if (/login|checkpoint/.test(url)) {
        throw new Error(`Profile session hết hạn (URL hiện tại: ${url}). Đăng nhập lại tại tab "Quản lý tài khoản".`);
      }

      const html = await page.content();
      const { posts, next_href } = parsePostsFromHtml(html);

      for (const p of posts) {
        const key = p.post_id || p.permalink || `${p.author_name}|${p.time_text}|${(p.text || '').slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(p);
        if (collected.length >= maxPosts) break;
      }

      logger.info(`[scrape] Page ${pageIdx + 1}: parsed ${posts.length}, total ${collected.length}/${maxPosts}`);

      if (!next_href || collected.length >= maxPosts) break;
      currentUrl = absUrl(next_href);
      await randomDelay(1500, 3500);
    }

    return {
      source_url: startUrl,
      scraped_at: new Date().toISOString(),
      count: collected.length,
      posts: collected,
    };
  } finally {
    try { await page.close(); } catch {}
  }
}

module.exports = {
  scrapeProfile,
  // Export internals để test riêng
  _internals: { parsePostsFromHtml, toMbasicProfileUrl, extractPostId },
};
