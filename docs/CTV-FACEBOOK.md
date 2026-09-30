# Gửi tin nhắn hàng loạt: quy trình 3 bước có duyệt

Vào **Gửi tin nhắn hàng loạt** trong menu Xeko. Nếu Xeko chạy trên platform tại `https://ai.basso.vn/b/<bot-id>/`, trang gửi tin nhắn hàng loạt nằm tại `https://ai.basso.vn/b/<bot-id>/ctv.html`; không mở `https://ai.basso.vn/ctv.html` vì đó là gốc của platform. Khi Xeko chạy trực tiếp ở gốc một domain, dùng `/ctv.html` như trước. Không có chế độ AI đánh giá rồi tự gửi. Mỗi chiến dịch lưu danh sách, kết quả AI, bản xem trước và thời điểm/người duyệt từng bước.

## 1. Nhập danh sách khách hàng

Chọn Facebook cá nhân đã đăng nhập, đặt tên chiến dịch, dán dữ liệu hoặc nhập TXT/CSV có link. Bấm **Kiểm tra danh sách** để xem số link hợp lệ, link trùng được gộp và link bị loại cùng lý do. Chỉ link hồ sơ trực tiếp được nhận; tối đa 100 link mỗi lần. Các cột khác trong CSV chưa được nhập; nhãn khách hàng hiển thị phần đường dẫn Facebook (ví dụ `linhduongasale.auth`), link dạng `profile.php?id=...` hiển thị ID. Tên dùng trong biến `{name}` vẫn lấy từ hồ sơ.

Bước nhập chỉ tạo kết quả kiểm tra. Chưa mở Facebook, chưa gọi AI. Bấm **Duyệt danh sách & chạy AI** mới cho phép xử lý các link hợp lệ. Danh sách và tài khoản được giữ cố định theo chiến dịch; muốn đổi danh sách thì tạo chiến dịch mới.

## 2. AI đánh giá

AI phân loại hồ sơ cá nhân/Fanpage, bằng chứng sản phẩm có bán trên website Mỹ, điểm tin cậy, lý do và trích dẫn. UI hiển thị tiến độ và kết quả từng khách. Khi xong, chiến dịch dừng ở trạng thái **Chờ duyệt kết quả AI**; không gửi bất kỳ tin nào.

Nút **Bỏ qua** ở kết quả hồ sơ chưa đủ điều kiện gửi lưu trạng thái **Đã bỏ qua** trong chiến dịch. Hồ sơ này không được duyệt gửi và không được quét lại khi bấm **Thử lại AI**; kết quả cũ vẫn được giữ để đối chiếu.

Chọn các khách đủ điều kiện, đọc bằng chứng rồi bấm **Duyệt N khách & sang bước 3**. Khách thiếu bằng chứng hoặc AI chưa đánh giá đạt vẫn có thể được chọn, tạo bản xem trước và gửi sau khi người dùng duyệt thủ công. Khách đã có dấu gửi trước vẫn bị chặn. Khách AI đánh giá đạt nhưng chưa xác minh ID vẫn được chọn và chuyển sang bước soạn tin; hệ thống hiển thị lý do chưa sẵn sàng gửi và chặn tạo bản xem trước/gửi cho đến khi xác minh ID. Bấm Thử lại AI để xác minh lại, sau đó duyệt lại danh sách. Nếu hai link cùng một ID Facebook, chỉ duyệt một link. Khi dừng/lỗi AI, có thể duyệt phần kết quả đã xử lý; các hồ sơ chưa xử lý không được chọn. Chạy lại phần còn lại bằng chiến dịch mới.

Tiêu chí: AI đánh giá `personal`, `sellerUS=yes`, confidence ≥ 0,85; có trích dẫn khớp nội dung đầu vào; đồng thời phải có dấu hiệu profile cá nhân, đọc ít nhất 3 bài bán hàng và bằng chứng sản phẩm gắn với website Mỹ trong bio/bài viết. Điểm mô hình không phải xác suất đã hiệu chuẩn. Không suy luận thị trường từ tên, quốc tịch, sắc tộc, nơi ở, tiếng Anh hoặc USD. Sản phẩm mua từ website Mỹ về bán tại Việt Nam vẫn phù hợp; không yêu cầu khách mua ở Mỹ. Kết quả thiếu phiên bản `us-website-products-v2` được đánh dấu tiêu chí cũ và không được duyệt gửi. Cần cập nhật cả web và Xeko worker, sau đó tạo chiến dịch mới để đánh giá lại; kết quả đã lưu không tự đổi.

AI chỉ dựa trên nội dung profile, chưa truy cập website Mỹ để xác minh. Dưới 3 bài bán hàng sẽ báo thiếu dữ liệu; đây là đánh giá tham khảo, không chặn gửi khi người dùng đã chọn và duyệt khách thủ công. Việc xác minh người nhận, chống gửi trùng và duyệt bản xem trước vẫn bắt buộc.

Mỗi khách có **Nhật ký quét** ngay trong cột AI đánh giá, cập nhật cùng tiến độ: mở tab/profile, chờ tên/bio, từng lượt đọc và cuộn, số bài mới, số caption có dấu hiệu bán hàng, số ảnh gửi AI, từng lần gọi AI và lý do dừng/lỗi. Mốc giây là thời gian tính từ khi bắt đầu hồ sơ, không phải thời gian dự kiến hoàn tất. Giữ tối đa 100 dòng mỗi khách trong dữ liệu chiến dịch, xem lại được sau reload; Thử lại AI tạo nhật ký mới. Log không lưu caption, bio hoặc ảnh gốc.

Bộ quét chỉ đọc bài trong vùng đang xem (không giới hạn vào 10 bài đầu DOM), tái sử dụng ảnh đã chụp cho caption trùng và không kéo trang ngược lên để chụp ảnh ngoài màn hình. Dừng thu thập khi đủ 5 caption có dấu hiệu bán hàng, 3 lượt không có bài mới, 12 lượt cuộn hoặc hết ngân sách 60 giây đọc bài. Thao tác đang chạy có thể kết thúc muộn hơn ngân sách một khoảng timeout ngắn; dữ liệu đã đọc được giữ lại. Thời gian mở trang/chờ header (tối đa 30 giây mỗi bước) và gọi AI (45 giây/lần, tối đa 2 lần nếu phản hồi sai định dạng) tính riêng. Nút dừng được kiểm tra giữa các thao tác đọc và trước/sau AI; cần chờ thao tác hiện tại kết thúc. Đây là mẫu bài thu thập được, không phải toàn bộ lịch sử profile.

## 3. Gửi tin nhắn hàng loạt

Soạn tin nhắn, dùng `{name}` để chèn tên. Bấm **Tạo bản xem trước** để xem nội dung chính xác cho từng khách đã duyệt. Kiểm tra danh sách/nội dung, đánh dấu xác nhận, rồi bấm **Duyệt & gửi N tin nhắn**. Gửi lần lượt, có kết quả từng khách và nút dừng.

Sửa nội dung phải tạo và duyệt bản xem trước mới. **Chọn lại khách** quay về bước 2 và hủy bản xem trước cũ. Server kiểm tra token bản xem trước và các chốt duyệt, không chỉ ẩn nút trên UI. Sau khi duyệt gửi, không đổi nội dung/người nhận trong chiến dịch đó.

Trước Enter, worker xác minh ID người nhận, URL và link hồ sơ ở tiêu đề hội thoại, ô soạn duy nhất và không có bản nháp. Lưu dấu chống trùng trước khi gửi. Chỉ ghi `sent` khi thấy tin mới đúng nội dung cùng dấu Sent/Delivered. Nếu không xác nhận được, ghi `unconfirmed`, dừng và không tự gửi lại. Nút dừng không thu hồi tin đã gửi.

## Cấu hình và vận hành

- Cửa sổ Facebook dùng kích thước nội dung theo cửa sổ thực tế và yêu cầu Chromium mở tối đa. Nếu hệ điều hành không tự phóng to, có thể phóng to thủ công; giao diện sẽ co giãn theo cửa sổ. Sau khi cập nhật worker, đóng cửa sổ Facebook cũ khi không có tác vụ đang chạy rồi mở lại tài khoản để áp dụng.

- Đặt `GEMINI_API_KEY` trên máy thực thi Playwright. Nếu dùng cloud/local, key cần trên local worker. Gemini hiện dùng `gemini-2.5-flash`, giống tính năng AI hiện có trong repo. Nội dung nhìn thấy trên profile được gửi đến Gemini để đánh giá.
- Node.js 18+; giữ cấu hình `LOCAL_API_KEY`, đăng nhập Basso và phân quyền tài khoản. API cloud kiểm tra quyền trên tài khoản lưu trong chiến dịch trước mọi thao tác.
- Dữ liệu lưu ở `data/.ctv/campaigns.json` trong `XEKO_DATA_DIR` hoặc root repo mặc định. Không public thư mục dot này qua static server. Chạy một worker ghi dữ liệu cho mỗi thư mục.
- Đọc phần giới thiệu dưới tiêu đề profile và cuộn tối đa 12 lượt để thu thập tối đa 5 bài bán hàng khác nhau (6.000 ký tự/bài). Mở “Xem thêm”/“See more” trong bài, đọc caption và chụp tối đa 2 ảnh đã tải mỗi bài (tối đa 5 bài) để gửi Gemini đọc chữ và nhận diện sản phẩm. Bỏ qua ảnh nhỏ và ảnh không tải được; không mở album hoặc cuộn toàn bộ lịch sử. Bài chỉ có ảnh được dùng làm ngữ cảnh, chưa được tính vào ngưỡng 3 bài bán hàng có caption. Bằng chứng duyệt vẫn phải khớp caption/bio. Selector hỗ trợ dấu hiệu tiếng Việt/Anh và dừng khi không xác minh được. Không chạy chức năng đóng browser/đổi phiên tài khoản cùng lúc.
- Tái sử dụng một tab kiểm tra trong cùng đợt quét. Khi hết danh sách, dừng hoặc lỗi, worker đóng browser context của đúng tài khoản quét và xóa tab khỏi cache. Nhật ký ghi đang đóng/đã đóng/lỗi đóng browser; chỉ chuyển sang chờ duyệt sau khi đóng xong. Lỗi đóng giữ kết quả và báo cần xử lý. Không đóng browser tài khoản khác. Chưa xác minh website bên ngoài.
- Trạng thái duyệt và bản xem trước sống qua reload/restart. Job đang chạy khi worker restart chuyển thành `interrupted`; không tự tiếp tục gửi. Chưa có tính năng tiếp tục batch đã bị gián đoạn. Chiến dịch tạo bằng phiên bản cũ chỉ được xem; endpoint `/start` cũ đã bị vô hiệu hóa.
- UI tự thử lại khi tải tiến độ gặp lỗi, đối chiếu trạng thái sau lỗi thao tác và bỏ qua phản hồi của chiến dịch đã chuyển khỏi. Không tự phát lại yêu cầu gửi.

## API chuyển bước

`POST /api/ctv/campaigns` nhận `{name, profile, urls}` và chỉ tạo `import_review`.

| Thao tác | Dữ liệu | Kết quả |
|---|---|---|
| `POST /:id/approve-import` | `{}` | Duyệt bước 1, chạy AI, dừng tại `analysis_review` |
| `POST /:id/skip-lead` | `{leadId}` | Bỏ qua hồ sơ không đủ điều kiện ở bước duyệt AI |
| `POST /:id/approve-analysis` | `{leadIds}` | Duyệt tập khách đạt, chuyển `message_review` |
| `POST /:id/review-analysis` | `{}` | Chọn lại khách, hủy preview |
| `POST /:id/prepare-messages` | `{template}` | Tạo từng tin nhắn và token preview, chưa gửi |
| `POST /:id/send` | `{previewToken}` | Duyệt đúng preview và xếp hàng gửi |
| `POST /:id/stop` | `{}` | Yêu cầu dừng trước thao tác gửi/hồ sơ tiếp theo |

Các đường dẫn `/:id/...` đều thuộc `/api/ctv/campaigns`. Yêu cầu duyệt bước 1 lặp lại không chạy lại AI; yêu cầu gửi cùng token lặp lại không gửi lại.

## Kiểm thử

Chạy `node --test server/test-ctv.js` từ root repo. 15 ca dùng adapter giả: chốt duyệt ở API, chỉ gửi tập đã chọn, token hết hiệu lực, chống trùng/idempotency, hủy, restart, quyền tài khoản và dữ liệu nhập. UI được thử trên preview dùng server quy trình thật với adapter AI/Facebook mô phỏng; đã kiểm tra chuyển 3 bước, khóa gửi khi sửa nội dung và bố cục mobile.

Chưa gọi Gemini hay gửi Facebook thật trong quá trình phát triển. Trước triển khai cần kiểm thử selector bằng tài khoản và người nhận thử nghiệm. Không coi preview mô phỏng là kiểm chứng khả năng gửi trên mọi giao diện Messenger.

## Dữ liệu đọc profile và kết luận thiếu bằng chứng

Đăng bài Facebook, bình luận và chiến dịch quét/gửi CTV dùng chung hàng đợi theo tài khoản trên máy chạy Playwright. Cùng tài khoản chạy lần lượt; khác tài khoản chạy song song trong browser riêng. Mỗi chiến dịch CTV giữ lượt đến khi hoàn tất hoặc dừng, nên bài đăng cùng tài khoản sẽ chờ chiến dịch đó. Server chính truyền tài khoản trong từng yêu cầu; cần cập nhật và khởi động lại cả server chính lẫn worker để áp dụng. Thời gian chờ hàng đợi trên worker không tính vào timeout thực thi bài đăng. Nút Dừng vẫn chặn tác vụ chưa bắt đầu.

Bộ đọc hỗ trợ article, FeedUnit, phần tử trong feed và caption message dự phòng. Bài có caption vẫn được giữ dù không khớp từ khóa bán hàng và không lấy được ảnh. Caption dự phòng ngoài khung bài chỉ cung cấp chữ; không lấy ảnh lân cận vì có thể thuộc bài khác.

Giao diện tách số bài/ảnh đã đọc khỏi số bài có dấu hiệu bán hàng trong caption. Dưới 3 bài có dấu hiệu bán hàng, backend buộc kết quả sản phẩm về “Chưa rõ”, không hiển thị phần trăm và không cho duyệt gửi dù AI trả “Có/Không · 100%”. Kết quả không có trích dẫn khớp dữ liệu cũng không được kết luận Có/Không. Bài bán hàng chỉ thể hiện qua ảnh vẫn cần kiểm tra thêm. Kết quả đã lưu cần bấm Thử lại AI sau khi cập nhật worker.
