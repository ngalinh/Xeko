# Đánh giá khách tự động qua Gemini web

Chế độ thử nghiệm `gemini-web` mở Gemini bằng Playwright, gửi dữ liệu profile và tối đa 10 ảnh đã thu thập, nhận JSON rồi áp dụng cùng bộ kiểm tra bằng chứng như Gemini API. Không cần API key và không cần GPU để chạy mô hình tại VPS. Google vẫn xử lý AI trên máy chủ của họ.

## Thiết lập trên VPS Windows

1. Mở terminal trong thư mục `server`, cài dependencies bằng `npm install` nếu chưa có và trình duyệt bằng `npm run playwright:install`.
2. Trong `server/.env`, đặt `CTV_AI_PROVIDER=gemini-web`. Có thể để trống `GEMINI_API_KEY` ở chế độ này.
3. Chạy `npm run gemini:login` bằng cùng tài khoản Windows chạy Xeko. Tự đăng nhập Google trong cửa sổ vừa mở, chọn chế độ Gemini muốn dùng, rồi nhấn Enter trong terminal để lưu và đóng phiên.
4. Khởi động lại server Xeko. Chọn khách và chạy bước đánh giá như trước. Nhật ký chiến dịch hiển thị tải ảnh/chờ kết quả/lỗi.

Phiên mặc định nằm ở `server/playwright-data/gemini-web`, tách biệt phiên Facebook. Đây là dữ liệu đăng nhập riêng tư, không đưa lên GitHub hoặc chia sẻ. Có thể đặt `CTV_GEMINI_WEB_PROFILE` thành thư mục tuyệt đối riêng. Nếu dùng Chrome đã cài, đặt `CTV_GEMINI_WEB_CHANNEL=chrome` cho cả lệnh đăng nhập và server. Không trỏ vào profile Chrome đang sử dụng hàng ngày.

Trình duyệt chạy có cửa sổ: cần phiên desktop Windows hoạt động; không cấu hình server chạy như service không có desktop. Đóng lệnh đăng nhập trước khi chạy đánh giá. Chỉ một tiến trình server được sử dụng profile Gemini này. Các yêu cầu trong cùng tiến trình được xếp hàng, mỗi khách dùng cuộc trò chuyện mới; trình duyệt đóng sau mỗi khách để giải phóng bộ nhớ.

## Hành vi và giới hạn

- AI tự gửi dữ liệu và nhận kết quả sau lần đăng nhập đầu. Các bước duyệt chiến dịch và gửi tin hiện có vẫn giữ nguyên. Đây không phải cấu hình tự gửi tin ngay sau khi AI đánh giá.
- Kiểm tra mã yêu cầu và URL khách trong phản hồi; JSON sai hoặc thiếu bằng chứng không được dùng để tự chọn khách.
- Chỉ gửi prompt khi xác nhận đủ tên ảnh đã đính kèm. Chờ phản hồi tối đa 3 phút, không tự gửi lại hoặc chuyển sang API khi lỗi.
- Hết hạn đăng nhập, xác minh Google, hết hạn mức, hoặc giao diện thay đổi sẽ làm dừng lượt đánh giá và báo lỗi. Mở `npm run gemini:login` để tự xử lý đăng nhập/xác minh; chương trình không vượt qua xác minh.
- Gói Google AI và chế độ đang chọn trong giao diện quyết định khả năng sử dụng; không bảo đảm hạn mức hoặc hoạt động không gián đoạn. Máy không chạy mô hình AI cục bộ nhưng trình duyệt vẫn dùng RAM của VPS.
- Bộ kiểm thử tự động kiểm tra logic; tải ảnh và đăng nhập thực tế cần kiểm tra bằng tài khoản của bạn trên VPS trước khi dùng chiến dịch thật. Bộ chọn giao diện hiện hỗ trợ tiếng Anh và tiếng Việt.

Để quay về API, đặt `CTV_AI_PROVIDER=gemini-api`, điền `GEMINI_API_KEY` và khởi động lại server.

## Kiểm tra sau khi cài

Chạy một khách thử với dữ liệu không nhạy cảm và có ảnh. Kiểm tra nhật ký có đủ số ảnh, kết quả thuộc đúng khách và có phân tích caption. Sau đó thử dừng chiến dịch trong khi chờ AI; lượt đó không được ghi kết quả hoặc tự gửi tin. Chưa chạy hàng loạt nếu Gemini chưa tải đủ ảnh hoặc chưa lưu được phiên đăng nhập.
