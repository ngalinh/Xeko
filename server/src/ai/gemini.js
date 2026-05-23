const fs = require('fs');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

async function suggestContent(imagePaths, contentGuide) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình');

  const imageParts = imagePaths.map(p => {
    const data = fs.readFileSync(p);
    const ext = p.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    return {
      inline_data: {
        mime_type: mimeMap[ext] || 'image/jpeg',
        data: data.toString('base64'),
      },
    };
  });

  const guideSection = contentGuide
    ? `\n\nHướng dẫn giọng văn:\n${contentGuide}\n`
    : '';

  const prompt = `Bạn là chuyên gia viết content mạng xã hội.${guideSection}
Hãy phân tích hình ảnh sản phẩm và viết 2 đề xuất content để đăng Facebook/Zalo.

Yêu cầu:
- Mỗi đề xuất là 1 bài viết hoàn chỉnh, bao gồm hashtag liên quan
- Đề xuất 1: ngắn gọn, súc tích (2-4 dòng)
- Đề xuất 2: chi tiết hơn, kể câu chuyện hoặc nêu lợi ích sản phẩm (4-8 dòng)
- Viết tự nhiên, phù hợp mạng xã hội Việt Nam
- Chỉ trả về nội dung 2 đề xuất, phân cách bằng dòng "---" (3 dấu gạch ngang)
- Không đánh số, không tiêu đề`;

  const body = {
    contents: [{ parts: [...imageParts, { text: prompt }] }],
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
