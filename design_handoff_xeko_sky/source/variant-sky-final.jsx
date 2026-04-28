/* SKY FINAL — Accounts 3 tabs ported into gradient Sky theme */

const SkyAccounts = ({ tab = "accounts" }) => {
  const T = GRADIENT_THEMES.sky;
  const tabs = [
    { k: "accounts", label: "Tài khoản", icon: IconUsers },
    { k: "channels", label: "Cài đặt kênh", icon: IconSettings },
    { k: "history",  label: "Lịch sử", icon: IconCal },
  ];
  const profiles = [
    { name: "Linh Duong US", user: "linh.duong.us", chromium: "clone.linhduong" },
    { name: "Linh Thảo US", user: "thaous.auth", chromium: "clone.linhthao" },
    { name: "Khanh Linh", user: "phuong.nguyen.369719", chromium: "khanhlinh" },
    { name: "Trang Thuy Nguyen", user: "61562828336858", chromium: "trangthuynguyen" },
  ];
  const zalo = [
    { name: "Zalo Tram Truong", key: "Zalo.TramTruong" },
    { name: "Zalo Linh Thảo", key: "LinhThao" },
    { name: "Zalo Linh Duong", key: "LinhDuong" },
  ];
  const history = [
    { time: "21:27", profile: "trangthuynguyen", action: "Đổi profile Chromium", status: "ok" },
    { time: "21:26", profile: "trangthuynguyen", action: "Đăng nhập thành công", status: "ok" },
    { time: "18:42", profile: "clone.linhduong", action: "Token hết hạn — cần login lại", status: "warn" },
    { time: "16:51", profile: "clone.linhthao",  action: "Đăng nhập thành công", status: "ok" },
    { time: "14:20", profile: "khanhlinh",       action: "Thêm kênh: Asale", status: "ok" },
    { time: "09:15", profile: "clone.linhthao",  action: "Gán 4 nhóm Facebook", status: "ok" },
  ];
  const card = {
    background: T.surface, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
    border: `1px solid ${T.border}`, borderRadius: 14,
    boxShadow: "0 4px 18px rgba(20,30,60,.04)",
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", height: "100%", background: T.bgMesh, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <GrSidebar active="Quản lý tài khoản" T={T} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
        <GrTopbar title="Quản lý tài khoản" crumbs={["Workspace", "Profile · Facebook · Zalo"]} T={T} />
        <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 16, overflow: "auto", flex: 1 }}>
          <div style={{ display: "flex", gap: 4, padding: 4, ...card, borderRadius: 12, width: "fit-content" }}>
            {tabs.map(tb => {
              const isActive = tb.k === tab;
              return (
                <div key={tb.k} style={{
                  padding: "8px 16px", borderRadius: 9, cursor: "pointer",
                  background: isActive ? T.brandGradient : "transparent",
                  color: isActive ? "#fff" : T.textMuted,
                  fontSize: 12.5, fontWeight: 700,
                  display: "inline-flex", alignItems: "center", gap: 6,
                  boxShadow: isActive ? `0 4px 14px ${T.brand}40` : "none",
                }}>
                  <tb.icon size={13} stroke={isActive ? "#fff" : T.textMuted} /> {tb.label}
                </div>
              );
            })}
          </div>

          {tab === "accounts" && (
            <>
              <div style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: "#eff6ff", display: "grid", placeItems: "center" }}><IconFB size={11} stroke="#1877f2" /></div>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: T.text, letterSpacing: "0.04em" }}>FACEBOOK</span>
                  <span style={{ fontSize: 11, color: T.textDim }}>· {profiles.length} profile</span>
                </div>
                {profiles.map((p, i) => (
                  <div key={p.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 16, padding: "14px 18px", borderBottom: i === profiles.length - 1 ? "none" : `1px solid ${T.borderSoft}` }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: T.avatarBg, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, color: T.avatarFg }}>{p.name.slice(0,2).toUpperCase()}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>{p.user} · profile: <strong style={{ color: T.textMuted }}>{p.chromium}</strong></div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${T.brandBorder}`, background: T.brandSoft, color: T.brandDeep, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>Sửa</button>
                      <button style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: T.brandGradient, color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer", boxShadow: `0 3px 10px ${T.brand}35` }}>Login</button>
                      <button style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", display: "grid", placeItems: "center", cursor: "pointer" }}><IconTrash size={12} stroke="#e5484d" /></button>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: "#ecfeff", display: "grid", placeItems: "center" }}><IconZalo size={11} stroke="#0068ff" /></div>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: T.text, letterSpacing: "0.04em" }}>ZALO</span>
                  <span style={{ fontSize: 11, color: T.textDim }}>· {zalo.length} tài khoản</span>
                </div>
                {zalo.map((z, i) => (
                  <div key={z.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 16, padding: "14px 18px", borderBottom: i === zalo.length - 1 ? "none" : `1px solid ${T.borderSoft}` }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: "#ecfeff", border: "1px solid #cffafe", display: "grid", placeItems: "center" }}><IconZalo size={16} stroke="#0068ff" /></div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{z.name}</div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>Key: <strong style={{ color: T.textMuted }}>{z.key}</strong></div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${T.brandBorder}`, background: T.brandSoft, color: T.brandDeep, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>Sửa</button>
                      <button style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: T.brandGradient, color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>Login</button>
                      <button style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", display: "grid", placeItems: "center", cursor: "pointer" }}><IconTrash size={12} stroke="#e5484d" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "channels" && (
            <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14, flex: 1, minHeight: 0 }}>
              <div style={{ ...card, padding: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginBottom: 10 }}>Profile</div>
                {[{ n: "Linh Duong US", c: "3/3", a: true }, { n: "Linh Thảo US", c: "1/1" }, { n: "Khanh Linh", c: "2/1" }, { n: "Trang Thuy Nguyen", c: "2/0" }].map(p => (
                  <div key={p.n} style={{
                    padding: "10px 11px", borderRadius: 9, marginBottom: 4, cursor: "pointer",
                    background: p.a ? T.brandSoft : "transparent",
                    border: p.a ? `1px solid ${T.brandBorder}` : "1px solid transparent",
                    display: "flex", alignItems: "center", gap: 8,
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: 999, background: p.a ? T.brand : "#d4d4d8" }} />
                    <span style={{ fontSize: 12.5, fontWeight: p.a ? 700 : 500, color: p.a ? T.brandDeep : T.text, flex: 1 }}>{p.n}</span>
                    <span style={{ fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: p.a ? T.brand : T.textDim, fontWeight: 700 }}>{p.c}</span>
                  </div>
                ))}
              </div>
              <div style={{ ...card, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <IconUsers size={15} stroke={T.brand} />
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text, flex: 1 }}>Linh Duong US</div>
                </div>
                {[
                  { head: "FACEBOOK · CÔNG TY", icon: "fb", items: [
                    { n: "Asale", id: "350987965423767", on: true },
                    { n: "Tổng Kho", id: "532693344311571", on: true },
                  ]},
                  { head: "FACEBOOK · TEST", icon: "fb", items: [
                    { n: "Test", id: "280381832509795", on: true },
                    { n: "Test 1", id: "846718511673167", on: false },
                  ]},
                  { head: "ZALO", icon: "zalo", items: [
                    { n: "Test đăng bài", id: "Test đăng bài", on: true },
                    { n: "SỈ HÀNG ORDER MỸ · LINH THẢO", id: "grouporderlinhthao", on: false },
                    { n: "SỈ HÀNG ORDER MỸ · LINH DƯƠNG", id: "grouporderlinhduong", on: true },
                  ]},
                ].map(sec => (
                  <div key={sec.head}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, background: sec.icon === "fb" ? "#eff6ff" : "#ecfeff", display: "grid", placeItems: "center" }}>
                        {sec.icon === "fb" ? <IconFB size={9} stroke="#1877f2" /> : <IconZalo size={9} stroke="#0068ff" />}
                      </div>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: T.textMuted, letterSpacing: "0.06em" }}>{sec.head}</span>
                    </div>
                    {sec.items.map((it, ii) => (
                      <div key={ii} style={{
                        padding: "9px 12px", borderRadius: 9, marginBottom: 4,
                        background: it.on ? T.brandSoft : "transparent",
                        border: `1px solid ${it.on ? T.brandBorder : T.borderSoft}`,
                        display: "flex", alignItems: "center", gap: 10,
                      }}>
                        <div style={{ width: 15, height: 15, borderRadius: 4, background: it.on ? T.brand : "#fff", border: `1.5px solid ${it.on ? T.brand : "#d4d4d8"}`, display: "grid", placeItems: "center", flexShrink: 0 }}>
                          {it.on && <IconCheck size={9} stroke="#fff" sw={3} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{it.n}</div>
                          <div style={{ fontSize: 10.5, color: T.textDim, fontFamily: "'JetBrains Mono', monospace" }}>{it.id}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "history" && (
            <div style={{ ...card, overflow: "hidden" }}>
              <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                <IconCal size={14} stroke={T.textMuted} />
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Lịch sử thao tác</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 11.5, color: T.textMuted }}>{history.length} sự kiện · hôm nay</div>
              </div>
              <div style={{ padding: "12px 18px", position: "relative" }}>
                <div style={{ position: "absolute", left: 29, top: 22, bottom: 22, width: 1, background: T.borderSoft }} />
                {history.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 14, padding: "10px 0", position: "relative", alignItems: "center" }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: 999, background: "#fff",
                      border: `2px solid ${h.status === "ok" ? "#0ea571" : "#f59e0b"}`,
                      display: "grid", placeItems: "center", flexShrink: 0, zIndex: 1,
                    }}>
                      {h.status === "ok" ? <IconCheck size={10} stroke="#0ea571" sw={3} /> : <div style={{ width: 6, height: 6, borderRadius: 999, background: "#f59e0b" }} />}
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: T.textMuted, width: 80 }}><strong style={{ color: T.text }}>{h.time}</strong></div>
                    <div style={{ width: 24, height: 24, borderRadius: 7, background: T.avatarBg, display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 800, color: T.avatarFg }}>{h.profile.slice(0,2).toUpperCase()}</div>
                    <div style={{ flex: 1, fontSize: 12.5, color: T.text }}><strong>{h.profile}</strong> — <span style={{ color: T.textMuted }}>{h.action}</span></div>
                    {h.status === "warn" && <button style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #f59e0b", background: "#fffbeb", color: "#b45309", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Login lại</button>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SkyAccounts });
