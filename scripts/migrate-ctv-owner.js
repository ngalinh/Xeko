#!/usr/bin/env node
// Một lần dùng: đổi owner (email đăng nhập admin) của dữ liệu "Gửi tin nhắn
// hàng loạt" sau khi đổi email đăng nhập Basso. Mặc định chỉ xem trước (dry-run);
// cần --apply để thực sự ghi. Tự backup file gốc trước khi ghi.
//
// Dùng: node scripts/migrate-ctv-owner.js --file <path/to/campaigns.json> \
//   --from old@email.com --to new@email.com [--apply]
const fs = require('fs');

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else throw new Error(`Tham số không hợp lệ: ${a}`);
  }
  for (const key of ['file', 'from', 'to']) if (!out[key]) throw new Error(`Thiếu --${key}`);
  if (out.from === out.to) throw new Error('--from và --to phải khác nhau');
  return out;
}

function migrate(data, from, to) {
  const counts = { campaigns: 0, customers: 0, hiddenCustomers: 0, brandAliases: 0 };
  for (const c of data.campaigns || []) if (c.owner === from) { c.owner = to; counts.campaigns++; }
  for (const record of Object.values(data.customers || {})) if (record.owner === from) { record.owner = to; counts.customers++; }
  if (data.hiddenCustomers?.[from]) {
    const merged = new Set([...(data.hiddenCustomers[to] || []), ...data.hiddenCustomers[from]]);
    data.hiddenCustomers[to] = [...merged];
    delete data.hiddenCustomers[from];
    counts.hiddenCustomers = merged.size;
  }
  for (const r of data.brandAliases || []) if (r.owner === from) { r.owner = to; counts.brandAliases++; }
  return counts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const counts = migrate(data, args.from, args.to);
  console.log(`Sẽ đổi owner từ "${args.from}" sang "${args.to}":`);
  console.log(`  campaigns: ${counts.campaigns}`);
  console.log(`  customers: ${counts.customers}`);
  console.log(`  hiddenCustomers (gộp): ${counts.hiddenCustomers}`);
  console.log(`  brandAliases: ${counts.brandAliases}`);
  if (!args.apply) {
    console.log('\nChế độ xem trước (dry-run), chưa ghi file. Thêm --apply để thực sự đổi.');
    return;
  }
  const backup = `${args.file}.bak-${Date.now()}`;
  fs.copyFileSync(args.file, backup);
  fs.writeFileSync(args.file, JSON.stringify(data, null, 2));
  console.log(`\nĐã ghi file. Backup gốc: ${backup}`);
}

main();
