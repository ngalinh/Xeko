/* Gradient themes — Mesh, Aurora, Sunset / Peach */

const GRADIENT_THEMES = {
  aurora: {
    name: "Aurora · Pastel rất nhẹ",
    bgMesh: `
      radial-gradient(circle at 0% 0%, #eef2ff 0%, transparent 55%),
      radial-gradient(circle at 100% 0%, #f5f0ff 0%, transparent 55%),
      radial-gradient(circle at 50% 100%, #f0fbf7 0%, transparent 55%),
      linear-gradient(135deg, #fcfaff, #fafbff)
    `,
    surface: "rgba(255,255,255,0.75)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.6)",
    border: "rgba(147,128,220,0.13)",
    borderSoft: "rgba(147,128,220,0.06)",
    text: "#1a0f2e",
    textMuted: "#6b607f",
    textDim: "#a39ab5",
    brand: "#8b7aea",
    brandDeep: "#6d5fd4",
    brandSoft: "rgba(139,122,234,0.06)",
    brandBorder: "rgba(139,122,234,0.16)",
    brandGradient: "linear-gradient(135deg, #a99cf0, #f4b5d1)",
    avatarBg: "linear-gradient(135deg,#e0e7ff,#fce7f3)",
    avatarFg: "#6d5fd4",
  },
  peach: {
    name: "Peach · Cam hồng rất nhẹ",
    bgMesh: `
      radial-gradient(circle at 0% 0%, #fff1e6 0%, transparent 55%),
      radial-gradient(circle at 100% 20%, #fef0f5 0%, transparent 55%),
      radial-gradient(circle at 80% 100%, #fffbeb 0%, transparent 55%),
      linear-gradient(135deg, #fffaf5, #fffafc)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.62)",
    border: "rgba(234,130,80,0.11)",
    borderSoft: "rgba(234,130,80,0.05)",
    text: "#2a1d0f",
    textMuted: "#8a6a50",
    textDim: "#b8a290",
    brand: "#f49b73",
    brandDeep: "#e07854",
    brandSoft: "rgba(244,155,115,0.07)",
    brandBorder: "rgba(244,155,115,0.18)",
    brandGradient: "linear-gradient(135deg, #fbbf96, #f6bad0)",
    avatarBg: "linear-gradient(135deg,#fed7aa,#fbcfe8)",
    avatarFg: "#b05a38",
  },
  ocean: {
    name: "Ocean · Mint xanh rất nhẹ",
    bgMesh: `
      radial-gradient(circle at 10% 10%, #eafcfd 0%, transparent 55%),
      radial-gradient(circle at 90% 30%, #eef2ff 0%, transparent 55%),
      radial-gradient(circle at 60% 100%, #effef3 0%, transparent 55%),
      linear-gradient(160deg, #fafefe, #fafbff)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.6)",
    border: "rgba(20,150,180,0.12)",
    borderSoft: "rgba(20,150,180,0.05)",
    text: "#0c1f33",
    textMuted: "#5a6f85",
    textDim: "#92a5b8",
    brand: "#5eb8c4",
    brandDeep: "#3a95a4",
    brandSoft: "rgba(94,184,196,0.06)",
    brandBorder: "rgba(94,184,196,0.17)",
    brandGradient: "linear-gradient(135deg, #9fdce4, #b6c8f0)",
    avatarBg: "linear-gradient(135deg,#cff9fe,#dde6fe)",
    avatarFg: "#2d7c8a",
  },
  lavender: {
    name: "Lavender · Tím nhạt mơ màng",
    bgMesh: `
      radial-gradient(circle at 0% 20%, #f3eeff 0%, transparent 55%),
      radial-gradient(circle at 100% 0%, #fdf0fb 0%, transparent 55%),
      radial-gradient(circle at 50% 100%, #f7f2ff 0%, transparent 55%),
      linear-gradient(135deg, #fdfcff, #fffafe)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.6)",
    border: "rgba(168,140,220,0.12)",
    borderSoft: "rgba(168,140,220,0.05)",
    text: "#1f1430",
    textMuted: "#6e5e87",
    textDim: "#a89cb8",
    brand: "#a88cdc",
    brandDeep: "#8a6cc4",
    brandSoft: "rgba(168,140,220,0.06)",
    brandBorder: "rgba(168,140,220,0.16)",
    brandGradient: "linear-gradient(135deg, #c8b5f0, #f0c4e8)",
    avatarBg: "linear-gradient(135deg,#ede4ff,#fbe5f5)",
    avatarFg: "#7a5cb4",
  },
  mint: {
    name: "Mint · Xanh lá pastel",
    bgMesh: `
      radial-gradient(circle at 10% 0%, #ecfdf5 0%, transparent 55%),
      radial-gradient(circle at 100% 30%, #f0fdfa 0%, transparent 55%),
      radial-gradient(circle at 50% 100%, #fef9e7 0%, transparent 55%),
      linear-gradient(135deg, #fafffd, #fdfffa)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.62)",
    border: "rgba(80,180,140,0.11)",
    borderSoft: "rgba(80,180,140,0.05)",
    text: "#0f2418",
    textMuted: "#4d7a64",
    textDim: "#8aaa9c",
    brand: "#6cc7a4",
    brandDeep: "#4ba888",
    brandSoft: "rgba(108,199,164,0.06)",
    brandBorder: "rgba(108,199,164,0.17)",
    brandGradient: "linear-gradient(135deg, #a4e8cc, #c5e8a4)",
    avatarBg: "linear-gradient(135deg,#bbf7d0,#fef08a)",
    avatarFg: "#2d7a5a",
  },
  rose: {
    name: "Rose · Hồng phấn nữ tính",
    bgMesh: `
      radial-gradient(circle at 0% 0%, #fff1f5 0%, transparent 55%),
      radial-gradient(circle at 100% 30%, #fef3f8 0%, transparent 55%),
      radial-gradient(circle at 60% 100%, #fff5f0 0%, transparent 55%),
      linear-gradient(135deg, #fffafc, #fffbf9)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.62)",
    border: "rgba(220,100,140,0.11)",
    borderSoft: "rgba(220,100,140,0.05)",
    text: "#2a0f1c",
    textMuted: "#8a5067",
    textDim: "#b89aa6",
    brand: "#e88aab",
    brandDeep: "#c66a8e",
    brandSoft: "rgba(232,138,171,0.07)",
    brandBorder: "rgba(232,138,171,0.18)",
    brandGradient: "linear-gradient(135deg, #f4b5cc, #f7c9b5)",
    avatarBg: "linear-gradient(135deg,#fce7f3,#fed7d7)",
    avatarFg: "#a94872",
  },
  sky: {
    name: "Sky · Trời xanh trong",
    bgMesh: `
      radial-gradient(circle at 0% 0%, #eff6ff 0%, transparent 55%),
      radial-gradient(circle at 100% 20%, #f0f9ff 0%, transparent 55%),
      radial-gradient(circle at 50% 100%, #f5f3ff 0%, transparent 55%),
      linear-gradient(160deg, #fafdff, #fcfbff)
    `,
    surface: "rgba(255,255,255,0.78)",
    surfaceSolid: "#ffffff",
    surfaceSoft: "rgba(255,255,255,0.62)",
    border: "rgba(100,150,220,0.12)",
    borderSoft: "rgba(100,150,220,0.05)",
    text: "#0c1a2e",
    textMuted: "#506580",
    textDim: "#8a9cb5",
    brand: "#7fa8e8",
    brandDeep: "#5d88cc",
    brandSoft: "rgba(127,168,232,0.06)",
    brandBorder: "rgba(127,168,232,0.16)",
    brandGradient: "linear-gradient(135deg, #a5c5f4, #c5b5f0)",
    avatarBg: "linear-gradient(135deg,#dbeafe,#e0e7ff)",
    avatarFg: "#3a6cb4",
  },
};

// ─── Glassmorphism sidebar ───
const GrSidebar = ({ active, T }) => {
  const items = [
    { k: "Dashboard", icon: IconDash },
    { k: "Đăng bài", icon: IconPost },
    { k: "Quản lý tài khoản", icon: IconUsers },
    { k: "Spy bài viết", icon: IconSpy, badge: "Soon" },
  ];
  return (
    <aside style={{
      padding: "20px 14px",
      borderRight: `1px solid ${T.border}`,
      background: T.surface,
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px 18px" }}>
        <div style={{
          width: 40, height: 40, borderRadius: 11,
          background: T.brandGradient,
          color: "#fff", display: "grid", placeItems: "center",
          fontWeight: 800, fontSize: 17,
          boxShadow: `0 8px 24px ${T.brand}45, inset 0 1px 0 rgba(255,255,255,.3)`,
        }}>X</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em", color: T.text }}>Xeko</div>
          <div style={{ fontSize: 10.5, color: T.textDim, marginTop: -2 }}>Auto posting suite</div>
        </div>
      </div>

      <div style={{ fontSize: 10.5, color: T.textDim, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "0 10px 6px" }}>Workspace</div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 18 }}>
        {items.map(({ k, icon: I, badge }) => {
          const isActive = k === active;
          return (
            <div key={k} style={{
              display: "flex", alignItems: "center", gap: 11, padding: "10px 11px",
              borderRadius: 10, cursor: "pointer",
              background: isActive ? T.surfaceSolid : "transparent",
              color: isActive ? T.brandDeep : T.textMuted,
              fontWeight: isActive ? 700 : 500, fontSize: 13.5,
              border: isActive ? `1px solid ${T.brandBorder}` : "1px solid transparent",
              boxShadow: isActive ? `0 4px 14px ${T.brand}20` : "none",
            }}>
              <I size={15} stroke={isActive ? T.brand : T.textMuted} />
              <span style={{ flex: 1 }}>{k}</span>
              {badge && (
                <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#fef5e1", color: "#92400e", letterSpacing: "0.04em" }}>{badge}</span>
              )}
            </div>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{
        padding: 12, borderRadius: 12,
        background: T.surfaceSolid,
        border: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", gap: 8,
        boxShadow: "0 4px 14px rgba(0,0,0,.04)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: 999, background: "#0ea571", boxShadow: "0 0 0 3px rgba(14,165,113,.18)" }} />
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Server online</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10.5, color: T.textDim, fontFamily: "'JetBrains Mono', monospace" }}>v1.0</div>
        </div>
        <div style={{ fontSize: 10.5, color: T.textMuted }}>CPU 24% · RAM 1.2GB</div>
      </div>
    </aside>
  );
};

const GrTopbar = ({ title, crumbs, T }) => (
  <div style={{
    height: 64,
    background: T.surface,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    borderBottom: `1px solid ${T.border}`,
    padding: "0 28px", display: "flex", alignItems: "center", gap: 16,
  }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: T.textDim, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{crumbs.join(" / ")}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginTop: 2 }}>{title}</div>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", border: `1px solid ${T.border}`, borderRadius: 10, background: T.surfaceSolid, width: 240 }}>
      <IconSearch size={13} stroke={T.textDim} />
      <input placeholder="Tìm kiếm..." style={{ border: "none", outline: "none", flex: 1, fontSize: 12.5, background: "transparent", color: T.text }} />
    </div>
    <button style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSolid, display: "grid", placeItems: "center", cursor: "pointer" }}>
      <IconBell size={15} stroke={T.textMuted} />
    </button>
    <div style={{ width: 36, height: 36, borderRadius: 10, background: T.avatarBg, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, color: T.avatarFg }}>AN</div>
  </div>
);

// ─── Dashboard with glass cards on mesh bg ───
const GrDashboard = ({ T }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "248px 1fr", height: "100%",
    background: T.bgMesh, fontFamily: "'Plus Jakarta Sans', sans-serif",
  }}>
    <GrSidebar active="Dashboard" T={T} />
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <GrTopbar title="Dashboard" crumbs={["Workspace", "Thống kê"]} T={T} />
      <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 16, overflow: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          {[
            { label: "Tổng bài đăng", v: 128, d: "+12 hôm nay", accent: true },
            { label: "Thành công", v: 119, d: "93% tỉ lệ" },
            { label: "Thất bại", v: 9, d: "cần xem lại" },
            { label: "Tài khoản active", v: 7, d: "4 FB · 3 Zalo" },
          ].map((s, i) => (
            <div key={i} style={{
              background: s.accent ? T.brandGradient : T.surface,
              backdropFilter: !s.accent ? "blur(14px)" : undefined,
              WebkitBackdropFilter: !s.accent ? "blur(14px)" : undefined,
              border: s.accent ? "none" : `1px solid ${T.border}`,
              borderRadius: 14, padding: "18px 20px",
              color: s.accent ? "#fff" : T.text,
              boxShadow: s.accent
                ? `0 10px 30px ${T.brand}40, inset 0 1px 0 rgba(255,255,255,.25)`
                : "0 4px 18px rgba(20,10,50,.04)",
              position: "relative", overflow: "hidden",
            }}>
              {s.accent && (
                <div style={{ position: "absolute", top: -20, right: -20, width: 80, height: 80, borderRadius: 999, background: "rgba(255,255,255,.15)", filter: "blur(20px)" }} />
              )}
              <div style={{ fontSize: 11, color: s.accent ? "rgba(255,255,255,.85)" : T.textMuted, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", position: "relative" }}>{s.label}</div>
              <div style={{ fontSize: 34, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.04em", marginTop: 6, position: "relative" }}>{s.v}</div>
              <div style={{ fontSize: 11.5, color: s.accent ? "rgba(255,255,255,.8)" : T.textDim, marginTop: 4, position: "relative" }}>{s.d}</div>
            </div>
          ))}
        </div>

        {/* Chart */}
        <div style={{
          background: T.surface,
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: `1px solid ${T.border}`,
          borderRadius: 14, padding: "20px 22px",
          boxShadow: "0 4px 18px rgba(20,10,50,.04)",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Hoạt động 7 ngày qua</div>
            <div style={{ fontSize: 11.5, color: T.textMuted }}>Tổng 128 bài · TB 18.3/ngày</div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 160, paddingTop: 10 }}>
            {[14, 22, 18, 28, 16, 24, 18].map((v, i) => {
              const h = (v / 30) * 100;
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 10, color: T.textDim, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{v}</div>
                  <div style={{
                    width: "100%", height: `${h}%`,
                    background: T.brandGradient,
                    borderRadius: "8px 8px 3px 3px",
                    boxShadow: `0 4px 14px ${T.brand}35`,
                    opacity: i === 3 ? 1 : 0.82,
                  }} />
                  <div style={{ fontSize: 10.5, color: T.textDim, fontFamily: "'JetBrains Mono', monospace" }}>T{i + 2}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {[
            {
              title: "Top tài khoản",
              rows: [
                { n: "Linh Duong US", v: 42, plat: "FB" },
                { n: "Zalo Linh Thảo", v: 31, plat: "Zalo" },
                { n: "Trang Thuy Nguyen", v: 28, plat: "FB" },
                { n: "Khanh Linh", v: 19, plat: "FB" },
              ],
              render: (r, i, last) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: !last ? `1px solid ${T.borderSoft}` : "none" }}>
                  <div style={{ width: 24, height: 24, borderRadius: 7, background: r.plat === "FB" ? "#eff6ff" : "#ecfeff", display: "grid", placeItems: "center" }}>
                    {r.plat === "FB" ? <IconFB size={11} stroke="#1877f2" /> : <IconZalo size={11} stroke="#0068ff" />}
                  </div>
                  <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: T.text }}>{r.n}</div>
                  <div style={{ width: 80, height: 6, borderRadius: 999, background: T.borderSoft, overflow: "hidden" }}>
                    <div style={{ width: `${(r.v / 42) * 100}%`, height: "100%", background: T.brandGradient }} />
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: T.text, width: 28, textAlign: "right" }}>{r.v}</div>
                </div>
              ),
            },
            {
              title: "Hoạt động gần nhất",
              rows: [
                { t: "21:27", msg: "Đăng thành công vào 4 nhóm" },
                { t: "21:26", msg: "Chuyển profile trangthuynguyen" },
                { t: "18:42", msg: "Token clone.linhduong hết hạn" },
                { t: "16:51", msg: "Đăng nhập clone.linhthao" },
              ],
              render: (r, i, last) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: !last ? `1px solid ${T.borderSoft}` : "none", alignItems: "flex-start" }}>
                  <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: T.textMuted, width: 44, paddingTop: 2, fontWeight: 700 }}>{r.t}</div>
                  <div style={{ flex: 1, fontSize: 12.5, color: T.text, lineHeight: 1.5 }}>{r.msg}</div>
                </div>
              ),
            },
          ].map((c, ci) => (
            <div key={ci} style={{
              background: T.surface,
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              border: `1px solid ${T.border}`,
              borderRadius: 14, padding: "18px 20px",
              boxShadow: "0 4px 18px rgba(20,10,50,.04)",
            }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginBottom: 10 }}>{c.title}</div>
              {c.rows.map((r, i) => c.render(r, i, i === c.rows.length - 1))}
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ─── Chatbot with gradient bubbles ───
const GrChatbot = ({ T }) => {
  const Bubble = ({ side, children, time, name }) => (
    <div style={{
      display: "flex", gap: 10, padding: "8px 0",
      flexDirection: side === "bot" ? "row" : "row-reverse",
      alignItems: "flex-start",
    }}>
      {side === "bot" && (
        <div style={{ width: 34, height: 34, borderRadius: 999, background: T.brandGradient, display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 13, flexShrink: 0, boxShadow: `0 4px 14px ${T.brand}40` }}>X</div>
      )}
      <div style={{ maxWidth: "62%", display: "flex", flexDirection: "column", alignItems: side === "bot" ? "flex-start" : "flex-end" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: side === "bot" ? T.brand : T.text }}>{name}</span>
          <span style={{ fontSize: 10.5, color: T.textDim, fontFamily: "'JetBrains Mono', monospace" }}>{time}</span>
        </div>
        {children}
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", height: "100%", background: T.bgMesh, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <GrSidebar active="Đăng bài" T={T} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
        <GrTopbar title="Đăng bài" crumbs={["Workspace", "Chatbot · trangthuynguyen"]} T={T} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: 20 }}>
          <div style={{
            flex: 1,
            background: T.surface,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: `1px solid ${T.border}`,
            borderRadius: 18,
            boxShadow: "0 10px 40px rgba(20,10,50,.06)",
            display: "flex", flexDirection: "column", overflow: "hidden",
          }}>
            <div style={{
              padding: "12px 24px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: T.brand, boxShadow: `0 0 0 4px ${T.brandSoft}` }} />
              <div style={{ fontSize: 12, color: T.text }}>
                Phiên với <strong>trangthuynguyen</strong>
              </div>
            </div>

            <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
              <Bubble side="bot" name="Xeko" time="21:26">
                <div style={{
                  background: T.surfaceSolid,
                  border: `1px solid ${T.brandBorder}`,
                  borderRadius: "4px 16px 16px 16px",
                  padding: "12px 14px", fontSize: 13, lineHeight: 1.5, color: T.text,
                  boxShadow: `0 4px 18px ${T.brand}12`,
                }}>
                  Ting ting! Xeko báo thức đây~ 🔔<br/>
                  Đã đến giờ đăng bài rồi bạn ơi!
                  <div style={{ marginTop: 10, padding: "9px 14px", background: T.brandGradient, borderRadius: 9, display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "#fff", boxShadow: `0 4px 14px ${T.brand}40` }}>
                    <IconUsers size={13} stroke="#fff" /> Chọn Profile
                  </div>
                </div>
              </Bubble>

              <Bubble side="user" name="Bạn" time="21:26">
                <div style={{
                  background: T.brandGradient, color: "#fff",
                  borderRadius: "16px 4px 16px 16px",
                  padding: "11px 16px", fontSize: 13, fontWeight: 600,
                  boxShadow: `0 6px 18px ${T.brand}50`,
                }}>
                  Chọn Profile
                </div>
              </Bubble>

              <Bubble side="bot" name="Xeko" time="21:26">
                <div style={{
                  background: T.surfaceSolid,
                  border: `1px solid ${T.brandBorder}`,
                  borderRadius: "4px 16px 16px 16px",
                  padding: "12px 14px", fontSize: 13, color: T.text,
                  boxShadow: `0 4px 18px ${T.brand}12`,
                }}>
                  Bạn chọn profile trình duyệt cho Xeko với nha:
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    {["Linh Duong US", "Linh Thảo US", "Khanh Linh", "Trang Thuy Nguyen"].map(p => (
                      <div key={p} style={{
                        padding: "9px 14px", background: T.brandSoft,
                        border: `1px solid ${T.brandBorder}`, borderRadius: 9,
                        display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                        fontSize: 12.5, fontWeight: 600, color: T.brandDeep,
                      }}>
                        <IconUsers size={12} stroke={T.brand} /> {p}
                      </div>
                    ))}
                  </div>
                </div>
              </Bubble>

              <Bubble side="user" name="Bạn" time="21:27">
                <div style={{
                  background: T.brandGradient, color: "#fff",
                  borderRadius: "16px 4px 16px 16px",
                  padding: "11px 16px", fontSize: 13, fontWeight: 600,
                  boxShadow: `0 6px 18px ${T.brand}50`,
                }}>
                  trangthuynguyen
                </div>
              </Bubble>

              <Bubble side="bot" name="Xeko" time="21:27">
                <div style={{
                  background: T.surfaceSolid,
                  border: `1px solid ${T.brandBorder}`,
                  borderRadius: "4px 16px 16px 16px",
                  padding: "12px 14px", fontSize: 13, lineHeight: 1.5, color: T.text,
                  boxShadow: `0 4px 18px ${T.brand}12`,
                }}>
                  Xeko chốt profile <strong>trangthuynguyen</strong> rồi nhá!<br/>
                  Giờ muốn Xeko đăng liền hay lên lịch?
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <div style={{ padding: "8px 14px", background: T.brandGradient, color: "#fff", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 14px ${T.brand}40` }}>⚡ Đăng liền</div>
                    <div style={{ padding: "8px 14px", background: T.surfaceSolid, border: `1px solid ${T.brandBorder}`, color: T.brandDeep, borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>📅 Lên lịch</div>
                  </div>
                </div>
              </Bubble>
            </div>

            <div style={{ padding: 16, borderTop: `1px solid ${T.border}` }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 6px 6px 12px",
                border: `1.5px solid ${T.brandBorder}`, borderRadius: 14,
                background: T.surfaceSolid,
              }}>
                <IconImage size={16} stroke={T.textMuted} />
                <input placeholder="Nhập nội dung bài viết..." style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 13, padding: "9px 0", color: T.text, fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
                <button style={{
                  width: 38, height: 38, borderRadius: 11, border: "none",
                  background: T.brandGradient,
                  color: "#fff", display: "grid", placeItems: "center", cursor: "pointer",
                  boxShadow: `0 6px 18px ${T.brand}55`,
                }}>
                  <Icon size={15} stroke="#fff" sw={2.2} d={<><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></>} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { GRADIENT_THEMES, GrDashboard, GrChatbot });
