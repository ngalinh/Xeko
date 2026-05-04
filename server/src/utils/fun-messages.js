function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function errPopupPersonal() {
  return pick([
    'Ối trời! Facebook đang ngủ gật không cho mở popup 😭 Thử lại sau nha!',
    'Plot twist: popup tạo bài biến mất không để lại địa chỉ 🫠',
    'Thôi xong r! Popup lười không chịu xuất hiện 💀',
    'Cứu với! Popup đang trốn đâu đó không chịu ra 🆘',
    'Facebook "giở chứng" rồi, popup không chịu mở 🤡',
    'Não cá vàng đâu! Popup tạo bài đi đâu mất tiêu r 🐟',
  ]);
}

function errPopupGroup() {
  return pick([
    'Ối trời! Popup tạo bài group đang đình công 😭',
    'Plot twist: group popup bay màu không lý do 🫠',
    'Thôi xong r! Không vào được group để đăng bài 💀',
    'Cứu! Popup group đang trốn đâu đó không ra 🆘',
    'Group đang "mood" không muốn tiếp nhận bài mới 🙃',
    'Facebook chặn đường vào group rồi bro 🚧',
  ]);
}

function errUpload() {
  return pick([
    'Phốt to! Ảnh đang đình công không chịu bay lên 📸💀',
    'Tạch! Upload ảnh out trình rồi bro 😤',
    'Ảnh ngoan không? Sao không chịu upload vậy 😭',
    'Não cá vàng! Ảnh quên đường lên server rồi 🐟',
    'Ảnh đang "ngủ đông" không chịu thức dậy để upload 💤',
    'Cứu! Ảnh bị kẹt đường không lên được 🚑',
  ]);
}

function errTypeContent() {
  return pick([
    'Bị câm rồi! Không nhập được gì vào ô text hết 🤐',
    'Plot twist: ô nhập nội dung biến mất không dấu vết 🫠',
    'Facebook đang khóa miệng, không cho nhập chữ 🔇',
    'Ô text đang "cứng đầu" không nhận input 😤',
    'Viết gì đó không? Ô text không chịu hợp tác r 🤷',
  ]);
}

function errPost() {
  return pick([
    'Thôi xong! Facebook không cho submit bài hôm nay 💀',
    'Ăn hành to! Bài không chịu đăng lên 😭',
    'GG! Facebook đang "cứng đầu" không cho submit 🤡',
    'Plot twist cuối: bài viết không chịu lên sóng 🫠',
    'Cứu! Bài viết bị Facebook từ chối rồi 🆘',
    'Chấn thương tâm lý! Bài đã soạn xong mà không đăng được 💔',
  ]);
}

module.exports = {
  errPopupPersonal,
  errPopupGroup,
  errUpload,
  errTypeContent,
  errPost,
};
