# Bản nháp từ ảnh sản phẩm

Trong **Lấy deal → Sản phẩm** (hoặc link trực tiếp `?page=deals`), nhập link rồi bấm **Lấy deal**. Trang `get-deal-test.html` vẫn hoạt động và dùng chung giao diện, mã xử lý với tab mới. Chọn 1–20 ảnh, kiểm tra tên sản phẩm, nhập thông tin đã xác minh và giá bán shop nếu có. Bấm **AI tạo & lưu bản nháp**.

Server tải ảnh từ CDN Macy’s vào kho ảnh Xeko, dùng Gemini đã cấu hình (`GEMINI_API_KEY`) với tối đa 5 ảnh để viết nội dung. Tất cả ảnh được chọn được lưu kèm bài trong **Kho content**, gắn tag `ban-nhap-san-pham`. Giá đọc từ web chỉ là giá tham khảo. Mở Kho content để chỉnh sửa, kiểm tra thông tin và chủ động chọn đăng/lên lịch theo luồng có sẵn. Thao tác tạo nháp không tạo lịch hay gọi hàng đợi đăng bài.

Bản thử chỉ hỗ trợ URL ảnh HTTPS thuộc `slimages.macysassets.com/is/image/MCY/products/`; không theo redirect. Giới hạn 12 MB/ảnh. Nếu CDN chặn tải từ server hoặc AI lỗi, chưa lưu bản nháp. Nếu mất kết nối khi lưu, kiểm tra Kho content trước khi thử lại để tránh trùng bài. Chưa có cơ chế duyệt nhiều cấp; việc duyệt là người dùng kiểm tra và chọn đăng/lên lịch trong Xeko.

Kiểm thử không gọi AI/CDN thật:

```
node --test server/test-product-draft.js server/test-product-images.js server/test-product-images-dom.js
```

Cần thử trên môi trường triển khai để xác nhận kết nối CDN, Gemini và ảnh được dùng lại khi mở bài trong Kho content.

Nút “Mở bản nháp vừa tạo để duyệt” mở `?page=drafts&draft=<id>` và hiển thị trình sửa đúng bài sau khi tải danh sách. Trong Kho content, chọn tab “Bản nháp / Bài mẫu” để xem lại bài đã lưu; chọn tab “Kho content” để trở về lịch sử đăng bài. Hai tab Kho content và Bản nháp / Bài mẫu nằm dưới tiêu đề, phía trên bộ lọc và không hiển thị ở Dashboard. Lấy deal là mục riêng trên menu, gồm tab Sản phẩm và Lịch sử lấy deal. Chuyển tab giữ nguyên dữ liệu sản phẩm đang nhập. Chức năng Bài viết Facebook tạm ẩn. Kho content mặc định vẫn hiển thị lịch sử đăng bài.
