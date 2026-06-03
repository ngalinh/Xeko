# HƯỚNG DẪN BACKUP XEKO — TÀI LIỆU ĐẦY ĐỦ

> File này mô tả toàn bộ dữ liệu của Xeko, cách backup tự động, cách khôi phục, và cách
> xử lý sự cố. Lưu file này **cùng thư mục** với các bản backup trên Google Drive
> (`XekoBackups`) để sau này bất kỳ ai cũng đọc và làm lại được.
>
> Cập nhật lần cuối: 2026-06-03

---

## 0. TÓM TẮT NHANH (TL;DR)

- **Backup tự động:** mỗi **Chủ nhật 02:00 sáng**, VPS Windows tự gom toàn bộ dữ liệu Xeko
  → nén → upload lên Google Drive thư mục `XekoBackups`.
- **Mỗi bản:** 1 file `xeko-backup-YYYY-MM-DD_HHMM.zip` (~1GB), chứa ĐẦY ĐỦ mọi thứ cần để khôi phục.
- **Giữ lại:** 8 tuần gần nhất (bản cũ hơn tự xoá).
- **Khi cần khôi phục:** xem Mục 5.

---

## 1. KIẾN TRÚC HỆ THỐNG

Xeko chạy trên 2 máy:

| Máy | Vai trò | Thông tin |
|---|---|---|
| **LOCAL** | Chạy `local-server.js` + trình duyệt Playwright (đăng bài thật) | VPS Windows, thư mục `C:\xeko` |
| **REMOTE** | Chạy `index.js` (dashboard, API, lưu lịch sử) | VPS Linux, IP `103.140.249.232` |

---

## 2. TOÀN BỘ DỮ LIỆU & VỊ TRÍ

### 2.1. Trên máy LOCAL (Windows — `C:\xeko\server\`)
| Đường dẫn | Nội dung |
|---|---|
| `config\profiles-meta.json` | Tài khoản + mật khẩu + device fingerprint + proxy (bản gốc) |
| `config\channels.json` | FB groups/pages, Zalo groups + mapping profile nào đăng kênh nào |
| `config\proxies.json` | Danh sách proxy + credentials |
| `config\user-permissions.json` | Phân quyền user (ai được login, dùng profile nào) |
| `config\zalo-accounts.json` | Tài khoản Zalo |
| `.env` | Secrets: `LOCAL_API_KEY`, cấu hình LOCAL |
| `playwright-data\` | **Session login FB/Zalo (cookies)** — CHỈ tồn tại ở đây, mất là phải login lại toàn bộ |

### 2.2. Trên server REMOTE (Linux)
| Đường dẫn | Nội dung |
|---|---|
| `/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db` | **Lịch sử đăng bài + lịch hẹn + seeding + settings + content** — CHỈ tồn tại ở đây |
| `.env` | Secrets: `GEMINI_API_KEY`, `IMAGE_SERVER_*`... |
| bản sao `config/` | channels/proxies/permissions (tự sync từ LOCAL) |

---

## 3. CÁC LỚP BẢO VỆ

### Lớp A — Sync sẵn có giữa LOCAL ↔ REMOTE
Một số dữ liệu luôn tồn tại 2 bản nhờ cơ chế sync tự động khi LOCAL kết nối REMOTE:
`user-permissions.json`, `channels.json`, `proxies.json`.

### Lớp B — Backup hằng tuần lên Google Drive (lớp chính)
Gom TẤT CẢ vào 1 gói `.zip` rồi upload Drive. Đây là lớp đầy đủ nhất.

**Nội dung mỗi gói `xeko-backup-*.zip`:**
| Thành phần | Lấy từ | Cách lấy |
|---|---|---|
| `config/` | LOCAL | copy trực tiếp |
| `.env` | LOCAL | copy trực tiếp |
| `playwright-data/` | LOCAL | copy (robocopy) |
| `posts.db.gz` | REMOTE | qua SSH: `sqlite3 '<db>' '.backup ...'` → snapshot an toàn → `scp` về |

---

## 4. CẤU HÌNH HỆ THỐNG BACKUP

| Thông số | Giá trị |
|---|---|
| Script | `C:\xeko\scripts\backup-to-gdrive.ps1` |
| Chạy trên | VPS Windows LOCAL |
| Lịch chạy | Task Scheduler "Xeko Weekly Backup" — Chủ nhật 02:00 |
| Công cụ upload | `rclone` (remote tên `drive`) |
| Thư mục đích | `drive:XekoBackups` trên Google Drive công ty |
| Giữ lại | 8 tuần (`$KeepWeeks = 8`), bản cũ tự xoá |
| Key SSH lấy posts.db | `C:\Users\Administrator\.ssh\xeko_backup` |
| Token Drive | `C:\Users\Administrator\AppData\Roaming\rclone\rclone.conf` |

**Các lệnh kiểm tra / vận hành (PowerShell trên VPS Windows):**
```powershell
# Chạy backup ngay (thủ công)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\xeko\scripts\backup-to-gdrive.ps1

# Xem các bản backup trên Drive
rclone ls drive:XekoBackups

# Xem / chạy thử / xoá lịch tự động
schtasks /Query  /TN "Xeko Weekly Backup"
schtasks /Run    /TN "Xeko Weekly Backup"
schtasks /Delete /TN "Xeko Weekly Backup" /F
```

---

## 5. KHÔI PHỤC DỮ LIỆU (RESTORE)

### Bước 1 — Tải bản backup
Trên máy Windows:
```powershell
# Xem danh sách, chọn bản mới nhất
rclone ls drive:XekoBackups
# Tải về (thay tên file)
rclone copy "drive:XekoBackups/xeko-backup-YYYY-MM-DD_HHMM.zip" C:\restore\ --progress
```
Giải nén file `.zip` → có các thư mục `config\`, `playwright-data\`, file `.env`, `posts.db.gz`.

### Bước 2 — Khôi phục phần LOCAL (máy Windows)
Copy đè vào `C:\xeko\server\`:
- `config\*`  → `C:\xeko\server\config\`
- `.env`      → `C:\xeko\server\.env`
- `playwright-data\*` → `C:\xeko\server\playwright-data\`

(Nên dừng `local-server` trước khi copy đè, rồi khởi động lại.)

### Bước 3 — Khôi phục `posts.db` (server REMOTE Linux)
```bash
# Giải nén
gunzip posts.db.gz        # ra file posts.db

# DỪNG server REMOTE trước, rồi:
DB="/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db"
cp posts.db "$DB"
rm -f "$DB-wal" "$DB-shm"  # xoá WAL/SHM cũ để tránh xung đột

# Khởi động lại server REMOTE
```

---

## 6. CÀI LẠI TỪ ĐẦU (nếu mất VPS / dựng máy mới)

### 6.1. Cài rclone + kết nối Google Drive (trên VPS Windows mới)
```powershell
# Tải rclone
New-Item -ItemType Directory -Force -Path C:\rclone | Out-Null
Invoke-WebRequest -Uri "https://downloads.rclone.org/rclone-current-windows-amd64.zip" -OutFile "$env:TEMP\rclone.zip"
Expand-Archive "$env:TEMP\rclone.zip" -DestinationPath "$env:TEMP\rclone-extract" -Force
Copy-Item "$env:TEMP\rclone-extract\*\rclone.exe" "C:\rclone\rclone.exe" -Force
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\rclone", "Machine")
```
Mở PowerShell mới → `rclone config`:
- `n` (new) → name **`drive`** → storage **`drive`** → client_id/secret để trống
- scope **`3`** → service_account để trống → advanced **`n`** → auto config **`y`**
- (trình duyệt) đăng nhập email công ty (basso.vn) → Allow
- Shared Drive: `n` (Drive cá nhân) hoặc `y` (ổ chung) → `y` lưu → `q` thoát

Kiểm tra: `rclone lsd drive:`

### 6.2. Khôi phục SSH key (để lấy posts.db)
Đặt lại file key `xeko_backup` vào `C:\Users\Administrator\.ssh\xeko_backup`
(và đảm bảo public key đã nằm trong `~/.ssh/authorized_keys` của user `vmadmin` trên REMOTE).
Test: `ssh -i $env:USERPROFILE\.ssh\xeko_backup vmadmin@103.140.249.232 "echo ok"`

### 6.3. Lấy lại script + tạo lịch
```powershell
cd C:\xeko
git pull origin main        # script nằm ở scripts\backup-to-gdrive.ps1
# Mở script kiểm tra khối CẤU HÌNH cho đúng đường dẫn/IP

# Tạo lịch (PowerShell quyền Administrator)
schtasks /Create /TN "Xeko Weekly Backup" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\xeko\scripts\backup-to-gdrive.ps1" /SC WEEKLY /D SUN /ST 02:00 /RL HIGHEST /F
```

---

## 7. XỬ LÝ SỰ CỐ

| Triệu chứng | Nguyên nhân & cách sửa |
|---|---|
| `[3/5]` báo lỗi SSH | Key sai/đổi → kiểm tra `ssh -i ...\xeko_backup vmadmin@103.140.249.232 "echo ok"`. Hoặc IP/đường dẫn DB đổi → sửa trong script. |
| rclone báo lỗi auth | Token hỏng (đổi mật khẩu Google / bị thu hồi quyền) → chạy lại `rclone config` reconnect remote `drive`. |
| `playwright-data` thiếu file | Trình duyệt đang mở khoá file → chạy backup khi đã đóng trình duyệt (lịch chạy ban đêm). |
| Backup không tạo bản mới hằng tuần | Kiểm tra `schtasks /Query /TN "Xeko Weekly Backup"`; chạy thử `schtasks /Run ...`. |

---

## 8. GIỮ GÌN — ĐỪNG LÀM HỎNG BACKUP
- **Giữ** file `rclone.conf` (`C:\Users\Administrator\AppData\Roaming\rclone\`) — chứa token Drive.
- **Giữ** SSH key `C:\Users\Administrator\.ssh\xeko_backup`.
- **Đừng** thu hồi quyền rclone trong Tài khoản Google → Bảo mật → Ứng dụng bên thứ ba.
- Đổi mật khẩu Google → có thể phải `rclone config` reconnect lại.
- Log out Google khỏi Chrome **không ảnh hưởng** backup (rclone dùng token riêng).

---

*Hết. File này nên được lưu cùng thư mục `XekoBackups` trên Google Drive.*
