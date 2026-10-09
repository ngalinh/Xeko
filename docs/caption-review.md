# Quét caption không AI

Tạo chiến dịch mới, chọn **Quét caption — không AI, tự chọn khách** ở bước 1 (mặc định trên giao diện mới). Nhập danh sách rồi duyệt quét. Không cần Gemini API key hoặc đăng nhập Google. Cần cập nhật cả giao diện và worker chạy Playwright trước khi thử; không dùng giao diện mới với worker cũ.

Worker đọc bio và tối đa 5 caption khác nhau theo thứ tự xuất hiện trong feed; đây không bảo đảm là 5 bài mới nhất vì Facebook có thể ghim/sắp xếp bài. Không chụp ảnh bài viết, không gửi dữ liệu sang AI. Kết quả được lưu cùng khách, hiển thị caption nguyên văn và highlight brand, nhà bán lẻ, từ khóa bán hàng, ngữ cảnh cần kiểm tra. Bản đầu chưa thu thập ngày/link riêng của từng bài; có link hồ sơ trong bảng.

Mọi kết quả đều cần người dùng tick chọn và duyệt nội dung gửi. Nhận diện brand/nhà bán lẻ không xác minh nguồn hàng Mỹ. Không tự loại người dùng vì một từ khóa tuyển CTV. Khách đã có lịch sử liên hệ, UID chưa xác minh và các bước duyệt gửi vẫn chịu kiểm tra hiện có. Không đọc được caption thì cần quét lại trước khi chọn.

## Từ điển

Chỉnh file server/src/ctv/brand-dictionary.json để thêm tên chuẩn và aliases, tăng version rồi khởi động lại worker. Chỉ thêm cách viết đã xác nhận. 35 brand khởi đầu gồm nhóm thời trang, giày, túi và mỹ phẩm. Chữ hoa/thường, một số ký tự Unicode và khoảng trắng/dấu chấm giữa chữ được chuẩn hóa; ad!das, L@coste là alias cụ thể. Không dùng so khớp gần đúng tùy ý. CK, MK, LV và tên dễ nhầm cần ngữ cảnh sản phẩm; kết quả chưa chắc được ghi “Có thể là”. Các quy tắc vẫn có thể nhận diện nhầm hoặc bỏ sót; nên thử trên một nhóm khách đã biết.

Thay đổi từ điển chỉ áp dụng khi quét lại; kết quả cũ giữ version đã dùng. Chưa có màn hình sửa alias hoặc tự học từ thao tác người dùng trong bản thử đầu.

## Chế độ cũ

Chiến dịch cũ và API tạo chiến dịch không truyền assessmentMode tiếp tục dùng chế độ AI. Giao diện cho chọn AI nếu cần đọc ảnh. Không đổi chế độ giữa một chiến dịch; tạo chiến dịch mới để đổi. Quét lại giữ chế độ đã chọn và xóa các phê duyệt/bản nháp theo luồng hiện có.
