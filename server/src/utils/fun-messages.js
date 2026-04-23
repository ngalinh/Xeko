function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function successPersonal() {
  return pick([
    'Đỉnh của chóp! Bài đã xịn xò lên trang cá nhân rồi 🔥',
    'GG ez! Bài cá nhân đã ra lò rồi nha babe 🎉',
    'Ngon lành cành đào! Feed cá nhân có hàng mới rồi ✨',
    'Siuuu! Đăng bài cá nhân thành công 100% 💅',
    'Vibe quá đi! Bài viết cá nhân đã chính thức ra mắt 🚀',
    'Ăn gọn! Bài đã lên trang cá nhân mượt như bơ 😎',
    'Chill thôi! Xong việc cá nhân rồi bro 💪',
    'No cap! Bài cá nhân đã đổ bộ thành công 🛸',
  ]);
}

function successGroup(groupName) {
  return pick([
    `Đỉnh! Group "${groupName}" đã có hàng mới rồi 🔥`,
    `GG! Đã thả bài vào group "${groupName}" rồi nha 🎊`,
    `Xịn sò! Bài đã đổ bộ group "${groupName}" thành công 💪`,
    `Siuuu! Group "${groupName}" vừa có bài mới nè 🎉`,
    `Ngon lành! Đã len lỏi vào group "${groupName}" rồi 🥷`,
    `Ổn áp! Group "${groupName}" đã nhận hàng rồi nhé ✅`,
    `Gọn gàng sạch sẽ! Bài đã nằm trong group "${groupName}" rồi 🫡`,
  ]);
}

function successAllGroup(count) {
  return pick([
    `Ăn trọn tất! Đã phủ sóng ${count} group cùng lúc 😎`,
    `Siuuu! Cả ${count} group đều có hàng mới rồi 🏆`,
    `Đỉnh của chóp! Đã thả bom vào ${count} group một lúc 💥`,
    `GG ez! ${count} group đều có bài mới ngon ơ 🎊`,
    `Ăn hết phần của người khác luôn! ${count} group xong xuôi rồi 💅`,
    `Phủ sóng toàn quốc! ${count} group đều đã dính bài 📡`,
  ]);
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

function errLimit(max) {
  return pick([
    `Hết cơm r! Đã đạt giới hạn ${max} bài/ngày rồi nhé 🛑`,
    `Nghỉ thôi bro! Hôm nay đăng đủ ${max} bài rồi 😴`,
    `Giới hạn ${max} bài/ngày đã bị ăn hết rồi, ngày mai tiếp nhé 🌙`,
    `No cap! ${max} bài/ngày là đủ rồi, đừng tham thêm 🙅`,
    `Đã chạm trần ${max} bài rồi bro, nghỉ ngơi đi 🏁`,
  ]);
}

function errProfileNotSet() {
  return pick([
    'Não cá vàng! Chưa chọn profile kìa bro 🐟',
    'Ủa chọn profile chưa vậy? Chưa thì chọn đi đã 😅',
    'Missing profile! Bước 1 là chọn profile đó nha 👀',
    'Chưa chọn profile thì đăng kiểu gì bây 🤦',
    'Hello? Profile đâu? Chọn profile trước đi bạn ơi 📢',
  ]);
}

function statusPosting(target) {
  return pick([
    `Đang thả bài vào ${target} rồi, chờ tí nha... ⏳`,
    `Đang xử lý đổ bộ vào ${target}, hold on... 🛸`,
    `Máy đang làm việc cật lực để đăng vào ${target} 💪`,
    `Đang bay vào ${target} rồi, chờ xíu... 🚀`,
  ]);
}

function statusDownloading(count) {
  return pick([
    `Đang tải ${count} ảnh về máy, xíu xong thôi... 📥`,
    `Kéo ${count} ảnh về rồi đăng liền nha ⬇️`,
    `Loading ${count} ảnh... Đừng tắt nha 🔄`,
  ]);
}

module.exports = {
  successPersonal,
  successGroup,
  successAllGroup,
  errPopupPersonal,
  errPopupGroup,
  errUpload,
  errTypeContent,
  errPost,
  errLimit,
  errProfileNotSet,
  statusPosting,
  statusDownloading,
};
