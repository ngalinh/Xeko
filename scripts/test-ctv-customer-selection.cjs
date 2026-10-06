const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
class Element {
  constructor() { this.children = []; this.value = ''; this.hidden = true; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute() {}
  get options() { return this.children; }
}
function library(rows) {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  $('customerStatus').value = $('customerAccount').value = 'all';
  let transferred;
  const context = { document: { getElementById: $, createElement: () => new Element(), dispatchEvent: e => { if(e.type === 'ctv:use-customers') { transferred = e.detail; e.detail.accepted = true; } } },
    window: { location: { pathname: '/b/test/ctv.html' } }, AbortController, setTimeout, clearTimeout,
    Option: class extends Element { constructor(text, value) { super(); this.value = value; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    fetch: async () => ({ ok: true, json: async () => rows }) };
  vm.runInNewContext(read('ctv-customers.js'), context);
  const boxes = () => $('customerRecords').children.filter(c => c.children[0]?.children).map(c => c.children[0].children[0].children[1].children[0]);
  return { $, boxes, transferred: () => transferred };
}
const customer = (n, profile = 'one') => ({ profile, url: `https://facebook.com/customer${n}`, name: `Customer ${n}`, campaigns: [], manual: true });
test('selection survives pages and filters; only checked customers transfer', async () => {
  const ui = library(Array.from({length: 30}, (_, i) => customer(i)));
  await ui.$('refreshCustomers').onclick();
  const first = ui.boxes()[0]; first.checked = true; first.onchange();
  ui.$('customerNext').onclick();
  ui.$('selectCustomerPage').checked = true; ui.$('selectCustomerPage').onchange();
  ui.$('customerSearch').value = 'Customer 1'; ui.$('customerSearch').oninput();
  assert.match(ui.$('customerSelectionCount').textContent, /^6 khách/);
  ui.$('useCustomers').onclick();
  assert.equal(ui.transferred().customers.length, 6);
  assert.equal(ui.transferred().customers[0].url, customer(0).url);
  assert.match(ui.$('customerSelectionCount').textContent, /^0 khách/);
});
test('mixed accounts and over 100 recipients cannot transfer', async () => {
  for (const rows of [[customer(1), customer(2, 'two')], Array.from({length:101}, (_,i)=>customer(i))]) {
    const ui = library(rows); await ui.$('refreshCustomers').onclick();
    do {
      ui.$('selectCustomerPage').checked = true; ui.$('selectCustomerPage').onchange();
      if (ui.$('customerNext').disabled) break;
      ui.$('customerNext').onclick();
    } while (true);
    assert.equal(ui.$('useCustomers').disabled, true);
    ui.$('useCustomers').onclick(); assert.equal(ui.transferred(), undefined);
  }
});
test('refresh prunes removed records and manual filter only shows manual customers', async () => {
  const rows = [customer(1), {...customer(2), manual:false}];
  const ui = library(rows); await ui.$('refreshCustomers').onclick();
  ui.$('selectCustomerPage').checked = true; ui.$('selectCustomerPage').onchange();
  rows.pop(); await ui.$('refreshCustomers').onclick();
  assert.match(ui.$('customerSelectionCount').textContent, /^1 khách/);
  ui.$('customerStatus').value = 'manual'; ui.$('customerStatus').onchange();
  assert.equal(ui.boxes().length, 1);
});
test('campaign handoff validates account and preserves drafts on cancellation', () => {
  const js = read('ctv.js');
  const source = js.slice(js.indexOf("  document.addEventListener('ctv:use-customers'"), js.indexOf('  (async()=>{'));
  const nodes = {urls:{value:'draft'},campaignName:{value:'Draft',focus(){}},profile:{}};
  let handler, resets=0;
  nodes.newCampaign = {onclick:()=>resets++}; nodes.urls.oninput = ()=>{};
  const context = {document:{addEventListener:(_,fn)=>handler=fn}, $:id=>nodes[id], busy:false, selected:null, accounts:[{key:'one'}], window:{confirm:()=>false}, notice(){} };
  vm.runInNewContext(source, context);
  let detail={customers:[customer(1)]}; handler({detail}); assert.equal(resets,0); assert.ok(detail.error);
  context.window.confirm=()=>true;
  detail={customers:[customer(1,'missing')]}; handler({detail}); assert.equal(resets,0);
  detail={customers:[customer(1)]}; handler({detail}); assert.equal(resets,1); assert.equal(detail.accepted,true);
  assert.equal(nodes.profile.value,'one'); assert.equal(nodes.urls.value,customer(1).url);
  context.busy=true; handler({detail:{customers:[customer(2)]}}); assert.equal(resets,1);
});
