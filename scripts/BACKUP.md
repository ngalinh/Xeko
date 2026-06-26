# Backup Xeko lên Google Drive công ty

Backup hằng tuần toàn bộ dữ liệu quan trọng của Xeko lên Google Drive, chạy trên
**máy/VPS Windows LOCAL** (nơi chạy `local-server.js` + trình duyệt Playwright).

## Dữ liệu được backup

Script chạy ở LOCAL gom đủ dữ liệu từ cả hai máy:

| Dữ liệu | Nằm ở | Cách gom |
|---|---|---|
| `config/` (profiles-meta, channels, proxies, permissions, zalo-accounts) | LOCAL (bản gốc) | copy trực tiếp |
| `.env` (secrets) | LOCAL | copy trực tiếp |
| `playwright-data/` (session FB/Zalo) | **chỉ LOCAL** | copy trực tiếp (robocopy) |
| `posts.db` (lịch sử đăng, lịch hẹn, seeding, settings, content) | **chỉ REMOTE (Linux)** | qua SSH: `sqlite3 .backup` rồi `scp` về |

`posts.db` lấy bằng SSH (dùng key `~/.ssh/xeko_backup`) + `sqlite3 '<db>' '.backup ...'`
→ snapshot nhất quán kể cả khi server REMOTE đang ghi, **không cần dừng server và không cần
deploy thêm code**.

---

## Yêu cầu (đã có sẵn trong môi trường hiện tại)

- **rclone** đã cài trên máy Windows, đã cấu hình remote Google Drive tên `drive`
  (kiểm tra: `rclone listremotes` → thấy `drive:`).
- **SSH key** `%USERPROFILE%\.ssh\xeko_backup` truy cập được server REMOTE Linux
  (kiểm tra: `ssh -i $env:USERPROFILE\.ssh\xeko_backup <SSH_USER>@<REMOTE_VPS_IP> "echo ok"`).
- Server REMOTE có sẵn `sqlite3`.

> Nếu cài lại rclone từ đầu: tải tại https://rclone.org/downloads/ (Windows amd64),
> đặt `rclone.exe` vào `C:\rclone\`, thêm `C:\rclone` vào PATH, rồi chạy `rclone config`
> (new remote → tên `drive` → storage `drive` → scope `3` → auto config `y` → đăng nhập
> email công ty → `q`).

---

## Cấu hình script

Mở `scripts\backup-to-gdrive.ps1`, kiểm tra khối CẤU HÌNH (đã điền sẵn theo môi trường hiện tại):

```powershell
$XekoServerDir   = "C:\xeko\server"
$IncludeSessions = $true

$SshKey    = "$env:USERPROFILE\.ssh\xeko_backup"
$RemoteSsh = "<SSH_USER>@<REMOTE_VPS_IP>"
$RemoteDb  = "/opt/dashboard-bot/data/bots/<BOT_ID>/server/data/posts.db"

$RcloneRemote = "drive"
$DriveFolder  = "XekoBackups"
$KeepWeeks    = 8
```

Đổi các giá trị nếu đường dẫn / IP / tên remote thay đổi.

---

## Chạy thử

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\xeko\scripts\backup-to-gdrive.ps1
```
Theo dõi log `[1/5]...[5/5]`. Kiểm tra trên Drive:
```
rclone ls drive:XekoBackups
```
→ thấy `xeko-backup-YYYY-MM-DD_HHMM.zip` là OK (file zip này chứa cả `posts.db.gz` bên trong).

---

## Lên lịch hằng tuần (Task Scheduler)

PowerShell **với quyền Administrator**:
```
schtasks /Create /TN "Xeko Weekly Backup" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\xeko\scripts\backup-to-gdrive.ps1" /SC WEEKLY /D SUN /ST 02:00 /RL HIGHEST /F
```
→ Chạy mỗi **Chủ nhật 02:00**. Đổi `/D` (thứ) và `/ST` (giờ) tuỳ ý.

Kiểm tra / chạy ngay / xoá:
```
schtasks /Query  /TN "Xeko Weekly Backup"
schtasks /Run    /TN "Xeko Weekly Backup"
schtasks /Delete /TN "Xeko Weekly Backup" /F
```

> Task Scheduler chạy không tương tác, nên key SSH `xeko_backup` không được đặt passphrase
> (key hiện tại không có passphrase → OK). `StrictHostKeyChecking=accept-new` đã bật để
> không bị hỏi xác nhận host lần đầu.

---

## Khôi phục (restore)
1. Tải file `.zip` mới nhất từ Drive, giải nén.
2. `config/`, `.env`, `playwright-data/` → copy đè vào thư mục `server` trên máy LOCAL.
3. `posts.db.gz` → giải nén thành `posts.db`, đặt vào đúng đường dẫn trên REMOTE
   (`/opt/dashboard-bot/data/bots/<id>/server/data/posts.db`) **khi server REMOTE đang tắt**,
   rồi khởi động lại. Xoá `posts.db-wal` / `posts.db-shm` cũ nếu có để tránh xung đột.

## Lưu ý
- Session (`playwright-data`) có thể bị lỗi file đang khoá nếu trình duyệt đang mở →
  lên lịch chạy ban đêm.
- Backup thủ công 1 lần (không cần lên lịch): chạy thẳng script như mục "Chạy thử".
