---
name: vault-capture
description: Ghi thông tin vào vault Second Brain đúng quy ước — tạo note mới, nối vào note có sẵn, ghi daily note, đổi tên/di chuyển note kèm rewrite wikilink. Dùng khi người dùng nói "lưu vào second brain", "ghi note lại", "thêm vào vault", "note lại kết quả này", "đưa vào daily note", "đổi tên note X", hoặc khi vừa điều tra xong việc gì và người dùng muốn giữ lại kết quả.
---

# Vault capture — ghi vào Second Brain

Ghi qua MCP server `second-brain`. Mọi tool ghi đều tự cập nhật index và tự tạo thư mục cha.

## Trước khi ghi: kiểm tra trùng

Luôn `search_notes` (hoặc `resolve_link`) trước khi tạo note mới. Vault cá nhân rất dễ sinh
note trùng chủ đề, và note trùng thì tệ hơn note dài. Đã có note phù hợp → **nối thêm**,
đừng tạo cái mới.

## Chọn đúng tool ghi

| Tình huống | Tool |
|---|---|
| Chủ đề mới, chưa có note | `create_note` (lỗi nếu path đã tồn tại — đó là chủ ý) |
| Bổ sung vào note có sẵn | `append_note` (có `heading` để nối vào đúng section) |
| Sửa một đoạn cụ thể | `replace_in_note` |
| Vừa đọc trọn note và viết lại toàn bộ | `write_note` |
| Ghi nhanh theo ngày | `daily_note` rồi `append_note` |
| Đổi tên / chuyển thư mục | `rename_note` |

**`rename_note` là bắt buộc** khi đổi tên hoặc di chuyển — nó rewrite mọi wikilink trỏ tới
note đó trong cả vault. Dùng `mv`, `Bash`, hay `write_note` + `trash_note` sẽ làm gãy link
âm thầm.

`replace_in_note` khớp **chính xác** và báo lỗi khi `old` khớp nhiều chỗ. Gặp lỗi đó thì mở
rộng `old` cho đủ ngữ cảnh, đừng bật `all=true` trừ khi thật sự muốn thay hết.

## Quy ước nội dung

- Path tương đối, dùng `/`, đuôi `.md`: `Projects/Alpha.md`.
- Mỗi note một `# H1` ở đầu, trùng với tên file.
- Liên kết bằng `[[Tên note]]` — **stem của file**, không phải path. Kiểm tra bằng
  `resolve_link` trước khi viết wikilink tới note bạn không chắc có tồn tại; link gãy sẽ
  hiện trong `broken_links`.
- Tag dạng `#tag` trong thân note. Xem `tags` để tái dùng tag đã có thay vì đẻ tag gần giống.
- Viết bằng ngôn ngữ người dùng dùng khi yêu cầu.

## Ghi hàng loạt

Trước khi sửa nhiều note trong một lượt, gọi `snapshot` (commit vào repo ẩn
`.brain/snapshots`) để rollback được. `trash_note` / `trash_folder` đã tự snapshot và chỉ
chuyển vào `.brain/trash` — không xóa thật.

## Ranh giới

- Không ghi vào `.brain/`, `.obsidian/`, `.git/`.
- Không tạo note "tóm tắt phiên làm việc" trừ khi được yêu cầu — vault là của người dùng,
  không phải log của agent.
- Tra cứu trước khi ghi: xem skill `second-brain`.
