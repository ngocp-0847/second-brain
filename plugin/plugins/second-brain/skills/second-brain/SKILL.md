---
name: second-brain
description: Tra cứu và trả lời câu hỏi từ vault ghi chú Markdown của app Second Brain — tìm kiếm full-text/RAG, đọc note, đi theo wikilink/backlink, xem tag và đồ thị link. Dùng khi người dùng hỏi "trong vault có gì về X", "tôi từng ghi gì về Y", "tra trong second brain", "note nào liên quan đến Z", hoặc khi cần bối cảnh từ ghi chú cá nhân trước khi trả lời. Cũng dùng khi người dùng dán một đường dẫn note (vd `Projects/Alpha.md`).
---

# Second Brain — tra cứu vault

Vault là thư mục Markdown kiểu Obsidian. Mọi thao tác đi qua MCP server `second-brain`
(app tự chạy server này, không cần khởi động gì thêm).

## Quy ước đường dẫn

- Path **tương đối với gốc vault**, dùng `/`, có đuôi `.md` — vd `Projects/Alpha.md`.
- Wikilink `[[Tên note]]` trỏ theo **tên file không đuôi** (stem), không phải path đầy đủ.
- `.brain/`, `.obsidian/`, `.git/` là nội bộ — không đọc, không sửa.

## Quy trình chuẩn: tìm → đọc → trả lời

1. **`search_notes`** khi đã biết từ khóa cụ thể. BM25/FTS5, unicode61 nên tiếng Việt có
   dấu khớp tốt. Nhiều từ = AND. Mặc định mỗi note một dòng; `per_chunk=true` khi cần mọi
   đoạn khớp trong cùng note.
2. **`retrieve_context`** khi câu hỏi mang tính ngữ nghĩa, không rõ từ khóa. Trả về top-k
   trích đoạn **đầy đủ text** để tự tổng hợp. Truyền thêm `variants` (đồng nghĩa, Anh↔Việt)
   để tăng recall — đây là đòn bẩy lớn nhất cho chất lượng câu trả lời.
3. **`read_note`** để lấy trọn note khi trích đoạn chưa đủ.
4. Trả lời kèm **citation là path note**, để người dùng mở lại được.

**Đừng gọi `ask_vault`.** Tool đó tự spawn một LLM khác trên máy để trả lời hộ — chậm và
thừa khi chính bạn đã là LLM. Nó chỉ dành cho client không biết suy luận.

## Đi theo quan hệ

| Muốn biết | Tool |
|---|---|
| Note nào trỏ tới note này | `backlinks` |
| Note này trỏ đi đâu (kèm link gãy) | `outgoing_links` |
| Note liên quan mà **chưa** link nhau | `related_notes` |
| Chỗ nhắc tên note dạng plain text, chưa thành wikilink | `unlinked_mentions` |
| `[[Target]]` ứng với file nào | `resolve_link` |
| Toàn cảnh đồ thị | `graph` |

`related_notes` suy từ tag chung / cùng trích dẫn / trùng từ khóa tiêu đề và **loại bỏ**
note đã link trực tiếp — nên nó dùng để *phát hiện liên kết còn thiếu*, không phải để liệt
kê hàng xóm.

## Duyệt vault

- `vault_stats` — gốc vault, số note/link/tag, số wikilink gãy. Gọi đầu tiên khi chưa rõ
  vault có gì.
- `list_notes` — lọc `folder`, `sort: "mtime"` để lấy note sửa gần đây.
- `list_folders`, `tags` (không tham số = mọi tag kèm số note; có `tag` = note mang tag đó).
- `list_canvases` — file `.canvas` (JSON Canvas). Đọc nội dung bằng `read_note`.

## Ranh giới

- Skill này **đọc**. Khi cần ghi, xem `vault-capture`; khi cần dọn dẹp, xem `vault-janitor`.
- Không dùng `Read`/`Grep`/`Bash` để mò file trong vault — index FTS5 và bảng link của MCP
  luôn nhanh và đúng hơn, và tool ghi còn tự cập nhật index lẫn wikilink.
- Nếu server trả lỗi "read-only", vault đang được mở ở chế độ chỉ đọc — báo người dùng thay
  vì tìm đường vòng.
