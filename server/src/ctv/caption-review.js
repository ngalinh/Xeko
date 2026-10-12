const dictionary = require('./brand-dictionary.json');

// Keep UTF-16 offsets into the original caption, including emoji and accents.
function normalized(text) {
  let value = '', starts = [], ends = [], offset = 0;
  for (const character of text) {
    const folded = character.replace(/🅰/u, 'a').replace(/đ/gi, 'd')
      .normalize('NFKD').replace(/[\p{M}\u200B-\u200D\uFE0F]/gu, '').toLowerCase();
    for (let i = 0; i < folded.length; i++) { starts.push(offset); ends.push(offset + character.length); }
    value += folded; offset += character.length;
  }
  return { value, starts, ends };
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matches(text, aliases, kind, label, flexible = false) {
  const n = normalized(text), found = [];
  for (const alias of aliases) {
    const folded = normalized(alias).value;
    const pattern = flexible && /^[a-z ]+$/.test(folded)
      ? [...folded.replace(/ /g, '')].map(escape).join('[ ._\u200b-]{0,3}') : escape(folded).replace(/ +/g, '\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'gu');
    for (const hit of n.value.matchAll(re)) {
      const start = n.starts[hit.index], end = n.ends[hit.index + hit[0].length - 1];
      found.push({ start, end, text: text.slice(start, end), kind, label: label || alias, certainty: 'clear' });
    }
  }
  return found;
}
const SALES = ['nhận order','order','chốt đơn','nhận đơn','đặt hàng','có sẵn','còn hàng','đủ size','sale','giảm giá','bán','giá sỉ','in stock'];
const EXCLUSIONS = ['không bán','ngừng bán','không nhận order','tìm mua','cần mua','ai bán','review','chia sẻ'];
const RECRUIT = ['tuyển CTV','tuyển cộng tác viên','tuyển đại lý','tuyển nhà phân phối'];
function scanText(text, customBrands = []) {
  text = String(text || '').slice(0,6000);
  const folded = normalized(text).value;
  const fashion = /\b(ao|quan|giay|dep|tui|vi|size|vay|dam|nuoc hoa|my pham|son|kem|dong ho)\b/.test(folded);
  let spans = [];
  for (const brand of [...dictionary.brands, ...customBrands]) {
    for (const span of matches(text, [brand.name, ...brand.aliases], 'brand', brand.name, true)) {
      const token = normalized(span.text).value.replace(/[^a-z0-9]/g, '');
      const nearby = normalized(text.slice(Math.max(0,span.start - 25),span.end + 45)).value;
      if (token === 'ck' && /\b(chuyen khoan|ngan hang|stk|truoc|coc|thanh toan)\b/.test(nearby)) continue;
      if (token.length <= 3 || ['coach','guess','target','mac'].includes(token)) span.certainty = fashion ? 'clear' : 'possible';
      if (token === 'mac' && /\b(macbook|may tinh|laptop|apple|dia chi mac)\b/.test(nearby)) continue;
      if (brand.customAlias) span.customAlias = brand.customAlias;
      spans.push(span);
    }
  }
  const exclusions = matches(text, EXCLUSIONS, 'context', 'Ngữ cảnh cần kiểm tra');
  const sales = matches(text, SALES, 'sales', 'Dấu hiệu bán hàng').filter(s =>
    normalized(s.text).value !== 'ban' || s.text.toLowerCase().normalize('NFC') === 'bán'
    || (s.text.toLowerCase() === 'ban' && fashion));
  const recruitment = matches(text, RECRUIT, 'recruitment', 'Nhắc tuyển CTV/đại lý');
  const recruitmentUncertain = /\b(khong|ngung|chua|tim viec|chia se)\b/.test(folded);
  recruitment.forEach(s => { s.certainty = 'possible'; });
  spans.push(...matches(text, dictionary.retailers, 'retailer', undefined), ...sales, ...exclusions, ...recruitment);
  // Prefer a full name or a longer phrase over its overlapping abbreviation.
  spans.sort((a,b) => a.start - b.start || b.end - a.end);
  const unique = [];
  for (const span of spans) if (!unique.some(s => span.start < s.end && span.end > s.start)) unique.push(span);
  return { text, spans: unique, salesSignal: sales.length > 0 && exclusions.length === 0,
    needsContext: exclusions.length > 0, recruitmentSignal: recruitment.length > 0 && !recruitmentUncertain };
}

function evaluateCaptions(snapshot, customBrands = []) {
  const posts = [...new Map((snapshot.posts || []).filter(p => typeof p === 'string' && p.trim())
    .map(p => [normalized(p).value.replace(/\s+/g,' ').trim(), p])).values()].slice(0,5).map(text => scanText(text, customBrands));
  const bioReview = scanText(snapshot.headerBio || snapshot.bio || '', customBrands);
  const salesPostCount = posts.filter(p => p.salesSignal).length;
  const brands = [...new Set(posts.flatMap(p => p.spans.filter(s => s.kind === 'brand' && s.certainty === 'clear').map(s => s.label)))];
  const retailers = [...new Set(posts.flatMap(p => p.spans.filter(s => s.kind === 'retailer').map(s => s.label)))];
  const recruitment = [bioReview, ...posts].some(p => p.recruitmentSignal);
  const reason = snapshot.blocked || (!posts.length ? 'Chưa đọc được caption; hãy quét lại.'
    : `${posts.length} caption, ${salesPostCount} bài có từ khóa bán hàng; ${brands.length} brand nhận diện rõ. Bạn cần đọc bằng chứng và tự chọn khách.`);
  return { type: snapshot.pageEvidence ? 'page' : snapshot.personalEvidence ? 'personal' : 'unknown',
    provider: 'keywords', model: 'caption-rules-v1', dictionaryVersion: dictionary.version,
    criteriaVersion: 'us-website-products-v2', eligible: false, sellerUS: 'unknown', confidence: null,
    reason, gateReason: reason, bio: bioReview.text, bioReview, captionReviews: posts, brands, retailers,
    suggestion: !posts.length || snapshot.blocked ? 'Chưa đọc đủ dữ liệu' : salesPostCount >= 3 && (brands.length || retailers.length) && !recruitment ? 'Có dấu hiệu phù hợp — cần duyệt' : 'Cần kiểm tra',
    manualOnly: true, collectionBlocked: !!snapshot.blocked || !posts.length,
    reviewedPostCount: posts.length, reviewedImageCount: 0, salesPostCount,
    evidence: posts.filter(p => p.salesSignal).map(p => p.text.slice(0,700)),
    captionAnalysis: reason, wholesaleRecruitment: { verdict: 'unknown', excluded: false, evidence: [],
      reason: recruitment ? 'Có từ khóa tuyển CTV/đại lý; cần kiểm tra chủ thể và ngữ cảnh, chưa tự loại.' : 'Chưa kết luận tuyển mạng lưới từ bộ từ khóa.' } };
}
module.exports = { scanText, evaluateCaptions, normalized };
