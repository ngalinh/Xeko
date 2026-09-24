const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { profileUrl, renderMessage } = require('./rules');
const ACTIVE = ['analysis_queued', 'analyzing', 'send_queued', 'sending'];
const fail = message => { const e = new Error(message); e.status = 409; throw e; };

class CtvService {
  constructor({ file, browser, queue = fn => fn(), pause = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { file, browser, queue, pause }); this.running = new Set();
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { campaigns: [], reservations: {} };
    for (const c of this.data.campaigns) if (ACTIVE.includes(c.state) || ['running', 'queued'].includes(c.state)) {
      c.state = 'interrupted'; c.error = 'Tiến trình bị gián đoạn. Không tự tiếp tục hoặc gửi lại.';
      for (const l of c.leads) if (['checking', 'sending'].includes(l.state)) { l.state = l.state === 'sending' ? 'unconfirmed' : 'review'; l.error = c.error; }
    }
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  get(id, owner) {
    const c = this.data.campaigns.find(c => c.id === id && c.owner === owner);
    if (!c) { const e = new Error('Không tìm thấy chiến dịch'); e.status = 404; throw e; }
    return c;
  }
  staged(id, owner) {
    const c = this.get(id, owner);
    if (c.workflowVersion !== 2) fail('Chiến dịch cũ chỉ được xem. Hãy tạo chiến dịch mới theo quy trình 3 bước.');
    return c;
  }
  reasonBlocked(lead) {
    if (!lead.assessment?.eligible) return 'AI chưa đánh giá đạt';
    const id = lead.assessment.recipientId;
    if (!/^\d+$/.test(id || '')) return 'Chưa xác minh được ID người nhận';
    if (this.data.reservations[id]) return 'Đã có lần gửi trước hoặc chưa rõ trạng thái gửi';
    return '';
  }
  view(c) { return { ...c, leads: c.leads.map(l => ({ ...l, blockedReason: this.reasonBlocked(l) })) }; }
  create(input, owner) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.profile || '')) throw new Error('Cần chọn tài khoản Facebook');
    if (!Array.isArray(input.urls) || !input.urls.length || input.urls.length > 100) throw new Error('Mỗi đợt nhận từ 1 đến 100 link');
    const urls = new Set(), rejected = []; let duplicateCount = 0;
    for (const value of input.urls) {
      try {
        if (typeof value !== 'string' || value.length > 2000) throw new Error('Link không hợp lệ');
        const url = profileUrl(value);
        if (urls.has(url)) duplicateCount++; else urls.add(url);
      } catch (e) { rejected.push({ value: String(value).slice(0,2000), reason: e.message }); }
    }
    const c = { id: crypto.randomUUID(), workflowVersion: 2, owner, profile: input.profile,
      name: String(input.name || 'Chiến dịch gửi tin nhắn hàng loạt').trim().slice(0,100), createdAt: new Date().toISOString(),
      state: 'import_review', cancelled: false, importedCount: input.urls.length, duplicateCount, rejected, approvals: {},
      leads: [...urls].map(url => ({ id: crypto.randomUUID(), url, state: 'pending' })) };
    this.data.campaigns.push(c); this.save(); return c;
  }
  enqueue(c, task) {
    const run = Promise.resolve().then(() => this.queue(task)).catch(e => { c.state = 'needs_attention'; c.error = e.message; this.save(); });
    this.running.add(run); run.then(() => this.running.delete(run), () => this.running.delete(run));
  }
  approveImport(id, owner) {
    const c = this.staged(id, owner);
    if (c.approvals.import) return c;
    if (c.state !== 'import_review' || !c.leads.length) fail('Cần có danh sách hợp lệ để duyệt bước 1');
    c.approvals.import = { by: owner, at: new Date().toISOString() };
    c.state = 'analysis_queued'; this.save(); this.enqueue(c, () => this.analyze(c)); return c;
  }
  async analyze(c) {
    c.state = 'analyzing'; this.save();
    for (const lead of c.leads) {
      if (c.cancelled) break;
      lead.state = 'checking'; this.save();
      try {
        lead.assessment = await this.browser.withPage(c.profile, page => this.browser.inspect(page, lead.url));
        lead.state = lead.assessment.eligible ? 'qualified' : 'review'; this.save();
      } catch (e) {
        lead.state = 'review'; lead.error = e.message; c.state = 'analysis_review'; c.error = e.message; this.save(); return;
      }
      if (lead !== c.leads[c.leads.length - 1]) await this.wait(c, 2);
    }
    // Always stop at review. Analysis cannot call the message adapter.
    c.state = 'analysis_review'; this.save();
  }
  approveAnalysis(id, owner, leadIds) {
    const c = this.staged(id, owner);
    if (c.state !== 'analysis_review') fail('Chỉ duyệt khách sau khi AI đã trả kết quả');
    if (!Array.isArray(leadIds) || !leadIds.length || leadIds.length > 100) fail('Hãy chọn ít nhất một khách đạt điều kiện');
    const unique = [...new Set(leadIds)], recipientIds = new Set();
    for (const id of unique) {
      const lead = c.leads.find(l => l.id === id);
      if (!lead || this.reasonBlocked(lead)) fail('Danh sách có khách chưa đủ điều kiện hoặc đã được liên hệ');
      if (recipientIds.has(lead.assessment.recipientId)) fail('Hai link cùng một người nhận. Chỉ chọn một link cho mỗi khách.');
      recipientIds.add(lead.assessment.recipientId);
    }
    c.approvals.analysis = { by: owner, at: new Date().toISOString(), leadIds: unique };
    c.state = 'message_review'; c.cancelled = false; c.error = null; this.save(); return c;
  }
  reviewAnalysis(id, owner) {
    const c = this.staged(id, owner);
    if (c.state !== 'message_review') fail('Không thể đổi người nhận sau khi đã duyệt gửi');
    c.state = 'analysis_review'; delete c.approvals.analysis; delete c.messagePreview;
    for (const l of c.leads) delete l.message;
    this.save(); return c;
  }
  prepareMessages(id, owner, template) {
    const c = this.staged(id, owner);
    if (c.state !== 'message_review' || !c.approvals.analysis) fail('Cần duyệt kết quả AI trước khi soạn tin');
    renderMessage(template, 'bạn');
    const messages = c.approvals.analysis.leadIds.map(id => {
      const l = c.leads.find(l => l.id === id);
      if (this.reasonBlocked(l)) fail('Một khách đã được liên hệ trong chiến dịch khác. Hãy chọn lại.');
      return { leadId: id, recipientId: l.assessment.recipientId, name: l.assessment.name || 'bạn', url: l.url, message: renderMessage(template, l.assessment.name) };
    });
    c.template = template.trim(); c.messagePreview = { token: crypto.randomUUID(), createdAt: new Date().toISOString(), messages };
    this.save(); return c;
  }
  sendApproved(id, owner, token) {
    const c = this.staged(id, owner);
    if (typeof token !== 'string' || !token) fail('Cần duyệt bản xem trước tin nhắn');
    if (c.approvals.send?.token === token) return c;
    if (c.state !== 'message_review' || !c.approvals.import || !c.approvals.analysis || c.messagePreview?.token !== token) fail('Bản xem trước đã thay đổi hoặc chưa được tạo. Hãy xem lại trước khi gửi.');
    for (const m of c.messagePreview.messages) if (this.reasonBlocked(c.leads.find(l => l.id === m.leadId))) fail('Danh sách gửi đã thay đổi. Hãy quay lại duyệt kết quả AI.');
    c.approvals.send = { by: owner, at: new Date().toISOString(), token };
    c.cancelled = false; c.state = 'send_queued'; this.save(); this.enqueue(c, () => this.send(c)); return c;
  }
  stop(id, owner) {
    const c = this.staged(id, owner);
    if (ACTIVE.includes(c.state)) { c.cancelled = true; this.save(); } return c;
  }
  async wait(c, seconds) { for (let i = 0; i < seconds && !c.cancelled; i++) await this.pause(1000); }
  async send(c) {
    c.state = 'sending'; this.save();
    for (const m of c.messagePreview.messages) {
      if (c.cancelled) break;
      const lead = c.leads.find(l => l.id === m.leadId);
      if (this.data.reservations[m.recipientId]) { lead.state = 'duplicate'; this.save(); continue; }
      lead.message = m.message;
      try {
        const result = await this.browser.withPage(c.profile, page => this.browser.send(page, lead.assessment, m.message, () => {
          if (c.cancelled) throw new Error('Đã dừng trước khi gửi');
          if (this.data.reservations[m.recipientId]) throw new Error('Người nhận đã có lần gửi trước');
          this.data.reservations[m.recipientId] = { campaignId: c.id, at: new Date().toISOString() };
          lead.state = 'sending'; this.save();
        }, () => c.cancelled));
        lead.state = result.state; lead.error = result.reason; this.save();
        if (result.state !== 'sent') { c.state = 'needs_attention'; c.error = result.reason; this.save(); return; }
      } catch (e) {
        lead.state = lead.state === 'sending' ? 'unconfirmed' : 'review'; lead.error = e.message;
        c.state = c.cancelled && lead.state !== 'unconfirmed' ? 'cancelled' : 'needs_attention'; c.error = e.message; this.save(); return;
      }
      if (m !== c.messagePreview.messages[c.messagePreview.messages.length - 1]) await this.wait(c, 5);
    }
    c.state = c.cancelled ? 'cancelled' : 'completed'; this.save();
  }
}
module.exports = { CtvService, ACTIVE };
