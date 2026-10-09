require('dotenv').config();
const readline = require('node:readline/promises');
const { launchContext, assertSession, APP, COMPOSER } = require('./src/ctv/gemini-web');

(async () => {
  const context = await launchContext();
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await input.question('Đăng nhập Google trong cửa sổ Gemini, chọn chế độ AI muốn dùng. Khi thấy ô nhập, nhấn Enter tại đây để lưu và đóng phiên: ');
    await assertSession(page);
    if (!(await page.locator(COMPOSER).isVisible())) throw new Error('Chưa thấy ô nhập Gemini');
    console.log('Đã lưu phiên. Đặt CTV_AI_PROVIDER=gemini-web rồi khởi động lại Xeko.');
  } finally {
    input.close();
    await context.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
