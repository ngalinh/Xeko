/* Shared helpers, icons, mock data — used by all 3 variants */

// ────────────────────── Icons (stroke 1.5) ──────────────────────
const Icon = ({ d, size = 16, stroke = "currentColor", fill = "none", sw = 1.6 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);

const IconDash = (p) => <Icon {...p} d={<><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>} />;
const IconPost = (p) => <Icon {...p} d={<><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></>} />;
const IconUsers = (p) => <Icon {...p} d={<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>} />;
const IconSpy = (p) => <Icon {...p} d={<><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>} />;
const IconSettings = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></>} />;
const IconBell = (p) => <Icon {...p} d={<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>} />;
const IconSearch = (p) => <Icon {...p} d={<><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>} />;
const IconPlus = (p) => <Icon {...p} d={<><path d="M12 5v14"/><path d="M5 12h14"/></>} />;
const IconFilter = (p) => <Icon {...p} d={<><path d="M3 4h18l-7 9v6l-4 2v-8Z"/></>} />;
const IconChevron = (p) => <Icon {...p} d={<><path d="m6 9 6 6 6-6"/></>} />;
const IconCheck = (p) => <Icon {...p} d={<><path d="M20 6 9 17l-5-5"/></>} />;
const IconX = (p) => <Icon {...p} d={<><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>} />;
const IconRetry = (p) => <Icon {...p} d={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>} />;
const IconTrash = (p) => <Icon {...p} d={<><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>} />;
const IconImage = (p) => <Icon {...p} d={<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></>} />;
const IconCal = (p) => <Icon {...p} d={<><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></>} />;
const IconFB = (p) => <Icon {...p} fill="currentColor" stroke="none" d={<path d="M13 22v-8h3l.5-4H13V7.5c0-1.1.3-1.8 1.9-1.8H17V2.2c-.3 0-1.6-.2-3-.2-3 0-5 1.8-5 5.2V10H6v4h3v8h4Z"/>} />;
const IconZalo = (p) => <Icon {...p} d={<><path d="M3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z"/><path d="M8 10v4h3"/><path d="M13 10l3 4m0-4-3 4"/></>} />;
const IconTrend = (p) => <Icon {...p} d={<><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></>} />;
const IconDot = (p) => <Icon {...p} fill="currentColor" stroke="none" d={<circle cx="12" cy="12" r="3"/>} />;
const IconMore = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>} />;
const IconExport = (p) => <Icon {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5-5 5 5"/><path d="M12 5v12"/></>} />;
const IconPlay = (p) => <Icon {...p} fill="currentColor" stroke="none" d={<path d="M8 5v14l11-7Z"/>} />;

// ────────────────────── Mock data ──────────────────────
const STATS = [
  { label: "Hôm nay", sub: "bài đăng", value: 12, delta: "+3", trend: "up" },
  { label: "Thành công", sub: "hôm nay", value: 11, delta: "92%", trend: "up" },
  { label: "Thất bại", sub: "hôm nay", value: 1, delta: "-2", trend: "down" },
  { label: "Tổng cộng", sub: "tất cả", value: 64, delta: "+12", trend: "up" },
];

const ACCOUNTS = [
  { plat: "Facebook", name: "clone.linhthao", total: 20, ok: 15, fail: 5, rate: 75 },
  { plat: "Facebook", name: "khanhlinh",      total: 19, ok: 15, fail: 4, rate: 79 },
  { plat: "Facebook", name: "clone.linhduong",total: 17, ok: 16, fail: 1, rate: 94 },
  { plat: "Facebook", name: "trangthuynguyen",total:  3, ok:  0, fail: 3, rate:  0 },
  { plat: "Zalo",     name: "Linh Thảo Us Authentic", total: 3, ok: 3, fail: 0, rate: 100 },
  { plat: "Zalo",     name: "clone.linhthao",total:  2, ok:  2, fail: 0, rate: 100 },
];

const GROUPS = [
  { plat: "Facebook", name: "Asale",    total: 2, ok: 0, fail: 2, rate: 0 },
  { plat: "Facebook", name: "Tổng Kho", total: 2, ok: 1, fail: 1, rate: 50 },
  { plat: "Zalo",     name: "Test đăng bài", total: 5, ok: 5, fail: 0, rate: 100 },
];

// Per-day per-account posts (stacked)
const CHART = [
  { d: "04-20", vals: { "clone.linhduong": 3, "clone.linhthao": 2, "khanhlinh": 3, "trangthuynguyen": 0, "Linh Thảo": 0 } },
  { d: "04-21", vals: { "clone.linhduong": 2, "clone.linhthao": 1, "khanhlinh": 1, "trangthuynguyen": 0, "Linh Thảo": 0 } },
  { d: "04-22", vals: { "clone.linhduong": 2, "clone.linhthao": 2, "khanhlinh": 2, "trangthuynguyen": 0, "Linh Thảo": 0 } },
  { d: "04-23", vals: { "clone.linhduong": 8, "clone.linhthao": 4, "khanhlinh": 14, "trangthuynguyen": 1, "Linh Thảo": 1 } },
  { d: "04-24", vals: { "clone.linhduong": 2, "clone.linhthao": 4, "khanhlinh": 1, "trangthuynguyen": 2, "Linh Thảo": 2 } },
];
const CHART_KEYS = ["clone.linhduong", "clone.linhthao", "khanhlinh", "trangthuynguyen", "Linh Thảo"];

const POSTS = [
  { time: "16:51:51", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Cá nhân", gid: "-", text: "test", imgs: 1, status: "OK"  },
  { time: "16:41:20", date: "24/04/2026", acc: "Linh Thảo Us Authentic",plat: "Zalo", where: "Group",   gid: "Test đăng bài", text: "test", imgs: 2, status: "OK" },
  { time: "16:40:35", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Cá nhân", gid: "-", text: "Son Lancome 221", imgs: 4, status: "OK" },
  { time: "15:47:06", date: "24/04/2026", acc: "khanhlinh",            plat: "FB",   where: "Cá nhân", gid: "-", text: "—",    imgs: 3, status: "OK" },
  { time: "15:21:49", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Cá nhân", gid: "-", text: "son lancome", imgs: 3, status: "OK" },
  { time: "15:16:20", date: "24/04/2026", acc: "Linh Thảo Us Authentic",plat: "Zalo", where: "Group",   gid: "Test đăng bài", text: "Son Lancome 221 🔥 8 cây cầm...", imgs: 5, status: "OK" },
  { time: "15:01:31", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Cá nhân", gid: "-", text: "dầu dưỡng da", imgs: 4, status: "OK" },
  { time: "14:56:57", date: "24/04/2026", acc: "clone.linhduong",      plat: "FB",   where: "Cá nhân", gid: "-", text: "dầu dưỡng da", imgs: 3, status: "FAIL" },
  { time: "14:36:01", date: "24/04/2026", acc: "Linh Thảo Us Authentic",plat: "Zalo", where: "Group",   gid: "Test đăng bài", text: "Hop tinh Hop ly Hop troi - chiếc áo khoác...", imgs: 4, status: "OK" },
  { time: "13:41:06", date: "24/04/2026", acc: "Linh Thảo Us Authentic",plat: "Zalo", where: "Group",   gid: "Test đăng bài", text: "dầu dưỡng da", imgs: 4, status: "OK" },
  { time: "13:41:03", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Group",   gid: "Test",           text: "Test", imgs: 5, status: "OK" },
  { time: "13:39:14", date: "24/04/2026", acc: "clone.linhthao",       plat: "FB",   where: "Cá nhân", gid: "-", text: "dầu dưỡng da", imgs: 3, status: "OK" },
];

const MANAGED_ACCOUNTS = [
  { name: "clone.linhthao",        plat: "Facebook", status: "active", posts: 20, success: 75, last: "2m ago",  avatar: "CL" },
  { name: "khanhlinh",             plat: "Facebook", status: "active", posts: 19, success: 79, last: "14m ago", avatar: "KL" },
  { name: "clone.linhduong",       plat: "Facebook", status: "active", posts: 17, success: 94, last: "1h ago",  avatar: "CD" },
  { name: "trangthuynguyen",       plat: "Facebook", status: "warn",   posts:  3, success:  0, last: "6h ago",  avatar: "TN" },
  { name: "Linh Thảo Us Authentic",plat: "Zalo",     status: "active", posts:  3, success:100, last: "3m ago",  avatar: "LA" },
  { name: "clone.linhthao",        plat: "Zalo",     status: "idle",   posts:  2, success:100, last: "yesterday", avatar: "CZ" },
];

// ────────────────────── Utilities ──────────────────────
const imgThumb = (seed, color = "#c7b7ff") => {
  // deterministic striped placeholder per seed
  const hues = ["#fecaca", "#fed7aa", "#fde68a", "#bbf7d0", "#bfdbfe", "#ddd6fe", "#fbcfe8"];
  const h = hues[Math.abs(seed.charCodeAt(0) + (seed.charCodeAt(1) || 0)) % hues.length];
  return h;
};

Object.assign(window, {
  Icon, IconDash, IconPost, IconUsers, IconSpy, IconSettings, IconBell, IconSearch,
  IconPlus, IconFilter, IconChevron, IconCheck, IconX, IconRetry, IconTrash, IconImage,
  IconCal, IconFB, IconZalo, IconTrend, IconDot, IconMore, IconExport, IconPlay,
  STATS, ACCOUNTS, GROUPS, CHART, CHART_KEYS, POSTS, MANAGED_ACCOUNTS, imgThumb,
});
