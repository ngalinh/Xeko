#!/bin/bash
# Backup posts.db và uploads/ sang Windows VPS hàng ngày

set -euo pipefail

WIN_HOST="Administrator@180.93.36.109"
WIN_DEST="C:/Xeko/backup"
SSH_KEY="/home/vmadmin/.ssh/xeko_backup_win"
DATE=$(date +%Y-%m-%d)
LOG="/var/log/xeko-backup.log"

# Danh sách các bot cần backup: "tên|đường_dẫn_data_dir"
BOTS=(
  "dashboard-bot-9a031e|/opt/dashboard-bot/data/bots/9a031e766d216717"
  "platform-ai-9cdc3e|/opt/platform-ai/data/bots/9cdc3e8d6a564b5e"
)

# Uploads không gắn với bot cụ thể
EXTRA_UPLOADS=(
  "dashboard-bot-e5f532|/opt/dashboard-bot/data/bots/e5f5323bdc7532ac/uploads"
)

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Bắt đầu backup $DATE ==="

for entry in "${BOTS[@]}"; do
  NAME="${entry%%|*}"
  DIR="${entry##*|}"
  DB="$DIR/server/data/posts.db"

  if [[ ! -f "$DB" ]]; then
    log "WARN: Không tìm thấy $DB, bỏ qua."
    continue
  fi

  # Checkpoint WAL
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

  # Copy DB
  TMP="/tmp/$NAME-$DATE.db"
  cp "$DB" "$TMP"
  log "Uploading $NAME/posts.db..."
  scp $SSH_OPTS "$TMP" "$WIN_HOST:$WIN_DEST/$NAME-posts-$DATE.db"
  rm -f "$TMP"

  # Sync uploads
  UPLOADS="$DIR/data/uploads"
  if [[ -d "$UPLOADS" ]]; then
    log "Syncing $NAME/uploads/..."
    rsync -az --no-perms -e "ssh $SSH_OPTS" \
      "$UPLOADS/" "$WIN_HOST:$WIN_DEST/$NAME-uploads/"
  fi
done

# Sync uploads phụ
for entry in "${EXTRA_UPLOADS[@]}"; do
  NAME="${entry%%|*}"
  DIR="${entry##*|}"
  if [[ -d "$DIR" ]]; then
    log "Syncing $NAME/uploads/..."
    rsync -az --no-perms -e "ssh $SSH_OPTS" \
      "$DIR/" "$WIN_HOST:$WIN_DEST/$NAME-uploads/"
  fi
done

log "=== Backup hoàn thành ==="
