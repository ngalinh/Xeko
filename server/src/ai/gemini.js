const fs = require('fs');
const path = require('path');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

function fileToInlinePart(filePath) {
  const data = fs.readFileSync(filePath);
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return { inline_data: { mime_type: mimeMap[ext] || 'image/jpeg', data: data.toString('base64') } };
}

async function suggestContent(imagePaths, contentGuide, exampleImagePaths = []) {
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

  parts.push({
    text: `Bạn là chuyên gia viết content mạng xã hội.${guideSection}
Hãy viết 2 đề xuất content để đăng Facebook/Zalo cho sản phẩm trong ảnh.

Yêu cầu:
- Mỗi đề xuất là 1 bài viết hoàn chỉnh, bao gồm hashtag liên quan
- Đề xuất 1: ngắn gọn, súc tích (2-4 dòng)
- Đề xuất 2: chi tiết hơn, kể câu chuyện hoặc nêu lợi ích sản phẩm (4-8 dòng)
- Viết tự nhiên, phù hợp mạng xã hội Việt Nam
- Chỉ trả về nội dung 2 đề xuất, phân cách bằng dòng "---" (3 dấu gạch ngang)
- Không đánh số, không tiêu đề`,
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
