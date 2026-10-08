const path = require('path');
const { CtvService } = require('./service');
const ACTIONS = ['approve-import', 'approve-analysis', 'review-analysis', 'prepare-messages', 'send', 'retry-send', 'stop', 'retry-analysis', 'resolve-uids', 'delete', 'skip-lead'];
const campaignPath = /^\/api\/ctv\/campaigns\/([a-f0-9-]+)(?:\/([a-z-]+))?$/;

function mountCtv(app, { remote = false, getLocalUrl = () => '', apiKey = '', permissions, service: providedService, fetchFn = fetch } = {}) {
  let service = providedService;
  const getService = () => {
    if (!service) service = new CtvService({
      file: path.join(process.env.XEKO_DATA_DIR || path.resolve(__dirname, '../../..'), 'data/.ctv/campaigns.json'),
      browser: require('./browser').createBrowserAdapter(), queue: require('../utils/post-queue').queuePost,
    });
    return service;
  };
  app.all('/api/ctv/*', async (req, res) => {
    try {
      const owner = remote ? req.user?.email : req.headers['x-ctv-owner'];
      if (typeof owner !== 'string' || !owner) return res.status(401).json({ error: 'Chưa xác thực người dùng' });
      const allowed = remote ? permissions.getAllowedProfileKeys(owner) : null;
      const allowedProfile = profile => allowed === null || allowed.includes(profile);
      const customers = req.path === '/api/ctv/customers';
      if (customers && !['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'Thao tác không được hỗ trợ' });
      if (customers && req.method === 'POST' && (typeof req.body?.profile !== 'string' || !req.body.profile)) return res.status(400).json({ error: 'Cần chọn tài khoản quản lý' });
      if (customers && req.method === 'POST' && !allowedProfile(req.body.profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
      const collection = req.path === '/api/ctv/campaigns';
      const match = req.path.match(campaignPath);
      if ((!customers && !collection && (!match || (match[2] && !ACTIONS.includes(match[2])))) || !['GET','POST'].includes(req.method) || (match?.[2] && req.method !== 'POST')) return res.status(404).json({ error: 'Không tìm thấy thao tác' });
      const local = remote && getLocalUrl();
      if (remote && process.env.PLAYWRIGHT_LOCAL_URL && !local) return res.status(503).json({ error: 'Máy chạy Playwright chưa kết nối' });
      if (local) {
        let profile = req.body?.profile;
        if (match) {
          const check = await fetchFn(`${local}/api/ctv/campaigns/${match[1]}`, { headers: { 'x-api-key': apiKey, 'x-ctv-owner': owner }, signal: AbortSignal.timeout(10000) });
          if (!check.ok) return res.status(check.status).json({ error: 'Không tìm thấy chiến dịch hoặc máy local chưa sẵn sàng' });
          profile = (await check.json()).profile;
        }
        if (profile && !allowedProfile(profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
        const upstream = await fetchFn(`${local}${req.path}`, {
          method: req.method, signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-ctv-owner': owner },
          ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }),
        });
        let data = await upstream.json();
        if (Array.isArray(data)) data = data.filter(c => allowedProfile(c.profile));
        return res.status(upstream.status).json(data);
      }
      const s = getService();
      if (customers) {
        if (req.method === 'POST') return res.status(201).json(s.addCustomer(req.body, owner));
        return res.json(s.listCustomers(owner).filter(c => allowedProfile(c.profile)));
      }
      if (collection) {
        if (req.method === 'GET') return res.json(s.data.campaigns.filter(c => c.owner === owner && allowedProfile(c.profile)).map(c => s.view(c, false)));
        if (!allowedProfile(req.body.profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
        return res.status(201).json(s.view(s.create(req.body, owner)));
      }
      const c = s.get(match[1], owner), action = match[2];
      if (!allowedProfile(c.profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
      if (!action && req.method === 'GET') return res.json(s.view(c));
      if (action) {
        const body = req.body || {};
        const result = {
          'approve-import': () => s.approveImport(c.id, owner),
          'approve-analysis': () => s.approveAnalysis(c.id, owner, body.leadIds),
          'review-analysis': () => s.reviewAnalysis(c.id, owner),
          'prepare-messages': () => s.prepareMessages(c.id, owner, body.template, body.images),
          'send': () => s.sendApproved(c.id, owner, body.previewToken),
          'retry-send': () => s.retrySend(c.id, owner, body),
          'stop': () => s.stop(c.id, owner),
          'retry-analysis': () => s.retryAnalysis(c.id, owner),
          'resolve-uids': () => s.resolveUids(c.id, owner, body.leadId),
          'skip-lead': () => s.skipLead(c.id, owner, body.leadId),
          'delete': () => s.deleteCampaign(c.id, owner),
        }[action]();
        return res.status(['approve-import','send','retry-send','retry-analysis','resolve-uids'].includes(action) ? 202 : 200).json(s.view(result));
      }
      return res.status(404).json({ error: 'Không tìm thấy thao tác' });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  });
}
module.exports = { mountCtv };


