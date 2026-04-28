# Handoff: Xeko Redesign — Sky Gradient

## Overview

Xeko là tool tự động đăng bài Facebook / Zalo cho seller. Bản redesign này thay thế giao diện cũ (sidebar trắng + tím #6d4aff đậm) bằng một hệ thống **light, airy, glassmorphism** với palette **Sky** (xanh trời + tím rất nhạt).

Phạm vi handoff bao gồm 3 màn chính:
1. **Dashboard** — thống kê đăng bài
2. **Đăng bài (Chatbot)** — chat-style composer + lịch trình
3. **Quản lý tài khoản** (3 tabs: Tài khoản · Cài đặt kênh · Lịch sử)

## About the Design Files

Các file trong bundle này là **design references viết bằng HTML + React + Babel inline** — prototypes thể hiện look & behavior mong muốn, **không phải production code để copy trực tiếp**.

Task của dev là **recreate lại các design này trong codebase Xeko hiện tại** (giả định React + framework UI sẵn có) bằng patterns / component library / state management đã có. Nếu chưa có codebase, chọn stack phù hợp (khuyên dùng **React + TypeScript + CSS Modules hoặc Tailwind**) và implement ở đó.

Đừng:
- Copy nguyên file `.jsx` này vào codebase production (chúng dùng inline-style + global window assignments cho mục đích prototype)
- Dùng Babel-in-browser ở production
- Bê nguyên `<DCArtboard>` / `<DCSection>` — đó là design canvas wrapper, không phải UI thật

Hãy:
- Lấy **design tokens** (colors, spacing, typography) trong README này làm nguồn chính
- Lấy **layout structure** (grid, flex, padding/margin chi tiết) từ source files làm reference
- Lấy **copy text** chính xác từ source

## Fidelity

**High-fidelity (hifi)** — pixel-perfect mockups:
- Final colors (hex chính xác)
- Final typography (Plus Jakarta Sans + JetBrains Mono)
- Final spacing, radius, shadows
- Hover/active states đã được nghĩ đến nhưng chưa hoàn toàn

Dev nên recreate UI **pixel-perfect** dùng component library của codebase. Mọi giá trị trong section "Design Tokens" bên dưới đều là final.

---

## Design Tokens

### Colors — Sky Theme

```css
/* Background mesh — apply lên app shell */
--bg-mesh: 
  radial-gradient(circle at 0% 0%, #eff6ff 0%, transparent 55%),
  radial-gradient(circle at 100% 20%, #f0f9ff 0%, transparent 55%),
  radial-gradient(circle at 50% 100%, #f5f3ff 0%, transparent 55%),
  linear-gradient(160deg, #fafdff, #fcfbff);

/* Surface (glassmorphism cards) */
--surface:        rgba(255, 255, 255, 0.78);   /* main cards, sidebar, topbar */
--surface-solid:  #ffffff;                     /* khi cần solid (modal, dropdown) */
--surface-soft:   rgba(255, 255, 255, 0.62);   /* nested panels */
--backdrop-blur:  blur(14px);                  /* sidebar dùng blur(20px) */

/* Borders */
--border:        rgba(100, 150, 220, 0.12);    /* viền chính */
--border-soft:   rgba(100, 150, 220, 0.05);    /* viền divider */

/* Text */
--text:          #0c1a2e;     /* heading, body chính */
--text-muted:    #506580;     /* phụ, label */
--text-dim:      #8a9cb5;     /* meta, timestamp */

/* Brand — Sky */
--brand:           #7fa8e8;   /* primary accent */
--brand-deep:      #5d88cc;   /* hover, focus, text trên background sáng */
--brand-soft:      rgba(127, 168, 232, 0.06);  /* tinted background */
--brand-border:    rgba(127, 168, 232, 0.16);  /* tinted border */
--brand-gradient:  linear-gradient(135deg, #a5c5f4, #c5b5f0);  /* CTA, active state */

/* Avatar fallback */
--avatar-bg:  linear-gradient(135deg, #dbeafe, #e0e7ff);
--avatar-fg:  #3a6cb4;

/* Status */
--success:    #0ea571;
--warning:    #f59e0b;
--danger:     #e5484d;
--danger-bg:  #fef2f2;
--danger-border: #fecaca;

/* Platform tints */
--fb-tint:    #eff6ff;   --fb-color:    #1877f2;
--zalo-tint:  #ecfeff;   --zalo-color:  #0068ff;
```

### Typography

```css
font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
/* Numeric / monospace (stats, IDs, timestamps): */
font-family: 'JetBrains Mono', 'SF Mono', monospace;
```

| Token | Size | Weight | Line | Use |
|---|---|---|---|---|
| `display`     | 22px  | 800 | 1.2  | Page title trong topbar |
| `h2`          | 18px  | 800 | 1.3  | Section heading |
| `h3`          | 14px  | 800 | 1.3  | Card title |
| `body`        | 13.5px | 700 | 1.5 | Item name |
| `body-default`| 13px  | 400 | 1.5  | Body text |
| `body-sm`     | 12.5px| 600 | 1.4  | Button, tab label |
| `meta`        | 12px  | 500 | 1.4  | Subtitle, secondary |
| `caption`     | 11.5px| 600 | 1.4  | Tag, badge, label |
| `micro`       | 11px  | 700 | 1.4  | Status text |
| `eyebrow`     | 10.5px| 700 | 1.4  | Section header (UPPERCASE, letter-spacing 0.06em) |
| `mono`        | 11.5px| 600 | 1.4  | IDs, timestamps |

### Spacing scale

```
4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48
```
Padding chuẩn: card content `18px`, page padding `28px`, sidebar `20px 14px`.

### Border radius

```
--radius-xs: 4px;    /* tag, micro chip */
--radius-sm: 6px;    /* small buttons */
--radius-md: 8px;    /* buttons, inputs */
--radius-lg: 10px;   /* avatar, icon containers */
--radius-xl: 12px;   /* cards (sub) */
--radius-2xl: 14px;  /* cards (main) */
--radius-pill: 999px;
```

### Shadows

```css
--shadow-card:     0 4px 18px rgba(20, 30, 60, 0.04);   /* Card chính (rất nhẹ) */
--shadow-cta:      0 4px 14px rgba(127, 168, 232, 0.25); /* Primary button */
--shadow-cta-sm:   0 3px 10px rgba(127, 168, 232, 0.35); /* Secondary primary */
--shadow-bubble:   0 4px 12px rgba(127, 168, 232, 0.30); /* User chat bubble */
```

### Layout

- App shell: `grid-template-columns: 248px 1fr` (sidebar 248px cố định)
- Topbar height: ~60px (padding 14px 28px)
- Page content: padding 28px, gap 16-20px between sections
- Dashboard stats: `grid-template-columns: repeat(4, 1fr)` gap 14px
- Chatbot: chat stream + right panel `grid-template-columns: 1fr 280px`
- Channels tab: `grid-template-columns: 260px 1fr` gap 14px

---

## Screens / Views

### 1. Dashboard

**Purpose:** seller xem nhanh hiệu suất đăng bài hôm nay.

**Layout (1280×820 reference):**
- App shell `[Sidebar 248] [Main flex-1]`
- Main: Topbar trên, content padding 28px
- Content sections từ trên xuống:
  1. **Stats row** — 4 metric cards (`Hôm nay`, `Thành công`, `Thất bại`, `Tổng cộng`)
  2. **Chart card** — stacked bar chart "Bài đăng theo ngày" (7 ngày gần nhất)
  3. **2-col grid** — `[Top tài khoản 1fr] [Top nhóm 1fr]`

**Components:**

#### Sidebar (left)
- Width 248px, `background: var(--surface)`, `backdrop-filter: blur(20px)`, `border-right: 1px solid var(--border)`
- Logo "Xeko" — gradient text (`var(--brand-gradient)` clip), font 22/800
- Nav items: Dashboard · Đăng bài · Quản lý tài khoản · Spy bài viết (badge "Soon")
- Active state: `background: var(--brand-soft)`, `border-left: 2px solid var(--brand)`, text `var(--brand-deep)`
- Hover: `background: rgba(255,255,255,0.4)`
- Bottom: user card với avatar (gradient `--avatar-bg`), tên, role

#### Topbar
- Height 60px, `background: var(--surface)`, `backdrop-filter: blur(14px)`, `border-bottom: 1px solid var(--border)`
- Trái: breadcrumb (text-muted, separator "·"), title `display`
- Phải: search input (40% max-width), bell icon, avatar 32px

#### Stat card
- `background: var(--surface)`, `border: 1px solid var(--border)`, `border-radius: 14px`, `padding: 18px`, `box-shadow: var(--shadow-card)`
- Layout: label (caption text-muted) → value (font 32/800 mono) → delta badge
- Delta badge: pill, `background: var(--success-soft)` cho up / `var(--danger-bg)` cho down, padding `2px 8px`, font 11/700

#### Chart card
- Title row: h3 + filter dropdown bên phải (7 ngày · 30 ngày)
- Body: 7 cột bars, mỗi cột stack theo account (5-6 accounts), gap 14px, max-height 220px
- Bar colors: dùng các tints của `--brand-gradient` (5 stops xanh→tím nhạt)
- X-axis labels: date format `MM-DD` mono caption, color `--text-dim`
- Legend dưới chart: dot + tên account, font caption

#### Top tài khoản / Top nhóm cards
- Card chuẩn (radius 14, padding 18, shadow-card)
- Header: h3 title + chevron filter
- List rows: avatar 32 + tên + meta (`X bài · Y thành công`) + progress bar mini
- Progress bar: 60×4px, `background: var(--brand-soft)`, fill `var(--brand-gradient)`, radius pill

---

### 2. Đăng bài (Chatbot)

**Purpose:** seller dùng chat-style để chọn profile và đăng bài lên nhiều kênh cùng lúc.

**Layout (1280×820):**
- App shell như Dashboard
- Content: `grid-template-columns: 1fr 280px`
  - **Left** — chat stream (flex-1)
  - **Right** — composer + scheduled queue panel (280px)

**Components:**

#### Chat stream
- Background `var(--surface-solid)`, `border-right: 1px solid var(--border)`
- Session banner trên cùng:
  - Padding 10px 28px, `border-bottom: 1px solid var(--border)`, `background: linear-gradient(90deg, var(--brand-soft), transparent)`
  - Dot 8px brand color + glow + text "Phiên làm việc với profile **trangthuynguyen** · 21:26 → now"
  - Right: link button "Lưu phiên" (text brand, no border)
- Day separator: text-dim caption "HÔM NAY · 24/04/2026" giữa, dạng pill trắng trên line ngang
- Bubble structure:
  - **Bot**: avatar 32px gradient `var(--brand-gradient)` chữ "X" → bubble background `var(--brand-soft)` border `var(--brand-border)` radius `3px 14px 14px 14px`, padding 12px 14px
  - **User**: bubble `background: var(--brand-gradient)` color #fff radius `14px 3px 14px 14px`, `box-shadow: var(--shadow-bubble)`, max-width 62%, align-right
  - Label trên bubble: name (caption brand cho bot, text cho user) + time (mono micro text-dim)
- Inline action chip: white bg, brand border, brand text — dùng cho "Chọn Profile", "Đăng ngay", v.v.

#### Composer (right panel)
- Background `var(--surface)`, `backdrop-filter: blur(14px)`, `border-left: 1px solid var(--border)`
- Top: scheduled posts list (Nhật ký lịch đăng)
  - Mỗi item: time (mono) + status dot + tên kênh + truncated content
- Bottom: textarea + attachment row (image/video icon) + "Đăng ngay" CTA gradient

---

### 3. Quản lý tài khoản — 3 tabs

**Purpose:** quản lý profile Chromium (Facebook), tài khoản Zalo, gán kênh per-profile, xem lịch sử thao tác.

**Tab pill row (chung cho cả 3 tabs):**
- Container: padding 4px, `background: var(--surface)`, `backdrop-filter: blur(14px)`, `border: 1px solid var(--border)`, `border-radius: 12px`, width fit-content
- Inactive tab: padding 8px 16px, radius 9px, color `--text-muted`, fontWeight 700
- Active tab: `background: var(--brand-gradient)`, color #fff, `box-shadow: var(--shadow-cta)`

#### Tab 1 · Tài khoản

Hai card chính:

**Card "FACEBOOK"**
- Header (padding 12 18, border-bottom): icon container 22×22 `background: var(--fb-tint)` + label "FACEBOOK" + count "· 4 profile"
- Rows: `grid-template-columns: auto 1fr auto`, padding 14 18
  - Avatar 38×38 radius 10, `background: var(--avatar-bg)`, initials font 12/800 color `--avatar-fg`
  - Info: tên (body bold), meta (mono caption text-dim) "userid · profile: chromium-name"
  - Actions: button "Sửa" (outline brand-soft + brand-deep text), "Login" (gradient + shadow-cta-sm), trash icon (red bg)
- Divider giữa rows: `1px solid var(--border-soft)`

**Card "ZALO"**
- Cùng pattern, header với tint `--zalo-tint`
- Avatar 38×38: `background: var(--zalo-tint)`, `border: 1px solid #cffafe`, Zalo icon stroke `--zalo-color`
- Rows: tên + meta "Key: xxx" mono

Buttons sizes: 6px 12px padding, radius 8px, font 11.5/700.

#### Tab 2 · Cài đặt kênh

Layout: `grid-template-columns: 260px 1fr` gap 14.

**Left panel** (Profile picker)
- Card padding 14px
- Title h3 "Profile"
- List items: padding 10 11, radius 9
- Active item: `background: var(--brand-soft)`, `border: 1px solid var(--brand-border)`, dot brand + text brand-deep
- Inactive: transparent, dot grey #d4d4d8
- Right side: count badge "3/3" mono caption

**Right panel** (Channels)
- Card padding 18, gap 14, flex column
- Header: icon brand + h3 "Linh Duong US"
- Sections (eyebrow header dạng "FACEBOOK · CÔNG TY"):
  - Eyebrow: 16×16 platform tint icon + uppercase label letter-spacing 0.06em
  - Items: padding 9 12, radius 9, gap 10 between
    - Active: `background: var(--brand-soft)`, `border: 1px solid var(--brand-border)`
    - Inactive: transparent + `border: 1px solid var(--border-soft)`
    - Checkbox 15×15 radius 4: ON = brand bg + check trắng, OFF = white bg + grey border
    - Text: name (body-sm 600) + id (mono micro text-dim)

#### Tab 3 · Lịch sử

Single card với header + timeline:
- Header: cal icon + h3 "Lịch sử thao tác" + meta count phải "6 sự kiện · hôm nay"
- Timeline body: padding 12 18, position relative
  - Vertical line absolute left 29, top 22, bottom 22, 1px wide, `var(--border-soft)`
  - Mỗi event row: gap 14, padding 10 0
    - Status dot 22×22: white bg, 2px border `--success` (ok) hoặc `--warning` (warn)
    - Time mono caption width 80
    - Avatar 24×24 radius 7, `--avatar-bg` + initials
    - Action text: bold profile name + " — " + text-muted action
    - Right (chỉ khi warn): button "Login lại" `border: 1px solid #f59e0b`, `background: #fffbeb`, color `#b45309`

---

## Interactions & Behavior

### Sidebar
- Click nav item → navigate (Vue Router / Next.js router)
- Active state: highlight current route
- Hover: `background: rgba(255,255,255,0.4)`, transition `background 150ms ease`
- "Soon" badge trên Spy bài viết: disabled, không click được

### Tabs (Accounts)
- Click tab → swap content, KHÔNG full reload
- Pill animation: `transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1)` cho background-color, color
- URL nên có query param `?tab=accounts|channels|history` để link sâu được

### Chatbot
- "Chọn Profile" chip → mở modal/dropdown chọn profile
- "Đăng ngay" → submit + thêm bubble user "Đã đăng" + bot reply confirm
- Auto-scroll xuống cuối khi có message mới (smooth)
- Composer textarea: auto-grow theo nội dung, max 6 lines rồi scroll
- Enter = gửi, Shift+Enter = newline

### Account list
- "Sửa" → mở drawer/modal edit profile
- "Login" → trigger Chromium spawn flow (dùng API hiện có)
- Trash → confirm dialog đỏ "Xoá profile này?"
- Empty state nếu không có profile: illustration + "Thêm profile đầu tiên" CTA

### Channels tab
- Click profile bên trái → load channels của profile đó vào panel phải
- Click checkbox channel → toggle on/off, optimistic update, có spinner nhỏ khi đang save
- Search input: filter channels theo tên realtime

### History tab
- Click "Login lại" trên warn event → trigger relogin flow của profile đó
- Filter (sẽ thêm sau): theo profile, theo status, theo ngày

### Hover states (toàn app)
- Buttons gradient (CTA): tăng `box-shadow` từ `--shadow-cta-sm` → `--shadow-cta`, transform translateY(-1px), 150ms ease
- Buttons outline: `background: var(--brand-soft)` đậm hơn ~5%
- Card rows: `background: rgba(255,255,255,0.4)` overlay khi hover
- Icons trash: scale 1.05 + color đậm hơn

### Loading / Empty / Error states
- Loading: skeleton placeholder dùng `linear-gradient(90deg, var(--surface-soft), rgba(255,255,255,0.9), var(--surface-soft))` shimmer 1.5s loop
- Empty: centered illustration + heading + caption + CTA
- Error: dùng warning/danger token, banner top với icon + message + retry button

### Responsive (≥1280px primary, optional ≥768px)
- Desktop chính (≥1280): như mock
- Tablet (768-1279): sidebar collapse thành 64px (icon-only), content giữ nguyên
- Mobile: ngoài scope handoff này, sẽ làm sau

---

## State Management

Gợi ý state shape (TypeScript):

```typescript
type Profile = {
  id: string;
  platform: 'facebook' | 'zalo';
  name: string;
  username: string;
  chromiumProfile: string;  // chỉ FB
  zaloKey?: string;          // chỉ Zalo
  online: boolean;
  loginExpiresAt?: string;
};

type Channel = {
  id: string;
  type: 'facebook-group' | 'zalo-group';
  name: string;
  externalId: string;       // Facebook group ID hoặc Zalo group key
  category?: string;
};

type ChannelAssignment = {
  profileId: string;
  channelId: string;
  enabled: boolean;
};

type ScheduledPost = {
  id: string;
  profileId: string;
  channelIds: string[];
  content: string;
  attachments: { type: 'image' | 'video'; url: string }[];
  scheduledAt: string;
  status: 'pending' | 'posted' | 'failed';
  errorMessage?: string;
};

type HistoryEvent = {
  id: string;
  timestamp: string;
  profileId: string;
  action: string;
  status: 'ok' | 'warn' | 'error';
};
```

API endpoints cần (giả định REST):
- `GET /profiles` · `POST /profiles` · `PATCH /profiles/:id` · `DELETE /profiles/:id`
- `POST /profiles/:id/login` — trigger Chromium login
- `GET /channels` · `POST /channels`
- `GET /assignments?profile_id=...` · `PUT /assignments`
- `GET /posts?status=pending` · `POST /posts` · `POST /posts/:id/cancel`
- `GET /history?limit=50&date=...`

Real-time: WebSocket cho post status updates (`post.status_changed`), session events.

---

## Assets

- **Fonts**: Plus Jakarta Sans (Google Fonts) + JetBrains Mono (Google Fonts) — load qua `<link>` hoặc bundle local
- **Icons**: Bộ icon stroke 1.6px tự vẽ trong `shared.jsx` (24×24 viewBox). Dev có thể dùng **Lucide React** thay — đã match style, chỉ cần set `strokeWidth={1.6}`. Mapping:
  - `IconDash` → `LayoutDashboard`
  - `IconPost` → `Pencil`
  - `IconUsers` → `Users`
  - `IconSpy` → `Search`
  - `IconSettings` → `Settings`
  - `IconBell` → `Bell`
  - `IconCal` → `Calendar`
  - `IconTrash` → `Trash2`
  - `IconCheck` → `Check`
  - `IconChevron` → `ChevronDown`
  - `IconPlus` → `Plus`
  - `IconFB` → dùng SVG riêng (filled), Lucide không có
  - `IconZalo` → custom SVG, Lucide không có
- **Logo Xeko**: text-only ở mock — nếu có logo thật thay vào sidebar header
- **Avatars**: hiện dùng initials trên gradient — production nên fallback sang ảnh thật từ FB/Zalo profile

---

## Files trong handoff bundle

```
design_handoff_xeko_sky/
├── README.md                        ← bạn đang đọc
└── source/
    ├── Xeko Redesign.html           ← root file, mở trên browser để xem live
    ├── design-canvas.jsx            ← canvas wrapper (DCArtboard, DCSection)
    ├── shared.jsx                   ← Icons + mock data dùng chung
    ├── variant-gradient.jsx         ← Sky theme tokens + GrSidebar / GrTopbar / GrDashboard / GrChatbot
    └── variant-sky-final.jsx        ← SkyAccounts (3 tabs)
```

**Cách xem live:** mở `source/Xeko Redesign.html` trên browser. Section "✦ FINAL · Sky Gradient" trên cùng là phương án chốt. Các sections bên dưới là variants cũ để tham khảo (không build).

**Map screen → component nguồn:**

| Screen | Component | File | Line tham khảo |
|---|---|---|---|
| Dashboard | `GrDashboard` | `variant-gradient.jsx` | tìm `const GrDashboard` |
| Chatbot | `GrChatbot` | `variant-gradient.jsx` | tìm `const GrChatbot` |
| Accounts (3 tabs) | `SkyAccounts` | `variant-sky-final.jsx` | top of file, prop `tab` |
| Sidebar | `GrSidebar` | `variant-gradient.jsx` | tìm `const GrSidebar` |
| Topbar | `GrTopbar` | `variant-gradient.jsx` | tìm `const GrTopbar` |

Theme object đầy đủ ở `variant-gradient.jsx` → `GRADIENT_THEMES.sky`.

---

## Build checklist cho dev

- [ ] Setup project: React + TypeScript + chosen styling (CSS vars / Tailwind / styled)
- [ ] Import fonts (Plus Jakarta Sans, JetBrains Mono)
- [ ] Define design tokens trong `tokens.css` hoặc `tailwind.config.ts`
- [ ] Build atoms: Button (primary gradient / outline / ghost / icon), Input, Checkbox, Badge, Avatar
- [ ] Build layout: AppShell với Sidebar + Topbar
- [ ] Build Dashboard với 4 stats + chart + 2 lists
- [ ] Build Chatbot: bubble component (bot/user variants), session banner, composer
- [ ] Build Accounts: tab system, 2 list cards (FB + Zalo), per-profile channel matrix, history timeline
- [ ] Wire state management (React Query / Zustand / context của codebase)
- [ ] Hover/focus/disabled states cho mọi interactive element
- [ ] Loading & empty states
- [ ] Error handling cho login failures
- [ ] Real-time post status updates (WS)
- [ ] Responsive breakpoint ≥1280 → tablet collapse sidebar

## Câu hỏi mở (cần PM xác nhận)

1. Mobile layout — có cần làm trong scope này không?
2. Dark mode — bản này light-only, có cần dark mode parallel?
3. "Spy bài viết" — chưa làm, khi nào ship?
4. Multi-language — chỉ tiếng Việt hay có English?
5. Brand asset (logo Xeko) — dùng text wordmark hay có file logo?
