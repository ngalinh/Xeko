const crypto = require('crypto');
const { validProfileKey, profileUrl } = require('./rules');
// Durable customer snapshots, independent of campaign deletion and AI retries.
function captureCustomers(data) {
  data.customers ||= {};
  for (const campaign of data.campaigns) for (const lead of campaign.leads) {
    const key = `${campaign.id}:${lead.id}`;
    const previous = data.customers[key] || {};
    const record = {
      owner: campaign.owner, profile: campaign.profile, url: lead.url,
      campaignId: campaign.id, campaignName: campaign.name,
      importedAt: campaign.createdAt, state: lead.state,
      assessment: lead.assessment ? JSON.parse(JSON.stringify(lead.assessment)) : previous.assessment,
      message: lead.message || previous.message,
      messageState: lead.message ? lead.state : previous.messageState,
      error: lead.error || '',
      sent: previous.sent || lead.state === 'sent',
    };
    const old = { ...previous }; delete old.updatedAt;
    record.updatedAt = JSON.stringify(old) === JSON.stringify(record)
      ? previous.updatedAt : new Date().toISOString();
    data.customers[key] = record;
  }
}

function listCustomers(data, owner) {
  const groups = new Map();
  // Group identical Facebook links per sending account, keeping account permissions intact.
  for (const record of Object.values(data.customers || {}).filter(r => r.owner === owner)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    const key = JSON.stringify([record.profile, record.url]);
    const old = groups.get(key);
    const campaigns = new Map((old?.campaigns || []).map(c => [c.id, c]));
    if (record.campaignId) campaigns.set(record.campaignId, { id: record.campaignId, name: record.campaignName });
    groups.set(key, {
      profile: record.profile, url: record.url,
      name: record.name || old?.name, uid: record.uid || old?.uid, notes: record.notes || old?.notes,
      manual: !!(record.manual || old?.manual),
      assessment: record.assessment || old?.assessment,
      sent: !!(old?.sent || record.sent), state: record.state, error: record.error,
      message: record.message || old?.message,
      messageState: record.message ? record.messageState : old?.messageState,
      importedAt: old && old.importedAt < record.importedAt ? old.importedAt : record.importedAt,
      updatedAt: record.updatedAt, campaigns: [...campaigns.values()],
    });
  }
  return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function addManualCustomer(data, input, owner) {
  if (!input || typeof input !== 'object') throw new Error('Dữ liệu không hợp lệ');
  if (!validProfileKey(input.profile)) throw new Error('Cần chọn tài khoản quản lý hợp lệ');
  const text = (value, max, label) => { if (value == null) return ''; if (typeof value !== 'string' || value.length > max) throw new Error(label+' không hợp lệ'); return value.trim(); };
  const url = profileUrl(text(input.url, 2000, 'Link Facebook'));
  const name = text(input.name, 150, 'Tên khách hàng'), uid = text(input.uid, 30, 'UID'), notes = text(input.notes, 2000, 'Ghi chú');
  if (uid && !/^\d{5,30}$/.test(uid)) throw new Error('UID phải gồm 5–30 chữ số');
  if (Object.values(data.customers || {}).some(r => r.owner === owner && r.profile === input.profile && (r.url === url || uid && (r.uid === uid || r.assessment?.recipientId === uid)))) {
    const error = new Error('Khách hàng đã có trong dữ liệu của tài khoản này (trùng link hoặc UID).'); error.status = 409; throw error;
  }
  const now = new Date().toISOString();
  const record = { owner, profile: input.profile, url, name, uid, notes, manual: true, state: 'pending', sent: false, importedAt: now, updatedAt: now };
  data.customers ||= {}; data.customers['manual:'+crypto.randomUUID()] = record;
  return record;
}
module.exports = { captureCustomers, listCustomers, addManualCustomer };
