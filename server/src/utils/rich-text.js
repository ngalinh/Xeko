/**
 * Tiện ích xử lý "rich text" tối giản cho nội dung bài đăng.
 *
 * Người dùng đánh dấu chữ in đậm bằng cú pháp markdown **đậm** ngay trong ô
 * soạn nội dung (textarea). Tuỳ nền tảng đích mà ta xử lý khác nhau:
 *   - Salework (Zalo): editor là contenteditable (rich text) → dán dưới dạng
 *     HTML để giữ in đậm. Dùng boldToHtml().
 *   - Facebook: ô soạn chỉ nhận plain text → bỏ dấu ** đi cho sạch, tránh hiển
 *     thị ký tự ** thừa. Dùng stripBold().
 */

// Khớp **...** không chứa xuống dòng; lười (lazy) để không "ngốn" quá nhiều.
const BOLD_RE = /\*\*(.+?)\*\*/g;

/** Bỏ dấu ** in đậm, trả về plain text (dùng cho Facebook & fallback). */
function stripBold(message) {
  if (!message) return message;
  return message.replace(BOLD_RE, '$1');
}

/** True nếu message có chứa cú pháp in đậm **...**. */
function hasBold(message) {
  if (!message) return false;
  BOLD_RE.lastIndex = 0;
  return BOLD_RE.test(message);
}

/**
 * Trả về danh sách các đoạn chữ cần in đậm (phần bên trong **...**), theo đúng
 * thứ tự xuất hiện. Dùng để bôi đen từng đoạn rồi nhấn Ctrl+B trong editor.
 */
function boldSegments(message) {
  if (!message) return [];
  const out = [];
  let m;
  BOLD_RE.lastIndex = 0;
  while ((m = BOLD_RE.exec(message)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Chuyển message (có **đậm**) thành HTML để dán vào editor rich text.
 * Escape ký tự HTML trước, sau đó mới đổi **...** thành <strong>, và xuống dòng
 * thành <br> để giữ nguyên bố cục.
 */
function boldToHtml(message) {
  if (!message) return '';
  const escaped = escapeHtml(message);
  const withBold = escaped.replace(BOLD_RE, '<strong>$1</strong>');
  return withBold.replace(/\r?\n/g, '<br>');
}

module.exports = { stripBold, hasBold, boldSegments, boldToHtml, escapeHtml };
