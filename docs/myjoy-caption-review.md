# Đánh giá caption qua MyJoy

Chỉ thay đổi Xeko. Worker dùng các đường kết nối sẵn có của MyJoy: `/auth/login`, `/api/me`, `/api/backends` và `/ws/agent`. Không điều khiển giao diện MyJoy bằng Playwright, không cần sửa server MyJoy. Playwright chỉ thu thập Facebook.

## Cấu hình trên máy chạy Playwright

Cần Node.js 22.4 trở lên (có WebSocket tích hợp). Thêm các biến sau vào môi trường riêng của worker; không commit file chứa mật khẩu:

```dotenv
CTV_MYJOY_URL=https://myjoy.vn
CTV_MYJOY_OWNER=email-dang-nhap-xeko@example.com
CTV_MYJOY_USERNAME=tai-khoan-myjoy-thuong
CTV_MYJOY_PASSWORD=mat-khau-cua-tai-khoan-do
```

`CTV_MYJOY_OWNER` phải khớp chính xác email đăng nhập Xeko. Bản này hỗ trợ một tài khoản MyJoy cho một người dùng Xeko trên mỗi worker; người dùng khác không được dùng tài khoản này. Tài khoản MyJoy phải là tài khoản thường (không có quyền admin). Có thể tạo tài khoản thường bằng chức năng quản lý tài khoản hiện có của MyJoy; không cần đổi code. Không dùng token đăng nhập của trình duyệt, không sao chép cookie.

Khởi động lại worker sau khi cấu hình theo quy trình vận hành hiện tại. Cần cập nhật cả giao diện/cloud và worker Xeko. Thông tin đăng nhập và token chỉ ở backend; chiến dịch chỉ lưu ID AI đã chọn.

## Sử dụng

1. Tạo chiến dịch mới, chọn **Đánh giá caption qua MyJoy**.
2. Bấm **Kết nối / tải lại danh sách AI**, chọn một AI đang sẵn sàng.
3. Nhập hoặc chọn khách từ thư viện, kiểm tra danh sách rồi duyệt quét.
4. Xeko gửi bio và tối đa 5 caption, nhận brand và dấu hiệu bán hàng, highlight nguyên văn bằng chứng.
5. Đọc kết quả và tự chọn khách. Duyệt người nhận và tin nhắn vẫn là các bước riêng như trước.

Không tự chọn khách, không tự gửi tin, không kết luận nguồn hàng Mỹ, không phân tích ảnh. Không tự lưu các brand do AI suy luận vào từ điển riêng; thao tác thêm brand bằng tay vẫn thuộc chế độ từ khoá. Chế độ MyJoy chưa đánh giá tuyển CTV/đại lý: cần tự kiểm tra tiêu chí đó.

## AI và quyền truy cập

Danh sách lấy từ MyJoy, không hardcode tên model. Gemini CLI hiện không hỗ trợ chat tài khoản thường không gắn repo nên hiển thị nhưng không cho chọn. Backend API chỉ dùng được khi MyJoy đã cấu hình key; vẫn có thể phát sinh phí API. Backend CLI phụ thuộc phiên đăng nhập và hạn mức của nhà cung cấp trên máy MyJoy. Có tên trong danh sách không đảm bảo tài khoản nhà cung cấp vẫn đăng nhập hay còn hạn mức.

Mỗi profile mở kết nối với panel ID ngẫu nhiên, không dùng lại hội thoại, không gửi `sessionId`, `cwd` hoặc repo. Xeko kiểm tra `/api/me` trước mỗi yêu cầu và từ chối tài khoản quản trị. Với tài khoản thường, quyền công cụ do MyJoy hiện tại thực thi; Xeko không thể thay đổi quyền phía MyJoy. Một số backend vẫn có công cụ web. Nếu nhận sự kiện gọi công cụ, Xeko gửi dừng và không nhận kết quả, nhưng đây không phải một sandbox mới và không đảm bảo chặn công cụ trước khi nó bắt đầu. Không nâng tài khoản tích hợp lên admin khi đang sử dụng.

## Lỗi và hạn mức

- Không tự chuyển sang Gemini API hay AI khác. Muốn dùng từ khoá, tạo chiến dịch ở chế độ từ khoá.
- JSON sai, thiếu caption, bằng chứng không khớp, ngắt kết nối hoặc quá 180 giây: báo lỗi để người dùng xử lý. Không tự gửi lại yêu cầu có thể đã tiêu tốn hạn mức.
- Bấm dừng: Xeko gửi lệnh dừng đúng panel của lượt quét. Nếu mạng đã ngắt, không thể bảo đảm MyJoy nhận lệnh dừng; hãy kiểm tra lượt đang chạy trên MyJoy trước khi thử lại.
- Hết phiên đăng nhập: lần kết nối sau đăng nhập lại. Lỗi từ xa được thay bằng thông báo chung để tránh lộ token, đường dẫn máy chủ hoặc nội dung riêng.
- Chế độ này gửi nội dung bio/caption đến MyJoy và AI đã chọn. Người vận hành cần chọn đúng máy MyJoy và tài khoản được phép xử lý dữ liệu đó.

## Kiểm chứng

Chạy `node --test server/test-ctv-myjoy.js server/test-ctv.js scripts/test-ctv-assessment.cjs scripts/test-ctv-paths.cjs` tại gốc repo. Tests dùng HTTP/WebSocket giả lập; không gửi caption thật hoặc gọi AI tính phí. Cần kiểm tra kết nối worker thực tế sau khi cấu hình tài khoản.
