---
name: vault-janitor
description: Dọn dẹp và kiểm tra sức khỏe vault Second Brain — link gãy, note mồ côi, unlinked mentions, tag trùng, note quá lớn — và duyệt từng proposal của janitor. Dùng khi người dùng nói "dọn vault", "check vault", "vault có link gãy không", "chạy janitor", "note nào mồ côi", "gộp tag trùng", hoặc muốn rà lại chất lượng ghi chú.
---

# Vault janitor — dọn dẹp Second Brain

Hai tầng: **kiểm tra thủ công** (tool đọc, không đổi gì) và **janitor** (lint có hệ thống,
sinh proposal chờ duyệt).

## Kiểm tra nhanh

Bắt đầu bằng `vault_stats` — có sẵn số wikilink gãy, đủ để biết vault có cần dọn không.

| Vấn đề | Tool đọc | Cách sửa |
|---|---|---|
| Wikilink trỏ tới note không tồn tại | `broken_links` | `fix_broken_link` (bad_target → new_target), hoặc `create_note` nếu note đó *nên* tồn tại |
| Note không backlink, không link đi | `orphans` | Thêm wikilink từ note liên quan, hoặc gộp vào note lớn hơn |
| Nhắc tên note dạng plain text, chưa link | `unlinked_mentions` | `replace_in_note` để bọc thành `[[…]]` |
| Tag gần giống nhau | `tags` | Thống nhất bằng `replace_in_note` |

`fix_broken_link` rewrite **mọi** wikilink gãy trỏ tới `bad_target` trong cả vault trong một
lần — đừng sửa lẻ từng file.

## Janitor

1. **`janitor_run`** — tự snapshot rồi lint deterministic (link gãy, mồ côi, stub cũ, tag
   trùng, note quá lớn), trả report kèm proposals. `tier2=true` gọi thêm LLM để sinh MOC —
   chậm, chỉ bật khi người dùng yêu cầu.
2. **`janitor_report`** — report lần chạy gần nhất kèm proposal còn pending và `action_id`.
3. **`janitor_apply`** / **`janitor_dismiss`** — duyệt hoặc bỏ qua từng `action_id`.

## Duyệt proposal: không tự động gật hết

Proposal của janitor là **đề xuất**, không phải kết luận. Trình bày cho người dùng theo nhóm
kèm hệ quả, rồi apply cái nào họ đồng ý. Cụ thể:

- **Đừng** lặp `janitor_apply` qua toàn bộ danh sách khi người dùng chỉ nói "dọn đi".
- Proposal xóa/gộp note là mất nội dung — luôn hỏi trước, kể cả khi có snapshot.
- Proposal sửa link gãy thường an toàn, nhưng vẫn nói rõ đã sửa những gì.

## An toàn

- `janitor_run` và mọi tool `destructive` đã tự snapshot vào `.brain/snapshots`. Muốn chắc
  hơn nữa thì gọi `snapshot` với `label` riêng trước khi bắt đầu.
- `trash_note` / `trash_folder` chuyển vào `.brain/trash`, khôi phục được — không có tool nào
  xóa thật.
- `reindex` hầu như không cần: mọi tool ghi đã tự index. Chỉ chạy khi có ai sửa file bên
  ngoài app.
