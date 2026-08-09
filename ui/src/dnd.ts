// MIME dùng chung cho thao tác kéo note từ sidebar thả vào canvas.
// Dùng kiểu riêng thay vì "text/plain" để canvas biết chắc dữ liệu đến từ tree
// của chính app, không phải chuỗi bất kỳ kéo từ nơi khác vào.
export const NOTE_DRAG_MIME = "application/x-second-brain-note";
