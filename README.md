# Second Brain

App quản lý tri thức local-first kiểu Obsidian, viết bằng Rust (Tauri 2) + SolidJS + CodeMirror 6.
Kiến trúc chi tiết: [ARCHITECTURE.md](ARCHITECTURE.md) · Design system (format [design.md](https://github.com/google-labs-code/design.md)): [DESIGN.md](DESIGN.md).

## Trạng thái

- ✅ **M0** — `vault-core` (parser wikilink tương thích Obsidian, SQLite cache, link graph, FTS5) + CLI `brain`
- ✅ **M1** — App desktop: file tree, editor live-preview, `[[` autocomplete, backlinks panel, omnibar (Ctrl+K), rename-refactor (đổi tên note tự rewrite mọi link trỏ tới), trash an toàn
- ✅ **M2** — Search từ khóa BM25 (FTS5, tokenizer `unicode61` nên gõ tiếng Việt có dấu vẫn khớp), đồng bộ và tức thì; related notes suy ra từ chính graph vault (tag chung / cùng trích dẫn / trùng từ khóa, thuần SQL); unlinked mentions. CLI: `brain search`, `brain related`
- ✅ **M3** — Hỏi đáp trên vault: `?` trong omnibar (hoặc `brain ask`). Reasoning search: Claude mở rộng truy vấn (đồng nghĩa, Anh↔Việt) → retrieve BM25 trên câu gốc + các biến thể, trộn RRF → trả lời kèm citation `[[note]]` bấm được, từ chối khi vault thiếu thông tin, nút "Lưu thành note". LLM qua Claude Code CLI headless / Codex CLI (tự phát hiện, không cần API key).
- ✅ **M4** — Janitor tầng 1: git snapshot vào `.brain/snapshots` trước mỗi lần chạy; lint deterministic (broken link fuzzy-fix, orphan, stub cũ, tag trùng hoa thường, note quá lớn); mức tự trị propose/suggest với nút Áp dụng/Bỏ qua trong app; scheduler tự chạy mỗi 24h khi app mở; CLI `brain janitor [--apply-proposals]` cho Task Scheduler. Settings ⚙ chọn LLM provider (auto/claude/codex).
- ✅ **M6 (một phần)** — Obsidian parity: ribbon icon dọc; quick switcher "find or create" (Ctrl+K/O); **graph view** force-directed tự viết (Ctrl+G, kéo node, zoom, click mở note); **daily note** (📅 → `Daily/YYYY-MM-DD.md`); **canvas** tương thích định dạng JSON Canvas của Obsidian (card text/note, pan/zoom, tự lưu)
- ✅ **M5** — Janitor tầng 2 (LLM): sinh MOC `_index.md` cho folder lớn (phần user viết tay được bảo toàn trên marker), luôn ở mức đề xuất chờ duyệt. Canvas nâng cấp: edge bezier có mũi tên + kéo chấm nối để tạo link, card có màu (chuẩn JSON Canvas), toolbar nổi đổi màu/xóa, toolbar icon SVG. CLI: `brain janitor --tier2`.
- ✅ **MCP server** — vault expose đầy đủ qua [Model Context Protocol](https://modelcontextprotocol.io) (stdio) để Claude Code, Codex, Cursor… tìm/đọc/sửa/đổi tên (tự rewrite wikilink)/janitor trên vault bằng tool có cấu trúc. Settings ⚙ → MCP: đăng ký một nút với `claude` / `codex`; terminal và chat agent trong app được cắm sẵn. Xem [MCP](#mcp--cho-agent-ngoài).
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
brain index | search <từ khóa> | backlinks <note> | broken | orphans | watch | mcp [--read-only]
```

## MCP — cho agent ngoài

Vault là một MCP server (transport stdio, JSON-RPC newline-delimited, spec `2025-06-18`, tự hạ về `2025-03-26` / `2024-11-05` theo client). Có hai cách chạy server, cùng một code:

```sh
# 1) app đã cài — chính file exe của app là server (không cần binary khác)
"Second Brain.exe" --mcp --vault <đường-dẫn-vault> [--read-only] [--llm auto|claude|codex]

# 2) CLI
brain mcp --vault <đường-dẫn-vault> [--read-only]
```

**Đăng ký nhanh:** Settings ⚙ → *MCP server* → **Đăng ký** cho Claude Code / Codex (scope user, dùng được ở mọi thư mục). Lệnh tay tương đương:

```sh
claude mcp add --scope user second-brain -- "<exe>" --mcp --vault "<vault>"
codex  mcp add second-brain -- "<exe>" --mcp --vault "<vault>"
```

Client khác (Cursor, Windsurf, Claude Desktop…) dùng JSON:

```json
{ "mcpServers": { "second-brain": { "command": "<exe>", "args": ["--mcp", "--vault", "<vault>"] } } }
```

Trong app: terminal 🖥 vào thẳng `claude --mcp-config .brain/mcp.json` và chat agent headless cũng được cắm server, nên Claude Code chạy từ app luôn có tool của vault mà không cần đăng ký gì.

**Tools** (35, mỗi tool có JSON Schema + annotations `readOnlyHint`/`destructiveHint`):

| Nhóm | Tool |
|---|---|
| Đọc / tìm | `vault_stats` `list_notes` `list_folders` `read_note` `search_notes` `retrieve_context` `backlinks` `outgoing_links` `related_notes` `unlinked_mentions` `broken_links` `orphans` `tags` `resolve_link` `graph` `list_canvases` `ask_vault` |
| Ghi / sửa | `create_note` `write_note` `append_note` (theo heading) `replace_in_note` (khớp chính xác, chặn khớp nhiều chỗ) `rename_note` (**rewrite mọi wikilink**) `duplicate_note` `trash_note` `create_folder` `rename_folder` `trash_folder` `fix_broken_link` `daily_note` |
| Bảo trì | `reindex` `snapshot` (git) `janitor_run` `janitor_report` `janitor_apply` `janitor_dismiss` |

**Resources:** `brain://note/{path}` (text/markdown, phân trang), `brain://vault/stats`, `brain://vault/graph`, `brain://vault/broken-links`.
**Prompts:** `summarize_note`, `suggest_links`, `answer_from_vault` (RAG — server retrieve, client tự sinh), `review_note`.

An toàn: mọi thao tác ghi đi qua `vault-core` như app (xóa = `.brain/trash`, re-index tăng dần); trash/rename/folder snapshot git trước; chặn `..` và `.brain/` `.git/` `.obsidian/`; `--read-only` ẩn toàn bộ tool ghi. App và server dùng chung `cache.db` (WAL + busy_timeout) nên chạy song song được.

## Kiến trúc thư mục

```
crates/vault-core   # parse, index, link graph — dùng chung cho CLI, app, janitor, mcp
crates/mcp          # MCP server (stdio): tools / resources / prompts trên vault-core
crates/brain-cli    # binary `brain` (có `brain mcp`)
src-tauri           # shell Tauri, expose vault-core qua commands; `--mcp` chạy server thay GUI
ui                  # SolidJS + CodeMirror 6
```

Mọi dữ liệu app sinh ra nằm trong `.brain/` của vault (cache.db, trash) — xóa được, tái tạo được, không đụng vào file .md của bạn.
