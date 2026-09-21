const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { profileUrl, renderMessage } = require('./rules');

class CtvService {
  constructor({ file, browser, queue = fn => fn(), pause = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.file = file; this.browser = browser; this.queue = queue; this.pause = pause;
    this.running = new Set();
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { campaigns: [], reservations: {} };
    // An interrupted batch must never restart sending by itself.
    for (const c of this.data.campaigns) if (['running','queued'].includes(c.state)) {
      c.state = 'interrupted';
      for (const l of c.leads) if (['checking','sending'].includes(l.state)) { l.state = 'review'; l.error = 'Tiến trình bị gián đoạn; kiểm tra Messenger trước khi thao tác tiếp'; }
    }
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.file);
  }
  get(id, owner) {
    const c = this.data.campaigns.find(c => c.id === id && c.owner === owner);
    if (!c) throw new Error('Không tìm thấy chiến dịch');
    return c;
  }
  create(input, owner) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.profile || '')) throw new Error('Cần chọn tài khoản Facebook');
    if (!Array.isArray(input.urls) || !input.urls.length || input.urls.length > 100) throw new Error('Mỗi đợt nhận từ 1 đến 100 link');
    if (!['analyze','auto'].includes(input.mode)) throw new Error('Chế độ không hợp lệ');
    renderMessage(input.template, 'bạn');
    const urls = [...new Set(input.urls.map(profileUrl))];
    const c = { id: crypto.randomUUID(), owner, profile: input.profile, mode: input.mode, template: input.template.trim(), createdAt: new Date().toISOString(), state: 'draft', cancelled: false, leads: urls.map(url => ({ url, state: 'pending' })) };
    this.data.campaigns.push(c); this.save(); return c;
  }
  start(id, owner) {
    const c = this.get(id, owner);
    if (c.state !== 'draft') throw new Error('Chiến dịch đã chạy; không tự chạy lại để tránh gửi trùng');
    c.state = 'queued'; this.save();
    const run = this.queue(() => this.run(c)).catch(e => { c.state = 'failed'; c.error = e.message; this.save(); });
    this.running.add(run); run.finally(() => this.running.delete(run));
    return c;
  }
  stop(id, owner) {
    const c = this.get(id, owner);
    if (!['queued','running'].includes(c.state)) return c;
    c.cancelled = true; this.save(); return c;
  }
  async run(c) {
    c.state = 'running'; this.save();
    for (const lead of c.leads) {
      if (c.cancelled) break;
      lead.state = 'checking'; this.save();
      try {
        await this.browser.withPage(c.profile, async page => {
          lead.assessment = await this.browser.inspect(page, lead.url);
          const a = lead.assessment;
          lead.message = renderMessage(c.template, a.name);
          lead.state = a.eligible ? 'qualified' : 'review'; this.save();
          if (!a.eligible || c.mode !== 'auto' || c.cancelled) return;
          if (!/^\d+$/.test(a.recipientId || '')) { lead.state = 'review'; lead.error = 'Chưa xác minh được ID người nhận'; this.save(); return; }
          // Recipient-level deduplication covers multiple campaigns and sender accounts.
          if (this.data.reservations[a.recipientId]) { lead.state = 'duplicate'; this.save(); return; }
          const result = await this.browser.send(page, a, lead.message, () => {
            if (c.cancelled) throw new Error('Đã dừng');
            if (this.data.reservations[a.recipientId]) throw new Error('Người nhận đã có lần gửi trước');
            this.data.reservations[a.recipientId] = { campaignId: c.id, at: new Date().toISOString() };
            lead.state = 'sending'; this.save();
          }, () => c.cancelled);
          lead.state = result.state; lead.error = result.reason; this.save();
        });
      } catch (e) {
        lead.state = lead.state === 'sending' ? 'unconfirmed' : 'review'; lead.error = e.message; this.save();
        // Login, browser, AI and selector failures stop a batch, avoiding repeated failures.
        c.state = 'needs_attention'; c.error = e.message; this.save(); return;
      }
      if (c.mode === 'auto' && lead.state === 'unconfirmed') {
        // Pause after an unconfirmed submission. Continuing requires verifying delivery.
        c.state = 'needs_attention'; c.error = lead.error; this.save(); return;
      }
      // Bounded waits allow cancellation to take effect between profiles.
      for (let i = 0; i < 5 && !c.cancelled; i++) await this.pause(1000);
    }
    c.state = c.cancelled ? 'cancelled' : 'done'; this.save();
  }
}
module.exports = { CtvService };
