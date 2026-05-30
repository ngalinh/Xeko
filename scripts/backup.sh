#!/bin/bash
# Backup Xeko posts.db và uploads/ sang Windows VPS hàng ngày

set -euo pipefail

BOT_DIR="/opt/dashboard-bot/data/bots/9a031e766d216717"
DB="$BOT_DIR/server/data/posts.db"
UPLOADS="$BOT_DIR/data/uploads"

WIN_HOST="Administrator@180.93.36.109"
WIN_DEST="C:/Xeko/backup"
SSH_KEY="/home/vmadmin/.ssh/xeko_backup_win"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

DATE=$(date +%Y-%m-%d)
LOG="/var/log/xeko-backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Bắt đầu backup $DATE ==="

# Checkpoint WAL
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

# Backup DB
TMP="/tmp/xeko-posts-$DATE.db"
cp "$DB" "$TMP"
log "Uploading posts.db..."
scp $SSH_OPTS "$TMP" "$WIN_HOST:$WIN_DEST/posts-$DATE.db"
rm -f "$TMP"
log "DB uploaded."

# Sync uploads (chỉ copy file mới)
log "Syncing uploads/..."
rsync -az --no-perms -e "ssh $SSH_OPTS" \
  "$UPLOADS/" "$WIN_HOST:$WIN_DEST/uploads/"
log "Uploads synced."

log "=== Backup hoàn thành ==="
