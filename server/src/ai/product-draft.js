const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

// Start with the CDN used by the Macy’s extraction flow. Never follow redirects
// to arbitrary destinations when downloading URLs supplied by the client.
function validateImageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'slimages.macysassets.com'
      || url.port || url.username || url.password || !url.pathname.startsWith('/is/image/MCY/products/')) {
    throw new Error('Bản thử chỉ hỗ trợ ảnh sản phẩm từ CDN Macy’s.');
  }
  return url.href;
}

async function downloadImage(url, destination, fetchFn = fetch) {
  const response = await fetchFn(validateImageUrl(url), {
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const type = (response.headers.get('content-type') || '').split(';')[0];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  if (!response.ok || !ext || !response.body) throw new Error('Không tải được ảnh sản phẩm hợp lệ.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error('Ảnh vượt quá giới hạn 12 MB.');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Ảnh sản phẩm rỗng.');
  const file = destination + '.' + ext;
  await fs.writeFile(file, Buffer.concat(chunks));
  return file;
}

async function createProductDraft(input, deps) {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 500) : '';
  if (!title) throw new Error('Cần tên sản phẩm để viết nội dung.');
  if (!Array.isArray(input.images) || !input.images.length || input.images.length > 20) {
    throw new Error('Chọn từ 1 đến 20 ảnh sản phẩm.');
  }
  // Nội dung do người dùng tự gõ (có thể nhờ nút AI gợi ý rồi chỉnh sửa) —
  // dùng thẳng làm bài đăng cuối cùng, không gọi AI viết lại ở bước này.
  const body = typeof input.description === 'string' ? input.description.trim() : '';
  if (!body) throw new Error('Nhập nội dung bài đăng trước khi tạo bản nháp.');
  const urls = [...new Set(input.images.map(validateImageUrl))];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xeko-product-'));
  try {
    const files = [];
    for (const url of urls) files.push(await downloadImage(url, path.join(dir, randomUUID()), deps.fetchFn));
    const images = await deps.persistImages(files);
    if (images.length !== files.length) throw new Error('Chưa lưu đủ ảnh, chưa tạo bản nháp.');
    // Content library is passive: no post queue, profile assignment or schedule.
    const link = typeof input.url === 'string' ? input.url.trim().slice(0, 2000) : '';
    const price = typeof input.price === 'string' ? input.price.trim().slice(0, 300) : '';
    return deps.create({ title, body, images, tags: [], platform: 'all', profiles: [], link, price });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { validateImageUrl, downloadImage, createProductDraft };
