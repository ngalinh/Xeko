const path = require('path');
const { CtvService } = require('./service');

function mountCtv(app, { remote = false, getLocalUrl = () => '', apiKey = '', permissions } = {}) {
  let service;
  const getService = () => {
    if (!service) service = new CtvService({
      file: path.join(process.env.XEKO_DATA_DIR || path.resolve(__dirname, '../../..'), 'data/.ctv/campaigns.json'),
      browser: require('./browser').createBrowserAdapter(),
      queue: require('../utils/post-queue').queuePost,
    });
    return service;
  };
  app.all('/api/ctv/*', async (req, res) => {
    try {
      const owner = remote ? req.user?.email : req.headers['x-ctv-owner'];
      if (typeof owner !== 'string' || !owner) return res.status(401).json({ error: 'Chưa xác thực người dùng' });
      const allowed = remote ? permissions.getAllowedProfileKeys(owner) : null;
      const allowedProfile = profile => allowed === null || allowed.includes(profile);
      const local = remote && getLocalUrl();
      if (remote && process.env.PLAYWRIGHT_LOCAL_URL && !local) return res.status(503).json({ error: 'Máy chạy Playwright chưa kết nối' });
      if (local) {
        // The cloud always checks current permissions before forwarding mutations.
        let profile = req.body?.profile;
        const match = req.path.match(/^\/api\/ctv\/campaigns\/([a-f0-9-]+)(?:\/(start|stop))?$/);
        if (match) {
          const check = await fetch(`${local}/api/ctv/campaigns/${match[1]}`, { headers: { 'x-api-key': apiKey, 'x-ctv-owner': owner }, signal: AbortSignal.timeout(10000) });
          if (!check.ok) return res.status(check.status).json({ error: 'Không tìm thấy chiến dịch hoặc máy local chưa sẵn sàng' });
          profile = (await check.json()).profile;
        }
        if (profile && !allowedProfile(profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
        const upstream = await fetch(`${local}${req.path}`, {
          method: req.method, signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-ctv-owner': owner },
          ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }),
        });
        let data = await upstream.json();
        if (Array.isArray(data)) data = data.filter(c => allowedProfile(c.profile));
        return res.status(upstream.status).json(data);
      }
      const s = getService();
      if (req.path === '/api/ctv/campaigns') {
        if (req.method === 'GET') return res.json(s.data.campaigns.filter(c => c.owner === owner && allowedProfile(c.profile)));
        if (req.method === 'POST') {
          if (!allowedProfile(req.body.profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
          return res.status(201).json(s.create(req.body, owner));
        }
      }
      const match = req.path.match(/^\/api\/ctv\/campaigns\/([a-f0-9-]+)(?:\/(start|stop))?$/);
      if (match) {
        const c = s.get(match[1], owner);
        if (!allowedProfile(c.profile)) return res.status(403).json({ error: 'Không có quyền dùng tài khoản này' });
        if (!match[2] && req.method === 'GET') return res.json(c);
        if (req.method === 'POST' && match[2] === 'start') return res.status(202).json(s.start(c.id, owner));
        if (req.method === 'POST' && match[2] === 'stop') return res.json(s.stop(c.id, owner));
      }
      return res.status(404).json({ error: 'Không tìm thấy thao tác' });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  });
}
module.exports = { mountCtv };
