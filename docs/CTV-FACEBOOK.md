# Gửi tin nhắn hàng loạt: quy trình 3 bước có duyệt

Vào **Gửi tin nhắn hàng loạt** trong menu Xeko. Nếu Xeko chạy trên platform tại `https://ai.basso.vn/b/<bot-id>/`, trang gửi tin nhắn hàng loạt nằm tại `https://ai.basso.vn/b/<bot-id>/ctv.html`; không mở `https://ai.basso.vn/ctv.html` vì đó là gốc của platform. Khi Xeko chạy trực tiếp ở gốc một domain, dùng `/ctv.html` như trước. Không có chế độ AI đánh giá rồi tự gửi. Mỗi chiến dịch lưu danh sách, kết quả AI, bản xem trước và thời điểm/người duyệt từng bước.

## 1. Nhập danh sách khách hàng

Chọn Facebook cá nhân đã đăng nhập, đặt tên chiến dịch, dán dữ liệu hoặc nhập TXT/CSV có link. Bấm **Kiểm tra danh sách** để xem số link hợp lệ, link trùng được gộp và link bị loại cùng lý do. Chỉ link hồ sơ trực tiếp được nhận; tối đa 100 link mỗi lần. Các cột khác trong CSV chưa được nhập; tên khách lấy từ hồ sơ.

Bước nhập chỉ tạo kết quả kiểm tra. Chưa mở Facebook, chưa gọi AI. Bấm **Duyệt danh sách & chạy AI** mới cho phép xử lý các link hợp lệ. Danh sách và tài khoản được giữ cố định theo chiến dịch; muốn đổi danh sách thì tạo chiến dịch mới.

## 2. AI đánh giá

AI phân loại hồ sơ cá nhân/Fanpage, bằng chứng sản phẩm có bán trên website Mỹ, điểm tin cậy, lý do và trích dẫn. UI hiển thị tiến độ và kết quả từng khách. Khi xong, chiến dịch dừng ở trạng thái **Chờ duyệt kết quả AI**; không gửi bất kỳ tin nào.

Chọn các khách đủ điều kiện, đọc bằng chứng rồi bấm **Duyệt N khách & sang bước 3**. Khách thiếu bằng chứng, chưa xác minh ID hoặc đã có dấu gửi trước sẽ không chọn được. Nếu hai link cùng một ID Facebook, chỉ duyệt một link. Khi dừng/lỗi AI, có thể duyệt phần kết quả đã xử lý; các hồ sơ chưa xử lý không được chọn. Chạy lại phần còn lại bằng chiến dịch mới.

Tiêu chí: AI đánh giá `personal`, `sellerUS=yes`, confidence ≥ 0,85; có trích dẫn khớp nội dung đầu vào; đồng thời phải có dấu hiệu profile cá nhân, đọc ít nhất 3 bài bán hàng và bằng chứng sản phẩm gắn với website Mỹ trong bio/bài viết. Điểm mô hình không phải xác suất đã hiệu chuẩn. Không suy luận thị trường từ tên, quốc tịch, sắc tộc, nơi ở, tiếng Anh hoặc USD. Sản phẩm mua từ website Mỹ về bán tại Việt Nam vẫn phù hợp; không yêu cầu khách mua ở Mỹ. Kết quả thiếu phiên bản `us-website-products-v2` được đánh dấu tiêu chí cũ và không được duyệt gửi. Cần cập nhật cả web và Xeko worker, sau đó tạo chiến dịch mới để đánh giá lại; kết quả đã lưu không tự đổi.

## 3. Gửi tin nhắn hàng loạt

Soạn tin nhắn, dùng `{name}` để chèn tên. Bấm **Tạo bản xem trước** để xem nội dung chính xác cho từng khách đã duyệt. Kiểm tra danh sách/nội dung, đánh dấu xác nhận, rồi bấm **Duyệt & gửi N tin nhắn**. Gửi lần lượt, có kết quả từng khách và nút dừng.

Sửa nội dung phải tạo và duyệt bản xem trước mới. **Chọn lại khách** quay về bước 2 và hủy bản xem trước cũ. Server kiểm tra token bản xem trước và các chốt duyệt, không chỉ ẩn nút trên UI. Sau khi duyệt gửi, không đổi nội dung/người nhận trong chiến dịch đó.

Trước Enter, worker xác minh ID người nhận, URL và link hồ sơ ở tiêu đề hội thoại, ô soạn duy nhất và không có bản nháp. Lưu dấu chống trùng trước khi gửi. Chỉ ghi `sent` khi thấy tin mới đúng nội dung cùng dấu Sent/Delivered. Nếu không xác nhận được, ghi `unconfirmed`, dừng và không tự gửi lại. Nút dừng không thu hồi tin đã gửi.

## Cấu hình và vận hành

- Đặt `GEMINI_API_KEY` trên máy thực thi Playwright. Nếu dùng cloud/local, key cần trên local worker. Gemini hiện dùng `gemini-2.5-flash`, giống tính năng AI hiện có trong repo. Nội dung nhìn thấy trên profile được gửi đến Gemini để đánh giá.
- Node.js 18+; giữ cấu hình `LOCAL_API_KEY`, đăng nhập Basso và phân quyền tài khoản. API cloud kiểm tra quyền trên tài khoản lưu trong chiến dịch trước mọi thao tác.
- Dữ liệu lưu ở `data/.ctv/campaigns.json` trong `XEKO_DATA_DIR` hoặc root repo mặc định. Không public thư mục dot này qua static server. Chạy một worker ghi dữ liệu cho mỗi thư mục.
- Đọc bio dưới ảnh đại diện, cuộn tối đa 12 lần để thu thập tối đa 5 bài bán hàng (6.000 ký tự/bài); dưới 3 bài là chưa đủ dữ liệu. Chưa OCR hình ảnh hoặc xác minh website bên ngoài. Giữ lại và tái sử dụng một tab kiểm tra riêng cho mỗi tài khoản, kể cả khi AI lỗi, để xem hồ sơ cuối; không tự đóng tab rồi quay về `about:blank`. Selector hỗ trợ dấu hiệu tiếng Việt/Anh và dừng khi không xác minh được. Không chạy chức năng đóng browser/đổi phiên tài khoản cùng lúc.
- Trạng thái duyệt và bản xem trước sống qua reload/restart. Job đang chạy khi worker restart chuyển thành `interrupted`; không tự tiếp tục gửi. Chưa có tính năng tiếp tục batch đã bị gián đoạn. Chiến dịch tạo bằng phiên bản cũ chỉ được xem; endpoint `/start` cũ đã bị vô hiệu hóa.
- UI tự thử lại khi tải tiến độ gặp lỗi, đối chiếu trạng thái sau lỗi thao tác và bỏ qua phản hồi của chiến dịch đã chuyển khỏi. Không tự phát lại yêu cầu gửi.

## API chuyển bước

`POST /api/ctv/campaigns` nhận `{name, profile, urls}` và chỉ tạo `import_review`.

| Thao tác | Dữ liệu | Kết quả |
|---|---|---|
| `POST /:id/approve-import` | `{}` | Duyệt bước 1, chạy AI, dừng tại `analysis_review` |
| `POST /:id/approve-analysis` | `{leadIds}` | Duyệt tập khách đạt, chuyển `message_review` |
| `POST /:id/review-analysis` | `{}` | Chọn lại khách, hủy preview |
| `POST /:id/prepare-messages` | `{template}` | Tạo từng tin nhắn và token preview, chưa gửi |
| `POST /:id/send` | `{previewToken}` | Duyệt đúng preview và xếp hàng gửi |
| `POST /:id/stop` | `{}` | Yêu cầu dừng trước thao tác gửi/hồ sơ tiếp theo |

Các đường dẫn `/:id/...` đều thuộc `/api/ctv/campaigns`. Yêu cầu duyệt bước 1 lặp lại không chạy lại AI; yêu cầu gửi cùng token lặp lại không gửi lại.

## Kiểm thử

Chạy `node --test server/test-ctv.js` từ root repo. 15 ca dùng adapter giả: chốt duyệt ở API, chỉ gửi tập đã chọn, token hết hiệu lực, chống trùng/idempotency, hủy, restart, quyền tài khoản và dữ liệu nhập. UI được thử trên preview dùng server quy trình thật với adapter AI/Facebook mô phỏng; đã kiểm tra chuyển 3 bước, khóa gửi khi sửa nội dung và bố cục mobile.

Chưa gọi Gemini hay gửi Facebook thật trong quá trình phát triển. Trước triển khai cần kiểm thử selector bằng tài khoản và người nhận thử nghiệm. Không coi preview mô phỏng là kiểm chứng khả năng gửi trên mọi giao diện Messenger.
