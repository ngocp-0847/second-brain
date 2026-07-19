# Second Brain

App quản lý tri thức local-first kiểu Obsidian, viết bằng Rust (Tauri 2) + SolidJS + CodeMirror 6.
Thiết kế chi tiết: xem [DESIGN.md](DESIGN.md).

## Trạng thái

- ✅ **M0** — `vault-core` (parser wikilink tương thích Obsidian, SQLite cache, link graph, FTS5) + CLI `brain`
- ✅ **M1** — App desktop: file tree, editor live-preview, `[[` autocomplete, backlinks panel, omnibar (Ctrl+K), rename-refactor (đổi tên note tự rewrite mọi link trỏ tới), trash an toàn
- ✅ **M2** — Hybrid search: BM25 (FTS5) + vector (sqlite-vec + fastembed `multilingual-e5-small`, chạy local) trộn bằng RRF; related notes; unlinked mentions; embedding nền không block UI. CLI: `brain embed`, `brain search --semantic`, `brain related`
- ✅ **M3** — Hỏi đáp trên vault: `?` trong omnibar (hoặc `brain ask`). Reasoning search: Claude mở rộng truy vấn (đồng nghĩa, Anh↔Việt) → retrieve hybrid → trả lời kèm citation `[[note]]` bấm được, từ chối khi vault thiếu thông tin, nút "Lưu thành note". LLM qua Claude Code CLI headless / Codex CLI (tự phát hiện, không cần API key). Model embedding chỉ nạp khi cần và tự giải phóng RAM sau 5 phút idle.
- ✅ **M4** — Janitor tầng 1: git snapshot vào `.brain/snapshots` trước mỗi lần chạy; lint deterministic (broken link fuzzy-fix, orphan, stub cũ, tag trùng hoa thường, note quá lớn); mức tự trị propose/suggest với nút Áp dụng/Bỏ qua trong app; scheduler tự chạy mỗi 24h khi app mở; CLI `brain janitor [--apply-proposals]` cho Task Scheduler. Settings ⚙ chọn LLM provider (auto/claude/codex).
- ✅ **M6 (một phần)** — Obsidian parity: ribbon icon dọc; quick switcher "find or create" (Ctrl+K/O); **graph view** force-directed tự viết (Ctrl+G, kéo node, zoom, click mở note); **daily note** (📅 → `Daily/YYYY-MM-DD.md`); **canvas** tương thích định dạng JSON Canvas của Obsidian (card text/note, pan/zoom, tự lưu)
- ⬜ **M5** — Janitor tầng 2: LLM restructure folder, sinh MOC
- ⬜ Còn lại: tabs, themes, installer NSIS

## Yêu cầu

- Rust stable (MSVC trên Windows) + VS Build Tools
- Node.js LTS
- WebView2 (có sẵn trên Windows 11)

## Chạy dev

```sh
npm install
npx tauri dev
```

## CLI

```sh
cargo run --release --bin brain -- --vault <đường-dẫn-vault> stats
brain index | search <từ khóa> | backlinks <note> | broken | orphans | watch
```

## Kiến trúc thư mục

```
crates/vault-core   # parse, index, link graph — dùng chung cho CLI, app, janitor
crates/brain-cli    # binary `brain`
src-tauri           # shell Tauri, expose vault-core qua commands
ui                  # SolidJS + CodeMirror 6
```

Mọi dữ liệu app sinh ra nằm trong `.brain/` của vault (cache.db, trash) — xóa được, tái tạo được, không đụng vào file .md của bạn.
