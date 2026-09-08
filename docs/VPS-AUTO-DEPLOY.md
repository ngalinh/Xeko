# Tự động deploy Xeko runner lên VPS Windows

Workflow `.github/workflows/deploy-vps.yml` deploy commit mới của nhánh `main` lên GitHub Actions self-hosted runner Windows và reload PM2 process `xeko-local`.

## Phần mềm cần cài

- Windows Server 2016 trở lên, Windows 10 hoặc Windows 11 64-bit.
- Git for Windows.
- Node.js 22 LTS và npm.
- PM2 cùng tiện ích tự khởi động trên Windows:

  ```powershell
  npm install --global pm2 pm2-windows-startup
  pm2-startup install
  ```

- GitHub Actions self-hosted runner được đăng ký với custom label `vps`.

Workflow tự chạy `npx playwright install chromium`; không cần cài Chromium thủ công.

## Đăng ký GitHub Actions runner

Vì Xeko và mi là hai repository cá nhân, cách đơn giản nhất là cài hai runner instance trong hai thư mục khác nhau, cùng Windows user:

- `C:\actions-runner-xeko` đăng ký tại repository Xeko.
- `C:\actions-runner-mi` đăng ký tại repository mi.

Trong từng repository mở Settings → Actions → Runners → New self-hosted runner, chọn Windows/x64 và chạy đúng các lệnh GitHub sinh ra. Khi chạy `config.cmd`, thêm label `vps`. Hai runner phải có đủ labels `self-hosted`, `Windows`, `X64`, `vps`.

Nếu Playwright chạy headed (`HEADLESS=false`), khởi động runner tương tác bằng `run.cmd` trong Windows user đang đăng nhập. Không chạy runner hoặc PM2 trong Session 0 vì cửa sổ Chrome không hiển thị được. Muốn tự bật sau reboot, cấu hình auto-login và Task Scheduler với lựa chọn “Run only when user is logged on”.

## Thư mục ứng dụng

Thư mục hiện tại:

```powershell
New-Item -ItemType Directory -Force C:\xeko
```

User chạy GitHub runner phải có quyền Modify trên thư mục này. Lần workflow đầu tiên sẽ clone source rồi dừng an toàn nếu thiếu secret. Sau đó tạo `C:\xeko\.env` từ `server\.env.example` và điền cấu hình production, rồi chạy lại workflow.

Nếu Xeko đang nằm ở thư mục khác, đặt repository variable `XEKO_DEPLOY_DIR` thành đường dẫn hiện tại để không tạo bản chạy thứ hai. Health check mặc định là `http://127.0.0.1:3001/health`; thay bằng `XEKO_HEALTHCHECK_URL` nếu port khác.

Sau lần deploy thành công:

```powershell
pm2 save
pm2 status
```

## Lưu ý

Hai workflow dùng chung file lock trong `%TEMP%` để không deploy Xeko và mi đồng thời. File `.env`, profile Playwright và dữ liệu không được Git theo dõi sẽ được giữ nguyên qua các lần deploy.
