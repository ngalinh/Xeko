const db = require('./db');

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO scraped_posts (
    scraped_at, source_type, source_url, post_id, permalink,
    author_name, author_url, text, time_text, images,
    reaction_count, comment_count, share_count, profile
  ) VALUES (
    @scraped_at, @source_type, @source_url, @post_id, @permalink,
    @author_name, @author_url, @text, @time_text, @images,
    @reaction_count, @comment_count, @share_count, @profile
  )
`);

const listBySourceStmt = db.prepare(`
  SELECT * FROM scraped_posts
  WHERE source_type = ? AND source_url = ?
  ORDER BY scraped_at DESC, id DESC
  LIMIT ?
`);

function saveScrapedBatch({ sourceType, sourceUrl, scrapedAt, profile, posts }) {
  const tx = db.transaction((rows) => {
    let inserted = 0;
    for (const p of rows) {
      insertStmt.run({
        scraped_at: scrapedAt,
        source_type: sourceType,
        source_url: sourceUrl,
        post_id: p.post_id || null,
        permalink: p.permalink || null,
        author_name: p.author_name || null,
        author_url: p.author_url || null,
        text: p.text || null,
        time_text: p.time_text || null,
        images: p.images && p.images.length ? JSON.stringify(p.images) : null,
        reaction_count: p.reaction_count ?? null,
        comment_count: p.comment_count ?? null,
        share_count: p.share_count ?? null,
        profile: profile || null,
      });
      inserted++;
    }
    return inserted;
  });
  return tx(posts);
}

function listScrapedBySource(sourceType, sourceUrl, limit = 100) {
  const rows = listBySourceStmt.all(sourceType, sourceUrl, Math.max(1, Math.min(limit, 500)));
  return rows.map(r => ({
    ...r,
    images: r.images ? safeJsonParse(r.images) : [],
  }));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}

module.exports = { saveScrapedBatch, listScrapedBySource };
