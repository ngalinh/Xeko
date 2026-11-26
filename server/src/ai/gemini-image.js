'use strict';

// Ghép ảnh sản phẩm (website) vào ảnh RedNote bằng model ảnh của Gemini.
// CHƯA kiểm chứng được từ sandbox này (không có mạng) — tên model
// 'gemini-2.5-flash-image' và hình dạng response (inlineData) dựa theo tài
// liệu Gemini image-gen hiện biết. Nếu chạy thật báo lỗi 404 (model not
// found) hoặc không parse được ảnh kết quả, cần đối chiếu lại tài liệu mới
// nhất và chỉnh GEMINI_IMAGE_MODEL / phần đọc response bên dưới.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_IMAGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

// Chặn SSRF cơ bản: chỉ nhận https, từ chối hostname nội bộ/private rõ ràng.
// Không phải giải pháp chống DNS-rebinding đầy đủ, nhưng request chỉ tới từ
// user đã login + được phân quyền (auth gate /api/* ở index.js), không phải
// endpoint công khai ẩn danh.
const PRIVATE_HOSTNAME_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?)/i;

function assertSafeImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL ảnh không hợp lệ'); }
  if (url.protocol !== 'https:') throw new Error('Chỉ hỗ trợ URL ảnh https');
  if (PRIVATE_HOSTNAME_RE.test(url.hostname)) throw new Error('URL ảnh không hợp lệ');
  return url.href;
}

async function downloadImageAsInlinePart(url, fetchFn) {
  const safeUrl = assertSafeImageUrl(url);
  const response = await fetchFn(safeUrl, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  const type = (response.headers.get('content-type') || '').split(';')[0];
  const allowed = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };
  if (!response.ok || !allowed[type] || !response.body) {
    throw new Error(`Không tải được ảnh (${url}): HTTP ${response.status}, content-type ${type || '(none)'}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error('Ảnh vượt quá giới hạn 12 MB.');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Ảnh rỗng.');
  return { inline_data: { mime_type: type, data: Buffer.concat(chunks).toString('base64') } };
}

// productImageUrls: 1-4 ảnh CÙNG 1 sản phẩm, càng nhiều góc (mặt trước, cận
// cảnh hoạ tiết/logo, mặt sau) càng giúp model hiểu đúng kiểu dáng thật —
// tránh tự bịa chi tiết (vd thêm/bớt nút áo) khi chỉ thấy 1 góc.
async function mergeProductIntoPhoto(rednoteImageUrl, productImageUrls, fetchFn = fetch) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình');
  const urls = Array.isArray(productImageUrls) ? productImageUrls : [productImageUrls];
  if (urls.length === 0) throw new Error('Thiếu ảnh sản phẩm');

  const [photoPart, ...productParts] = await Promise.all([
    downloadImageAsInlinePart(rednoteImageUrl, fetchFn),
    ...urls.map((u) => downloadImageAsInlinePart(u, fetchFn)),
  ]);

  const body = {
    contents: [{
      parts: [
        { text: 'Ảnh 1 là ảnh người mẫu/bối cảnh tham khảo — GIỮ NGUYÊN 100% khuôn mặt, tóc, vóc dáng, tư thế, bối cảnh và ánh sáng của NGƯỜI TRONG ẢNH 1 này. Bỏ qua hoàn toàn trang phục đang mặc trong ảnh 1.' },
        photoPart,
        { text: `${productParts.length} ảnh tiếp theo là CÙNG MỘT sản phẩm thật (nhiều góc chụp khác nhau) cần quảng cáo — đây là nguồn sự thật tuyệt đối về hình dáng, màu sắc, hoạ tiết, logo của sản phẩm. CÁC ẢNH NÀY CÓ THỂ CHỤP TRÊN NGƯỜI MẪU KHÁC — TUYỆT ĐỐI BỎ QUA khuôn mặt/tóc/người trong các ảnh này, CHỈ lấy thông tin về món đồ (màu sắc, chất liệu, hoạ tiết, kiểu dáng), không được dùng khuôn mặt hay đặc điểm người trong các ảnh này để thay cho người ở ảnh 1.` },
        ...productParts,
        { text: 'Hãy tạo lại ảnh 1: giữ nguyên khuôn mặt, tóc, vóc dáng, tư thế, bối cảnh, ánh sáng của NGƯỜI TRONG ẢNH 1, nhưng thay thế HOÀN TOÀN món đồ đang mặc bằng ĐÚNG sản phẩm ở các ảnh sau. Ưu tiên TUYỆT ĐỐI độ chính xác của sản phẩm hơn tính thẩm mỹ: giữ đúng 100% màu sắc, chất liệu, hoạ tiết, logo, kiểu dáng (cổ áo, tay áo, số nút, độ dài) như trong ảnh sản phẩm — KHÔNG được tự thêm/bớt hay đổi chi tiết nào. KHÔNG được đổi khuôn mặt/danh tính người trong ảnh 1 sang người trong ảnh sản phẩm. QUAN TRỌNG VỀ MÀU SẮC: ánh sáng môi trường trong ảnh 1 có thể ấm/vàng — TUYỆT ĐỐI không để ánh sáng đó làm ám màu, đổi tông hay giảm độ bão hoà của trang phục (ví dụ không được biến đỏ tươi thành đỏ gạch/đỏ nâu); giữ đúng tông màu và độ bão hoà như nhìn dưới ánh sáng trắng trung tính, y hệt ảnh sản phẩm. Chỉ trả về 1 ảnh kết quả, không trả text.' },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  const res = await fetchFn(`${GEMINI_IMAGE_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Gemini image API trả về không phải JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Gemini image API lỗi ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  if (!imagePart) throw new Error('Gemini không trả về ảnh kết quả.');
  const inline = imagePart.inlineData || imagePart.inline_data;
  const mimeType = inline.mimeType || inline.mime_type || 'image/png';
  return { mimeType, base64: inline.data };
}

module.exports = { mergeProductIntoPhoto };
