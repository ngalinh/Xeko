# Xeko offline: xử lý mà không mất dữ liệu

Cập nhật 06/10/2026. Thông tin triển khai dưới đây đã được đối chiếu với kết quả SSH trong lần khôi phục thành công ngày này. Nếu chuyển máy hoặc đổi bot, phải xác minh lại ID, container và đường dẫn trước khi dùng.

## Quy tắc nhanh

**Offline → xem trạng thái/log → restart đúng bot. Trước khi sửa hoặc deploy → backup database.**
Không clone/tạo bot mới chỉ vì offline; không xóa bot cũ hoặc thư mục dữ liệu.
Chưa xác định nguyên nhân sự cố trước đó; không kết luận clone đã xóa dữ liệu.

## Vị trí cần nhớ

| Thành phần | Giá trị |
|---|---|
| Máy chứa database | VPS Linux REMOTE |
| Container quản lý | `dashboard-bot-platform-1` |
| Tên PM2 trong container | `bot-9a031e766d216717` |
| Database trên host Linux | `/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db` |
| Thư mục nhận backup từ WinSCP | `/home/vmadmin/xeko-restore-input/` |
| Tên bản chuẩn bị restore | `posts-backup.db` |
| Backup thủ công trên Linux | `/home/vmadmin/xeko-backups/` |
| Backup tuần trên Windows theo cấu hình hiện có | `C:\xeko\backups` |

Database tên **posts.db** (có chữ s). Kho content hiện tại đọc lịch sử từ **post_logs**.
Database còn chứa lịch hẹn, seeding, settings và contents; thay toàn bộ file sẽ thay cả các dữ liệu này.
Ảnh được tham chiếu qua đường dẫn/URL: restore DB không khôi phục ảnh đã mất ở kho ảnh.

Tất cả lệnh bash dưới đây chạy trong **SSH trên VPS Linux**, không chạy trực tiếp trong PowerShell Windows.

## 1. Khi Xeko offline

Xem trạng thái và ghi lại log trước khi restart:

```bash
sudo docker exec dashboard-bot-platform-1 pm2 list
sudo docker exec dashboard-bot-platform-1 pm2 logs bot-9a031e766d216717 --lines 100 --nostream
```

Nếu cần khởi động lại đúng bot:

```bash
sudo docker exec dashboard-bot-platform-1 pm2 restart bot-9a031e766d216717
```

Restart không thay database. Nếu vẫn lỗi hoặc số lần restart tăng liên tục, dùng log để tìm nguyên nhân, không clone lại.
Không dùng `pm2 restart all` hoặc dừng cả container để xử lý riêng Xeko: container có nhiều bot khác.

Nếu container không chạy:

```bash
sudo docker ps -a --filter name=dashboard-bot-platform-1
sudo docker logs --tail 100 dashboard-bot-platform-1
```

Lúc này cần kiểm tra nền tảng Dashboard Bot. Nếu web mở được nhưng báo LOCAL offline, kiểm tra runner Windows và kết nối LOCAL–REMOTE; restore database không sửa được lỗi kết nối đó.

## 2. Backup trước khi sửa, cập nhật hoặc triển khai lại

Snapshot SQLite dưới đây dùng được khi ứng dụng đang chạy. Không chỉ copy file posts.db đang hoạt động vì dữ liệu có thể còn trong WAL.

```bash
(
set -eu
DB="/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db"
DIR="/home/vmadmin/xeko-backups"
mkdir -p "$DIR"
FILE="$(mktemp "$DIR/posts-before-change-$(date +%Y%m%d-%H%M%S)-XXXXXX.db")"
sudo test -f "$DB"
sudo sqlite3 "$DB" ".backup '$FILE'"
sudo chown vmadmin:"$(id -gn vmadmin)" "$FILE"
chmod 600 "$FILE"
test "$(sqlite3 -readonly "$FILE" 'PRAGMA integrity_check;')" = "ok"
sqlite3 -readonly "$FILE" "SELECT COUNT(*) FROM post_logs;"
echo "BACKUP OK: $FILE"
)
```

Chỉ coi backup thành công khi có `BACKUP OK`, và số dòng hợp lý.
Tải file về máy khác bằng WinSCP; bản sao cùng VPS không bảo vệ khi VPS hỏng.

## 3. Khôi phục toàn bộ database

Chỉ làm khi thực sự cần quay về bản backup. Dữ liệu mới hơn backup sẽ không có trong DB khôi phục; các lịch hẹn cũ cũng quay lại.

### Chuẩn bị và kiểm tra

Giải nén ZIP rồi GZ trên Windows nếu cần. Upload database vào:
`/home/vmadmin/xeko-restore-input/posts-backup.db`.
Upload vào thư mục này chưa ảnh hưởng DB đang chạy.

```bash
sqlite3 -readonly /home/vmadmin/xeko-restore-input/posts-backup.db "PRAGMA integrity_check;"
sqlite3 -readonly /home/vmadmin/xeko-restore-input/posts-backup.db "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM post_logs;"
```

Phải có `ok`, số dòng và khoảng thời gian phù hợp. Dừng nếu có lỗi hoặc backup không chứa dữ liệu cần lấy.
Lần khôi phục 06/10/2026 có 5.390 dòng, mới nhất 03/10/2026 lúc 22:07 giờ Việt Nam; đây là số liệu của bản đó, không phải điều kiện cho backup về sau.

### Dừng riêng bot

```bash
sudo docker exec dashboard-bot-platform-1 pm2 stop bot-9a031e766d216717
sudo lsof /opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db
```

PM2 phải hiện `stopped`, lsof không hiện tiến trình mở file. Không tiếp tục nếu bot tự chạy lại.

### Sao lưu hiện trạng và thay file

```bash
sudo bash <<'RESTORE'
set -euo pipefail
DB="/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db"
BACKUP="/home/vmadmin/xeko-restore-input/posts-backup.db"
command -v lsof >/dev/null
command -v sqlite3 >/dev/null
test -f "$DB"
test -f "$BACKUP"

if lsof "$DB" "${DB}-wal" "${DB}-shm" 2>/dev/null; then
  echo "DUNG: Database van dang duoc su dung."
  exit 1
fi

test "$(sqlite3 -readonly "$BACKUP" 'PRAGMA integrity_check;')" = "ok"
EXPECTED="$(sqlite3 -readonly "$BACKUP" 'SELECT COUNT(*) FROM post_logs;')"
test "$EXPECTED" -gt 0

SAVE="$(mktemp -d /home/vmadmin/xeko-before-restore-$(date +%Y%m%d-%H%M%S)-XXXXXX)"
cp -p "$DB" "$SAVE/posts.db"
for suffix in -wal -shm; do
  if [ -f "${DB}${suffix}" ]; then
    cp -p "${DB}${suffix}" "$SAVE/posts.db${suffix}"
  fi
done
echo "Ban truoc restore: $SAVE"

NEW="$(mktemp "$(dirname "$DB")/posts-restore-XXXXXX")"
cp "$BACKUP" "$NEW"
chown --reference="$DB" "$NEW"
chmod --reference="$DB" "$NEW"

for suffix in -wal -shm; do
  if [ -f "${DB}${suffix}" ]; then
    mv "${DB}${suffix}" "$SAVE/original-posts.db${suffix}"
  fi
done
mv -f "$NEW" "$DB"
test "$(sqlite3 -readonly "$DB" 'PRAGMA integrity_check;')" = "ok"
test "$(sqlite3 -readonly "$DB" 'SELECT COUNT(*) FROM post_logs;')" = "$EXPECTED"
echo "RESTORE THANH CONG: $EXPECTED dong"
RESTORE
```

Nếu lỗi hoặc không có thông báo thành công, giữ bot dừng, lưu kết quả và kiểm tra trước khi tiếp tục.
Giữ thư mục `xeko-before-restore-...`: chứa file cũ cùng WAL/SHM nếu có, không xóa chúng riêng lẻ.

### Chạy lại và kiểm tra

Chỉ chạy sau khi restore thành công:

```bash
sudo docker exec dashboard-bot-platform-1 pm2 start bot-9a031e766d216717
sudo docker exec dashboard-bot-platform-1 pm2 logs bot-9a031e766d216717 --lines 30 --nostream
```

Vào Kho content, bỏ bộ lọc và nhấn Ctrl+F5. Kiểm tra lịch hẹn ngay để hủy lịch cũ không còn cần chạy.
Sau khi xong có thể đóng WinSCP và SSH; PM2 vẫn chạy bot trên VPS.

## 4. Tránh lặp lại sự cố dữ liệu

- Giữ bot ID và thư mục dữ liệu khi cập nhật mã nguồn.
- Tạo bot mới có thể dùng database trống ở ID khác. Giao diện trống chưa chứng minh DB cũ đã bị xóa.
- File posts.db nhỏ (ví dụ 4 KB) chưa chứng minh dữ liệu mất: kiểm tra cả WAL bằng SQLite.
- Nên backup hằng ngày, giữ nhiều phiên bản, sao chép sang máy khác/cloud và định kỳ thử restore.
- Có thể dùng XEKO_DATA_DIR để tách dữ liệu khỏi checkout; trong Docker phải cấu hình volume bền vững và đường dẫn bên trong container đúng. Cần chuyển dữ liệu có kế hoạch, không chỉ đổi biến rồi restart.
- Tài liệu này **không tạo lịch backup mới, không đổi XEKO_DATA_DIR và không thay cấu hình VPS**.

Xem thêm [hướng dẫn backup đầy đủ](HUONG-DAN-BACKUP.md) và [script backup Windows](../scripts/BACKUP.md).
