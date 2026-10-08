const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {send}=require('./src/ctv/browser');
const image={name:'photo.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='};
for(const receipt of [true,false])test('Messenger DOM attach, fill caption and send once, receipt='+receipt,async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CTV_TEST_BROWSER_CHANNEL ? {channel:process.env.CTV_TEST_BROWSER_CHANNEL} : {})});
 try{
  const page=await browser.newPage();
  await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html',body:`<main role="main"><h1>Khách</h1><button id="open">Message</button></main><script>
   window.actions=[];
   document.querySelector('#open').onclick=()=>{
    const dialog=document.createElement('section');dialog.setAttribute('role','dialog');
    dialog.innerHTML='<a href="https://www.facebook.com/customer">Khách</a><div id="history" role="log"></div><div id="photos"></div><input type="file" accept="image/*" multiple><div contenteditable="true" role="textbox" aria-label="Message"></div>';
    document.body.append(dialog);const box=dialog.querySelector('[contenteditable]');let photos=[];
    dialog.querySelector('input').onchange=e=>{window.actions.push('attach');photos=[...e.target.files].map(file=>{const img=new Image();img.src=URL.createObjectURL(file);img.style='width:120px;height:120px';dialog.querySelector('#photos').append(img);return img;});};
    box.oninput=()=>{if(box.innerText)window.actions.push('text filled');};
    box.onkeydown=e=>{if(e.key!=='Enter')return;e.preventDefault();const row=document.createElement('div');row.setAttribute('role','row');
     window.actions.push('combined Enter');photos.forEach(img=>row.append(img));photos=[];
     const text=document.createElement('span');text.setAttribute('dir','auto');text.textContent=box.innerText;row.append(text);box.innerText='';
     if(${receipt}){const status=document.createElement('span');status.setAttribute('aria-label','Sent');row.append(status);}
     dialog.querySelector('#history').append(row);
    };
   };
  </script>`}));
  const wait=page.waitForTimeout.bind(page);page.waitForTimeout=()=>wait(30);
  let reserved=0;const call=()=>send(page,{url:'https://www.facebook.com/customer',recipientId:'123'},'Hello',()=>{reserved++;},()=>false,[image]);
  const result=await call();assert.equal(result.state,receipt?'sent':'unconfirmed');
  assert.deepEqual(await page.evaluate(()=>window.actions),['attach','text filled','combined Enter']);
  assert.equal(reserved,1);
 }finally{await browser.close();}
});
