const { profileUrl, recipientId } = require('./rules');

function identities(record) {
  const keys = new Set();
  for (const value of [record.url, record.actualUrl, record.assessment?.url, record.assessment?.actualUrl]) {
    try { const url = profileUrl(value); keys.add('url:' + url); const id = recipientId(url); if (id) keys.add('uid:' + id); } catch (_) {}
  }
  for (const id of [record.uid, record.recipientId, record.assessment?.recipientId]) {
    if (/^\d+$/.test(String(id || ''))) keys.add('uid:' + id);
  }
  return [...keys];
}

// Same global scope as the existing UID reservations: changing sending accounts
// must not bypass contact history. Link aliases are joined only by known identity.
function contactHistory(data, { retryCampaignId } = {}) {
  const records = Object.values(data.customers || {});
  const parent = new Map();
  const root = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, root(parent.get(key))); return parent.get(key); };
  const entries = records.map(record => ({ keys: identities(record), blocked: record.sent || record.state === 'sent' || record.messageState === 'sent'
    || (!retryCampaignId || record.campaignId !== retryCampaignId) && (['sending','unconfirmed'].includes(record.state) || record.messageState === 'unconfirmed') }));
  for (const [uid, reservation] of Object.entries(data.reservations || {})) entries.push({ keys: identities({ ...reservation, uid }), blocked: !retryCampaignId || reservation.campaignId !== retryCampaignId });
  for (const {keys} of entries) for (const key of keys) parent.set(root(key), root(keys[0]));
  const blocked = new Set(entries.filter(e => e.blocked).flatMap(e => e.keys.map(root)));
  return {
    key(record) {
      const keys = identities(record), uid = keys.find(key => key.startsWith('uid:'));
      const known = uid && parent.has(uid) ? uid : keys.find(key => parent.has(key));
      return keys.length ? root(known || uid || keys[0]) : null;
    },
    has(record) { return identities(record).some(key => blocked.has(root(key))); },
  };
}
module.exports = { contactHistory };
