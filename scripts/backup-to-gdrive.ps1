<#
  Xeko - Backup hằng tuần lên Google Drive (qua rclone)
  Chạy trên máy/VPS Windows LOCAL (nơi chạy local-server.js + trình duyệt Playwright).

  Gom các dữ liệu KHÔNG có backup nào khác:
    - config/*        : profiles-meta, channels, proxies, user-permissions, zalo-accounts (bản gốc, ở LOCAL)
    - .env            : secrets/API keys (ở LOCAL)
    - playwright-data : session login FB/Zalo (chỉ tồn tại ở máy LOCAL)
    - posts.db        : lấy từ server REMOTE qua SSH (sqlite3 .backup -> snapshot nhất quán)
                        gồm lịch sử đăng, lịch hẹn, seeding, settings, content

  Cài đặt & lên lịch: xem scripts/BACKUP.md
#>

$ErrorActionPreference = 'Stop'

# ======================= CẤU HÌNH (sửa nếu môi trường đổi) =======================
# Thư mục server trên máy LOCAL (chứa config\, playwright-data\, .env)
$XekoServerDir = "C:\xeko\server"
# Có kèm session trình duyệt không (lớn ~1GB). Nên đóng trình duyệt trước khi chạy.
$IncludeSessions = $true

# --- Server REMOTE (Linux) chứa posts.db ---
$SshKey    = "$env:USERPROFILE\.ssh\xeko_backup"   # key SSH (OpenSSH) truy cập REMOTE
$RemoteSsh = "vmadmin@103.140.249.232"             # user@host của server REMOTE
$RemoteDb  = "/opt/dashboard-bot/data/bots/9a031e766d216717/server/data/posts.db"

# --- Google Drive (rclone) ---
$RcloneRemote = "drive"          # tên remote rclone đã cấu hình (rclone listremotes)
$DriveFolder  = "XekoBackups"    # thư mục đích trên Google Drive
$KeepWeeks    = 8                # giữ bản backup trong N tuần (cũ hơn sẽ bị xoá trên Drive)
# ===============================================================================

$ts    = Get-Date -Format "yyyy-MM-dd_HHmm"
$stage = Join-Path $env:TEMP "xeko-backup-$ts"
$zip   = Join-Path $env:TEMP "xeko-backup-$ts.zip"

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }

try {
  Log "[1/5] Chuan bi thu muc tam: $stage"
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage "config") | Out-Null

  # --- config/ + .env (bản gốc trên LOCAL) ---
  $cfgSrc = Join-Path $XekoServerDir "config"
  if (Test-Path $cfgSrc) {
    Copy-Item (Join-Path $cfgSrc "*") (Join-Path $stage "config") -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Warning "Khong thay thu muc config: $cfgSrc"
  }
  $envSrc = Join-Path $XekoServerDir ".env"
  if (Test-Path $envSrc) { Copy-Item $envSrc (Join-Path $stage ".env") -Force }

  # --- playwright-data (sessions) — robocopy chiu duoc file dang khoa ---
  if ($IncludeSessions) {
    $pwSrc = Join-Path $XekoServerDir "playwright-data"
    if (Test-Path $pwSrc) {
      Log "[2/5] Sao chep playwright-data (sessions)... (dong trinh duyet de tranh file bi khoa)"
      robocopy $pwSrc (Join-Path $stage "playwright-data") /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
      if ($LASTEXITCODE -ge 8) { Write-Warning "robocopy playwright-data co loi (exit $LASTEXITCODE)" }
    } else {
      Write-Warning "Khong thay playwright-data: $pwSrc"
    }
  } else {
    Log "[2/5] Bo qua sessions (IncludeSessions = false)"
  }

  # --- posts.db tu REMOTE qua SSH (snapshot an toan bang sqlite3 .backup) ---
  Log "[3/5] Lay posts.db tu REMOTE qua SSH..."
  $remoteTmp = "/tmp/posts-backup-$ts.db"
  try {
    & ssh -i $SshKey -o StrictHostKeyChecking=accept-new -o BatchMode=yes $RemoteSsh `
      "sqlite3 '$RemoteDb' '.backup $remoteTmp' && gzip -f '$remoteTmp'"
    if ($LASTEXITCODE -ne 0) { throw "ssh sqlite3 .backup that bai (exit $LASTEXITCODE)" }
    & scp -i $SshKey -o StrictHostKeyChecking=accept-new "${RemoteSsh}:${remoteTmp}.gz" (Join-Path $stage "posts.db.gz")
    if ($LASTEXITCODE -ne 0) { throw "scp posts.db.gz that bai (exit $LASTEXITCODE)" }
    & ssh -i $SshKey -o BatchMode=yes $RemoteSsh "rm -f '${remoteTmp}.gz'" | Out-Null
  } catch {
    Write-Warning "Khong lay duoc posts.db tu REMOTE: $($_.Exception.Message)"
  }

  # --- nen ---
  Log "[4/5] Nen -> $zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

  # --- upload len Google Drive + don ban cu ---
  Log "[5/5] Upload len Google Drive: ${RcloneRemote}:$DriveFolder"
  & rclone copy $zip "${RcloneRemote}:$DriveFolder" --progress
  if ($LASTEXITCODE -ne 0) { throw "rclone upload that bai (exit $LASTEXITCODE)" }

  $minAge = "$($KeepWeeks * 7)d"
  Log "Don ban backup cu hon $KeepWeeks tuan ($minAge)"
  & rclone delete "${RcloneRemote}:$DriveFolder" --min-age $minAge --include "xeko-backup-*.zip"

  Log "HOAN TAT: xeko-backup-$ts.zip da len Drive."
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $zip)   { Remove-Item $zip   -Force          -ErrorAction SilentlyContinue }
}
