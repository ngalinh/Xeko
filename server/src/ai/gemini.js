const fs = require('fs');
const path = require('path');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function fileToInlinePart(filePath) {
  const data = fs.readFileSync(filePath);
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return { inline_data: { mime_type: mimeMap[ext] || 'image/jpeg', data: data.toString('base64') } };
}

async function suggestContent(imagePaths, contentGuide, exampleImagePaths = [], style = 'short', category = '', productName = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình');

  const guideSection = contentGuide ? `\n\nHướng dẫn giọng văn:\n${contentGuide}\n` : '';

  const parts = [];

  if (exampleImagePaths.length > 0) {
    parts.push({ text: `Đây là ${exampleImagePaths.length} ví dụ về phong cách bài viết mẫu của thương hiệu. Hãy học phong cách, giọng văn và cách dùng hashtag từ các ví dụ này:` });
    for (const p of exampleImagePaths) {
      if (fs.existsSync(p)) parts.push(fileToInlinePart(p));
    }
    parts.push({ text: '---\nBây giờ hãy phân tích ảnh sản phẩm dưới đây và viết content theo đúng phong cách đó:' });
  }

  for (const p of imagePaths) {
    parts.push(fileToInlinePart(p));
  }

  const categoryContext = {
    fashion:     'Sản phẩm thuộc ngành THỜI TRANG. Dùng từ ngữ thời trang (chất liệu, kiểu dáng, phối đồ, phong cách), gợi cảm giác tự tin và thẩm mỹ.',
    beauty:      'Sản phẩm thuộc ngành MỸ PHẨM / LÀM ĐẸP. Nhấn mạnh thành phần, công dụng, kết quả thấy rõ, cảm giác trên da.',
    electronics: 'Sản phẩm thuộc ngành ĐIỆN TỬ / CÔNG NGHỆ. Nêu thông số kỹ thuật nổi bật, tính năng thực tế, lợi ích người dùng.',
    accessories: 'Sản phẩm là PHỤ KIỆN (túi, giày, trang sức...). Tập trung vào thiết kế, chất liệu, sự phối hợp với outfit.',
    health:      'Sản phẩm thuộc ngành SỨC KHOẺ / DINH DƯỠNG. Nhấn mạnh lợi ích sức khoẻ, thành phần tự nhiên, độ an toàn.',
  };
  const catInstruction = categoryContext[category] ? `\nDanh mục sản phẩm: ${categoryContext[category]}` : '';

  const styleGuides = {
    short:    'Viết 1 bài viết NGẮN GỌN, súc tích 2-3 dòng + 3-5 hashtag. Đi thẳng vào điểm nổi bật nhất.',
    detailed: 'Viết 1 bài viết CHI TIẾT 5-8 dòng, nêu đầy đủ tính năng, chất liệu, lợi ích + hashtag.',
    story:    'Viết 1 bài viết theo phong cách KỂ CHUYỆN cảm xúc 5-7 dòng, tạo kết nối với người đọc + hashtag.',
    promo:    'Viết 1 bài viết QUẢNG CÁO mạnh, có call-to-action rõ ràng, tạo urgency (giảm giá/limited), 4-6 dòng + hashtag.',
    viral:    'Viết 1 bài viết theo phong cách VIRAL, độc đáo gây tò mò, dùng hook mạnh đầu tiên, 4-6 dòng + hashtag.',
  };
  const styleInstruction = styleGuides[style] || styleGuides.short;

  const productFocus = productName
    ? `\nSản phẩm cần tập trung: "${productName}" — hãy viết content xoay quanh sản phẩm này, bỏ qua các yếu tố khác trong ảnh.`
    : '';

  parts.push({
    text: `Bạn là chuyên gia viết content mạng xã hội.${guideSection}${catInstruction}${productFocus}
Hãy viết content để đăng Facebook/Zalo cho sản phẩm trong ảnh.

Phong cách yêu cầu: ${styleInstruction}

Yêu cầu chung:
- Viết tự nhiên, phù hợp mạng xã hội Việt Nam
- Chỉ trả về 1 bài viết hoàn chỉnh duy nhất, không tiêu đề, không đánh số`,
  });

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
  };

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API lỗi ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const suggestions = text.split(/\n---\n|^---$/m).map(s => s.trim()).filter(Boolean);
  return suggestions;
}

module.exports = { suggestContent };
