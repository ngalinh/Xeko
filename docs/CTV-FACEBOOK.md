# Luồng tuyển CTV qua Facebook cá nhân

## Sử dụng

Vào **Tuyển CTV** trong menu Xeko (hoặc `/ctv.html`). Nhập TXT/CSV có link Facebook hoặc dán danh sách, chọn Facebook cá nhân đã đăng nhập, sửa lời mời và tạo chiến dịch. Danh sách tối đa 100 link; link hồ sơ được chuẩn hóa và gộp trùng. Các trường khác trong CSV chưa được nhập vào hệ thống; tên dùng để cá nhân hóa lấy từ hồ sơ.

- **Chỉ AI đánh giá:** kiểm tra danh sách và lưu kết quả, không gửi.
- **AI đánh giá → tự gửi:** kiểm tra từng hồ sơ, gửi ngay cho hồ sơ đạt; bỏ qua hồ sơ thiếu dữ liệu. Bấm **Bắt đầu chiến dịch** sau khi xem lại chế độ và danh sách. Tin nhắn của chiến dịch được giữ nguyên theo thời điểm tạo.
- **Dừng:** dừng trước bước gửi hoặc trước hồ sơ tiếp theo. Tin đã gửi không được thu hồi.

AI dùng Gemini giống tính năng tạo nội dung hiện có trong repo. Đặt `GEMINI_API_KEY` trong môi trường **máy thực thi Playwright** (local server nếu dùng mô hình cloud/local). Không đưa key vào trình duyệt. Node.js 18+ cần thiết cho fetch và AbortSignal.timeout. Giữ nguyên cấu hình `LOCAL_API_KEY`, xác thực Basso và phân quyền tài khoản hiện có.

## Điều kiện đánh giá và gửi

1. Mở link hồ sơ trực tiếp trong phiên Facebook được chọn. Link bài viết, nhóm, link chia sẻ và URL ngoài Facebook bị từ chối.
2. Đọc tên, dấu hiệu hồ sơ cá nhân/Fanpage và tối đa 10 bài đang được render (mỗi bài tối đa 6.000 ký tự). Bản đầu chưa cuộn toàn bộ lịch sử, đọc chữ trong ảnh hay mở hồ sơ khóa.
3. Gửi các nội dung nhìn thấy này tới Gemini để phân loại hồ sơ, seller US, điểm tin cậy và trích dẫn. Nội dung Facebook được coi là dữ liệu, không phải chỉ dẫn cho AI.
4. Chỉ đạt khi AI đánh giá `personal`, `sellerUS=yes`, độ tin cậy ≥ 0,85, có trích dẫn đối chiếu được với dữ liệu đầu vào, đồng thời có dấu hiệu hồ sơ cá nhân và bài bán hàng nói rõ phục vụ thị trường Mỹ. Điểm AI là ước lượng của mô hình, không phải xác suất đã được hiệu chuẩn. Không dùng tên, quốc tịch, sắc tộc, tiếng Anh, nơi ở hay USD làm bằng chứng seller US. Người mua hàng Mỹ về Việt Nam không mặc nhiên là seller phục vụ khách tại Mỹ.
5. Lấy ID người nhận từ link hồ sơ số hoặc link Message của chính hồ sơ. Nếu không lấy được ID thì chuyển kiểm tra thủ công. Không đoán ID từ tên.
6. Mở hội thoại theo ID, kiểm tra URL và link hồ sơ trong tiêu đề, xác minh ô soạn duy nhất và không có bản nháp. Điền mẫu với `{name}` rồi gửi một lần.
7. Chỉ ghi `sent` khi xuất hiện thêm tin đúng nội dung với nhãn Sent/Delivered tương ứng. Nếu thiếu tín hiệu xác nhận, ghi `unconfirmed`, dừng chiến dịch và không tự thử lại.

Giao diện Facebook/Messenger thay đổi theo tài khoản và ngôn ngữ. Bản này hỗ trợ các dấu hiệu tiếng Việt/Anh và cố ý dừng khi không khớp. Cần thử trên tài khoản kiểm thử trước khi vận hành thực tế; chưa có kiểm thử gửi trực tiếp lên Facebook trong lần phát triển này.

## Lưu trữ và chống trùng

Chiến dịch và dấu lần gửi lưu ở `data/.ctv/campaigns.json` trong `XEKO_DATA_DIR` (mặc định root repo). Thư mục dot được Express static mặc định bỏ qua. Không cấu hình static server để phục vụ thư mục này. Dữ liệu chỉ trả qua API có xác thực và theo chủ chiến dịch; phía cloud kiểm tra quyền tài khoản trước khi chuyển tới local.

Đánh dấu người nhận **trước** thao tác Enter và ghi file bằng rename. Dấu này dùng chung các chiến dịch/tài khoản gửi trong cùng worker. Mất kết nối sau gửi hoặc khởi động lại không khiến tự gửi lại. Một chiến dịch chỉ được bắt đầu một lần; muốn chạy lại các hồ sơ chưa gửi, tạo chiến dịch mới. Bản đầu chưa có chức năng xác nhận thủ công và tiếp tục chiến dịch bị gián đoạn. Không xóa dấu chống trùng khi chưa kiểm tra Messenger.

Triển khai **một tiến trình worker cho mỗi thư mục dữ liệu**; JSON store không dùng cho nhiều worker ghi đồng thời. Dùng lại browser của Xeko nhưng mở tab riêng; không chạy các chức năng đóng browser/đổi phiên tài khoản trong lúc chiến dịch chạy. Đóng phiên giữa chừng sẽ làm chiến dịch dừng cần xử lý.

## Kiểm thử

Chạy từ root repo: `node --test server/test-ctv.js`.
Các ca kiểm thử dùng dữ liệu giả, không gọi Gemini thật và không gửi tin Facebook: URL sai, điều kiện thị trường US, AI thiếu bằng chứng/sai schema/độ tin cậy thấp, chế độ chỉ đánh giá, chống trùng, dừng, lỗi sau gửi, khởi động lại và phân quyền.

Trước khi triển khai: đăng nhập Facebook bằng tài khoản cá nhân trong Quản lý tài khoản; chạy chế độ chỉ đánh giá trên hồ sơ kiểm thử; kiểm tra kết quả và bằng chứng; sau đó kiểm thử một lời mời trên người nhận kiểm thử đã thống nhất. Không bật chạy hàng loạt khi selector chưa được xác minh trên phiên thực tế.
