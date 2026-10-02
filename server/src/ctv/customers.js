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
    campaigns.set(record.campaignId, { id: record.campaignId, name: record.campaignName });
    groups.set(key, {
      profile: record.profile, url: record.url,
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

module.exports = { captureCustomers, listCustomers };
