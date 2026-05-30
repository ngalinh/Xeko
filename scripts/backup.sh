#!/bin/bash
# Backup posts.db và uploads/ sang Windows VPS hàng ngày

set -euo pipefail

DATA_DIR="${XEKO_DATA_DIR:-/home/vmadmin/xeko/server}"
WIN_HOST="Administrator@180.93.36.109"
WIN_DEST="C:/Xeko/backup"
SSH_KEY="/home/vmadmin/.ssh/xeko_backup_win"
DATE=$(date +%Y-%m-%d)
LOG="/var/log/xeko-backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Bắt đầu backup $DATE ==="

# Checkpoint WAL trước khi copy DB
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DATA_DIR/data/posts.db" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
fi

# Copy DB với tên theo ngày
TMP_DB="/tmp/posts-$DATE.db"
cp "$DATA_DIR/data/posts.db" "$TMP_DB"

# Upload DB
log "Uploading posts.db..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$TMP_DB" "$WIN_HOST:$WIN_DEST/posts-$DATE.db"
rm -f "$TMP_DB"
log "DB uploaded."

# Sync thư mục uploads (chỉ copy file mới, không xóa file cũ)
log "Syncing uploads/..."
rsync -az --no-perms \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$DATA_DIR/data/uploads/" \
  "$WIN_HOST:$WIN_DEST/uploads/"
log "Uploads synced."

log "=== Backup hoàn thành ==="
