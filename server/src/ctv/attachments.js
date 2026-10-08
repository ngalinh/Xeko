const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function normalizeImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error('Chỉ đính kèm tối đa 5 ảnh');
  let total = 0;
  return images.map(image => {
    if (!image || typeof image.name !== 'string' || typeof image.dataUrl !== 'string') throw new Error('Ảnh đính kèm không hợp lệ');
    const match = image.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Chọn ảnh JPG, PNG hoặc WebP, tối đa 2 MB mỗi ảnh');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw new Error('Dữ liệu ảnh không hợp lệ');
    const valid = match[1] === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!valid) throw new Error('Nội dung tệp không đúng định dạng ảnh');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Tổng ảnh đính kèm tối đa 4 MB');
    return { name: image.name.replace(/[\\/\x00-\x1f]/g, '_').slice(0,120) || 'image', mimeType: match[1], dataUrl: image.dataUrl };
  });
}

function imagePayloads(images) {
  return normalizeImages(images).map(image => ({ name: image.name, mimeType: image.mimeType, buffer: Buffer.from(image.dataUrl.split(',')[1], 'base64') }));
}
module.exports = { normalizeImages, imagePayloads, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
