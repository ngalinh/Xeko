const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { send } = require('./src/ctv/browser');

const cases = [
  { at: 'open', upload: 'input' }, { at: 'attach', upload: 'input' },
  { at: 'text', upload: 'input' }, { at: 'text', upload: 'chooser' },
  { at: 'paste', upload: 'clipboard' }, { at: 'text', upload: 'input', fullPage: true },
  { at: 'text', upload: 'input', replace: true }, { at: 'open', upload: 'input', duplicate: true },
  { at: 'paste', upload: 'clipboard', ignoredPaste: true },
];
for (const options of cases) test('recipient stays pinned with another popup: ' + JSON.stringify(options), async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CTV_TEST_BROWSER_CHANNEL ? { channel: process.env.CTV_TEST_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage();
    // Exercise clipboard conversion/targeted paste without touching the OS clipboard.
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { write: async items => { window.testClipboard = items; } } }));
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html', body: `
      <main role="main"><h1>Khách</h1><button id="open">Message</button></main>
      <script>
      const options = ${JSON.stringify(options)}; window.events = []; let popped = false;
      function popup() {
        if (popped) return; popped = true;
        const other = document.createElement('section'); other.id = 'other'; other.setAttribute('role', 'dialog');
        other.innerHTML = '<a href="https://www.facebook.com/999">Người khác</a><div role="log"><a href="https://www.facebook.com/customer">Link trong tin nhận</a></div><input type="file" accept="image/*"><div contenteditable="true" role="textbox" aria-label="Message"></div>';
        document.body.prepend(other); const box = other.querySelector('[contenteditable]'); box.focus();
        box.oninput = () => window.events.push('WRONG text');
        box.onkeydown = e => { if(e.key === 'Enter') window.events.push('WRONG Enter'); };
        other.querySelector('input').onchange = () => window.events.push('WRONG file');
      }
      document.querySelector('#open').onclick = () => {
        const chat = options.fullPage ? document.querySelector('main') : document.createElement('section');
        chat.id = 'target'; chat.setAttribute('role', options.fullPage ? 'main' : 'dialog');
        chat.innerHTML = '<h2><a href="https://www.facebook.com/customer">Khách</a></h2><div id="history" role="log"></div><div id="photos"></div><div contenteditable="true" data-lexical-editor="true" role="textbox" aria-placeholder="Aa" aria-label="Nhắn tin cho Khách"></div>';
        if (!options.fullPage) document.body.append(chat);
        const box = chat.querySelector('[contenteditable]'); let photos = [];
        function addPhoto(blob) {
          const img = new Image(); img.src = URL.createObjectURL(blob); img.style = 'width:120px;height:120px';
          photos.push(img); chat.querySelector('#photos').append(img);
        }
        function addInput() {
          const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true; chat.append(input);
          input.onchange = e => { window.events.push('target attach'); [...e.target.files].forEach(addPhoto); if(options.at === 'attach') popup(); };
          return input;
        }
        if(options.upload === 'input') addInput();
        if(options.upload === 'chooser') {
          const button = document.createElement('button'); button.textContent = 'Attach a photo or video';
          button.onclick = () => addInput().click(); chat.append(button);
        }
        box.oninput = () => { if(box.innerText) { window.events.push('target text'); if(options.at === 'text') popup(); if(options.replace)chat.querySelector('h2 a').href='https://www.facebook.com/999'; } };
        box.onkeydown = async e => {
          if(e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); window.events.push('target paste');
            if(options.ignoredPaste) return;
            addPhoto(await window.testClipboard[0].getType('image/png')); if(options.at === 'paste') popup(); return;
          }
          if(e.key !== 'Enter') return; e.preventDefault(); window.events.push('target Enter');
          const row = document.createElement('div'); row.setAttribute('role','row'); photos.forEach(img => row.append(img)); photos = [];
          const text = document.createElement('span'); text.setAttribute('dir','auto'); text.textContent = box.innerText; row.append(text); box.innerText = '';
          const receipt = document.createElement('span'); receipt.setAttribute('aria-label','Sent'); row.append(receipt); chat.querySelector('#history').append(row);
        };
        if(options.at === 'open') popup();
        if(options.duplicate){const duplicate=chat.cloneNode(true);duplicate.id='duplicate';document.body.append(duplicate);}
      };
      </script>` }));
    const wait = page.waitForTimeout.bind(page); page.waitForTimeout = () => wait(30);
    // Generate valid pixels for the PNG clipboard conversion.
    await page.goto('https://www.facebook.com/customer');
    const dataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 120; c.getContext('2d').fillRect(0,0,120,120); return c.toDataURL(); });
    let reserved = 0;
    const run = () => send(page, { url: 'https://www.facebook.com/customer', recipientId: '123' }, 'Hello', () => { reserved++; }, () => false, [{ name: 'photo.png', dataUrl }]);
    if(options.replace || options.duplicate || options.ignoredPaste){
      await assert.rejects(run(),options.replace ? /tiêu đề hội thoại/ : options.duplicate ? /nhiều khung chat/ : /chưa hiển thị ảnh vừa dán/);
      assert.equal(reserved,0);assert.ok(!(await page.evaluate(()=>window.events)).some(event=>event.includes('Enter') || event.startsWith('WRONG')));
      return;
    }
    const result = await run();
    assert.equal(result.state, 'sent'); assert.equal(reserved, 1);
    const events = await page.evaluate(() => window.events);
    assert.deepEqual(events, [options.upload === 'clipboard' ? 'target paste' : 'target attach', 'target text', 'target Enter']);
    assert.equal(await page.locator('#other [contenteditable]').innerText(), '');
    assert.equal(await page.locator('#target [role="row"] img').count(), 1);
  } finally { await browser.close(); }
});

