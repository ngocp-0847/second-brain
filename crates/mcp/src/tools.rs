//! `tools/*`: bề mặt thao tác đầy đủ của vault cho agent — đọc/tìm, ghi/sửa,
//! tái cấu trúc (rename rewrite link), bảo trì (index, snapshot, janitor), RAG.
//!
//! Mọi tool ghi đi qua `vault-core` như app: rename rewrite wikilink, xóa vào
//! `.brain/trash`, re-index tăng dần sau mỗi lần ghi. Thao tác phá hủy (trash,
//! rename, folder) snapshot git best-effort trước khi làm.

use crate::{opt_bool, opt_str, opt_usize, req_str, Options, Server, ToolError};
use anyhow::{anyhow, Result};

/// `bail!` cho hàm trả `ToolError` (lỗi thực thi → isError trong result).
macro_rules! tbail {
    ($($t:tt)*) => { return Err(ToolError::Exec(anyhow!($($t)*))) };
}
use serde_json::{json, Value};

struct Tool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    schema: fn() -> Value,
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

const PATH_DESC: &str = "Đường dẫn tương đối trong vault, dùng `/`, có đuôi `.md` (vd `Projects/Alpha.md`).";

const TOOLS: &[Tool] = &[
    // ---------- đọc / tìm ----------
    Tool {
        name: "vault_stats", title: "Thống kê vault", read_only: true, destructive: false, idempotent: true,
        description: "Gốc vault, số note/link/tag/chunk, số wikilink gãy, FTS5 có bật không.",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "list_notes", title: "Liệt kê note", read_only: true, destructive: false, idempotent: true,
        description: "Danh sách note (path, title, mtime). Lọc theo thư mục, sắp theo path hoặc mtime (mới nhất trước), phân trang offset/limit.",
        schema: || obj(json!({
            "folder": { "type": "string", "description": "Chỉ lấy note trong thư mục này (vd `Projects`). Bỏ trống = cả vault." },
            "sort": { "type": "string", "enum": ["path", "mtime"], "default": "path" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 200 },
            "offset": { "type": "integer", "minimum": 0, "default": 0 }
        }), &[]),
    },
    Tool {
        name: "list_folders", title: "Liệt kê thư mục", read_only: true, destructive: false, idempotent: true,
        description: "Mọi thư mục con trong vault (kể cả thư mục rỗng), bỏ .brain/.obsidian/.git.",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "read_note", title: "Đọc note", read_only: true, destructive: false, idempotent: true,
        description: "Nội dung đầy đủ của một note (hoặc file text bất kỳ trong vault như .canvas) kèm title, mtime, size, tags, outgoing links.",
        schema: || obj(json!({ "path": { "type": "string", "description": PATH_DESC } }), &["path"]),
    },
    Tool {
        name: "search_notes", title: "Tìm kiếm", read_only: true, destructive: false, idempotent: true,
        description: "Full-text search BM25 (FTS5, unicode61 — tiếng Việt có dấu khớp tốt). Mặc định mỗi note một kết quả (chunk khớp nhất); `per_chunk=true` để lấy mọi chunk khớp. Trả path, heading_path, start_line, snippet (khớp bọc trong »«).",
        schema: || obj(json!({
            "query": { "type": "string", "description": "Từ khóa; nhiều từ = AND." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 },
            "per_chunk": { "type": "boolean", "default": false }
        }), &["query"]),
    },
    Tool {
        name: "retrieve_context", title: "Retrieve trích đoạn (RAG)", read_only: true, destructive: false, idempotent: true,
        description: "Lấy top-k trích đoạn ĐẦY ĐỦ TEXT liên quan nhất tới câu hỏi để bạn tự trả lời (BM25 + RRF trên câu gốc và các biến thể bạn cung cấp). Rẻ và nhanh hơn ask_vault vì không gọi LLM.",
        schema: || obj(json!({
            "question": { "type": "string" },
            "variants": { "type": "array", "items": { "type": "string" }, "description": "Truy vấn thay thế (đồng nghĩa, Anh↔Việt) để tăng recall." },
            "k": { "type": "integer", "minimum": 1, "maximum": 30, "default": 6 }
        }), &["question"]),
    },
    Tool {
        name: "backlinks", title: "Backlinks", read_only: true, destructive: false, idempotent: true,
        description: "Các note đang link tới note này (nhận path, title hoặc tên file không đuôi).",
        schema: || obj(json!({ "note": { "type": "string" } }), &["note"]),
    },
    Tool {
        name: "outgoing_links", title: "Link đi", read_only: true, destructive: false, idempotent: true,
        description: "Mọi wikilink/embed/markdown link trong note: target gốc, path đã resolve (null = gãy), kind, heading.",
        schema: || obj(json!({ "path": { "type": "string", "description": PATH_DESC } }), &["path"]),
    },
    Tool {
        name: "related_notes", title: "Note liên quan", read_only: true, destructive: false, idempotent: true,
        description: "Note liên quan suy từ graph (tag chung, cùng trích dẫn, trùng từ khóa tiêu đề), kèm lý do. Note đã link trực tiếp bị loại.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 8 }
        }), &["path"]),
    },
    Tool {
        name: "unlinked_mentions", title: "Unlinked mentions", read_only: true, destructive: false, idempotent: true,
        description: "Chỗ trong vault nhắc tên note này dạng plain text mà chưa có wikilink.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
        }), &["path"]),
    },
    Tool {
        name: "broken_links", title: "Link gãy", read_only: true, destructive: false, idempotent: true,
        description: "Mọi wikilink/markdown link trỏ tới note không tồn tại (src_path, target, kind).",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "orphans", title: "Note mồ côi", read_only: true, destructive: false, idempotent: true,
        description: "Note không có backlink và không link đi đâu.",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "tags", title: "Tags", read_only: true, destructive: false, idempotent: true,
        description: "Không tham số: mọi tag kèm số note. Có `tag`: danh sách note mang tag đó.",
        schema: || obj(json!({ "tag": { "type": "string", "description": "Tag không có dấu #." } }), &[]),
    },
    Tool {
        name: "resolve_link", title: "Resolve wikilink", read_only: true, destructive: false, idempotent: true,
        description: "Target của một wikilink (`Tên note`, `folder/note`) → path thật trong vault, null nếu không có.",
        schema: || obj(json!({ "target": { "type": "string" } }), &["target"]),
    },
    Tool {
        name: "graph", title: "Đồ thị link", read_only: true, destructive: false, idempotent: true,
        description: "Toàn bộ đồ thị wikilink: nodes (path, title, degree) và edges (from, to).",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "list_canvases", title: "Liệt kê canvas", read_only: true, destructive: false, idempotent: true,
        description: "Mọi file .canvas (JSON Canvas tương thích Obsidian) trong vault. Đọc bằng read_note.",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "ask_vault", title: "Hỏi đáp RAG qua LLM", read_only: true, destructive: false, idempotent: true,
        description: "Hỏi đáp trọn gói: mở rộng truy vấn + retrieve + sinh câu trả lời có citation bằng agent CLI (Claude Code / Codex) trên máy. CHẬM (gọi LLM). Nếu bạn là LLM, dùng retrieve_context rồi tự trả lời.",
        schema: || obj(json!({ "question": { "type": "string" } }), &["question"]),
    },
    // ---------- ghi / sửa ----------
    Tool {
        name: "create_note", title: "Tạo note", read_only: false, destructive: false, idempotent: false,
        description: "Tạo note mới (tự thêm .md, tự tạo thư mục). Lỗi nếu đã tồn tại. Không có content → `# <tên>` mặc định.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "content": { "type": "string" }
        }), &["path"]),
    },
    Tool {
        name: "write_note", title: "Ghi đè note", read_only: false, destructive: true, idempotent: true,
        description: "Ghi toàn bộ nội dung file (tạo mới nếu chưa có). Dùng cho file vừa đọc trọn; sửa nhỏ nên dùng replace_in_note/append_note.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "content": { "type": "string" }
        }), &["path", "content"]),
    },
    Tool {
        name: "append_note", title: "Nối thêm", read_only: false, destructive: false, idempotent: false,
        description: "Nối content vào cuối note, hoặc vào cuối section của `heading` (khớp text heading, không phân biệt hoa thường). `create=true` để tạo note nếu chưa có.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "content": { "type": "string" },
            "heading": { "type": "string", "description": "Text heading (không có dấu #)." },
            "create": { "type": "boolean", "default": false }
        }), &["path", "content"]),
    },
    Tool {
        name: "replace_in_note", title: "Thay thế trong note", read_only: false, destructive: true, idempotent: false,
        description: "Thay chuỗi `old` bằng `new` (khớp chính xác). Lỗi nếu không khớp hoặc khớp nhiều chỗ mà không có `all=true` — mở rộng `old` cho đủ ngữ cảnh.",
        schema: || obj(json!({
            "path": { "type": "string", "description": PATH_DESC },
            "old": { "type": "string" },
            "new": { "type": "string" },
            "all": { "type": "boolean", "default": false }
        }), &["path", "old", "new"]),
    },
    Tool {
        name: "rename_note", title: "Đổi tên / di chuyển note", read_only: false, destructive: true, idempotent: false,
        description: "Đổi tên hoặc di chuyển note và REWRITE mọi wikilink trỏ tới nó trong cả vault. Luôn dùng tool này thay vì mv.",
        schema: || obj(json!({
            "from": { "type": "string", "description": PATH_DESC },
            "to": { "type": "string", "description": "Path mới (tự thêm .md)." }
        }), &["from", "to"]),
    },
    Tool {
        name: "duplicate_note", title: "Nhân bản note", read_only: false, destructive: false, idempotent: false,
        description: "Sao chép note sang tên chưa bị chiếm (`Tên 1.md`, `Tên 2.md`…).",
        schema: || obj(json!({ "path": { "type": "string", "description": PATH_DESC } }), &["path"]),
    },
    Tool {
        name: "trash_note", title: "Xóa note (thùng rác)", read_only: false, destructive: true, idempotent: false,
        description: "Chuyển note vào .brain/trash (khôi phục được), snapshot git trước. Không bao giờ xóa thật.",
        schema: || obj(json!({ "path": { "type": "string", "description": PATH_DESC } }), &["path"]),
    },
    Tool {
        name: "create_folder", title: "Tạo thư mục", read_only: false, destructive: false, idempotent: false,
        description: "Tạo thư mục (đệ quy). Lỗi nếu đã tồn tại.",
        schema: || obj(json!({ "path": { "type": "string" } }), &["path"]),
    },
    Tool {
        name: "rename_folder", title: "Đổi tên thư mục", read_only: false, destructive: true, idempotent: false,
        description: "Đổi tên/di chuyển thư mục rồi re-index. Wikilink theo tên file vẫn resolve; link theo path tuyệt đối sẽ hiện ở broken_links nếu gãy.",
        schema: || obj(json!({ "from": { "type": "string" }, "to": { "type": "string" } }), &["from", "to"]),
    },
    Tool {
        name: "trash_folder", title: "Xóa thư mục (thùng rác)", read_only: false, destructive: true, idempotent: false,
        description: "Chuyển nguyên thư mục vào .brain/trash, snapshot git trước.",
        schema: || obj(json!({ "path": { "type": "string" } }), &["path"]),
    },
    Tool {
        name: "fix_broken_link", title: "Sửa link gãy", read_only: false, destructive: true, idempotent: true,
        description: "Mọi wikilink gãy trỏ tới `bad_target` được rewrite sang note `new_target` (đang tồn tại).",
        schema: || obj(json!({ "bad_target": { "type": "string" }, "new_target": { "type": "string" } }), &["bad_target", "new_target"]),
    },
    Tool {
        name: "daily_note", title: "Daily note", read_only: false, destructive: false, idempotent: true,
        description: "Mở (tạo nếu chưa có) daily note `Daily/YYYY-MM-DD.md` — giống nút 📅 trong app. Mặc định hôm nay theo giờ máy.",
        schema: || obj(json!({ "date": { "type": "string", "description": "YYYY-MM-DD" } }), &[]),
    },
    // ---------- bảo trì ----------
    Tool {
        name: "reindex", title: "Re-index", read_only: false, destructive: false, idempotent: true,
        description: "Quét vault và index tăng dần (chỉ file đổi). Thường không cần: mọi tool ghi đã tự index.",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "snapshot", title: "Git snapshot", read_only: false, destructive: false, idempotent: false,
        description: "Commit toàn vault vào repo ẩn .brain/snapshots để rollback được. Gọi trước khi sửa hàng loạt.",
        schema: || obj(json!({ "label": { "type": "string", "default": "mcp" } }), &[]),
    },
    Tool {
        name: "janitor_run", title: "Chạy janitor", read_only: false, destructive: false, idempotent: false,
        description: "Snapshot + lint deterministic (link gãy, mồ côi, stub cũ, tag trùng, note quá lớn) → report với proposals chờ duyệt. `tier2=true` gọi LLM sinh MOC (chậm).",
        schema: || obj(json!({ "tier2": { "type": "boolean", "default": false } }), &[]),
    },
    Tool {
        name: "janitor_report", title: "Report janitor", read_only: true, destructive: false, idempotent: true,
        description: "Report lần chạy gần nhất kèm mọi proposal còn pending (id để apply/dismiss).",
        schema: || obj(json!({}), &[]),
    },
    Tool {
        name: "janitor_apply", title: "Duyệt proposal", read_only: false, destructive: true, idempotent: false,
        description: "Áp dụng một proposal đang pending (snapshot trước).",
        schema: || obj(json!({ "action_id": { "type": "integer" } }), &["action_id"]),
    },
    Tool {
        name: "janitor_dismiss", title: "Bỏ qua proposal", read_only: false, destructive: false, idempotent: true,
        description: "Đánh dấu proposal là bỏ qua.",
        schema: || obj(json!({ "action_id": { "type": "integer" } }), &["action_id"]),
    },
];

pub(crate) fn list(opts: &Options) -> Vec<Value> {
    TOOLS
        .iter()
        .filter(|t| !opts.read_only || t.read_only)
        .map(|t| {
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": {
                    "title": t.title,
                    "readOnlyHint": t.read_only,
                    "destructiveHint": t.destructive,
                    "idempotentHint": t.idempotent,
                    "openWorldHint": false
                }
            })
        })
        .collect()
}

pub(crate) fn is_read_only(name: &str) -> bool {
    TOOLS.iter().any(|t| t.name == name && t.read_only)
}

pub(crate) fn call(s: &mut Server, name: &str, a: &Value) -> Result<Value, ToolError> {
    let v = match name {
        "vault_stats" => vault_stats(s)?,
        "list_notes" => list_notes(s, a)?,
        "list_folders" => {
            let mut dirs = s.vault.list_dirs();
            dirs.sort();
            json!({ "folders": dirs })
        }
        "read_note" => read_note(s, req_str(a, "path")?)?,
        "search_notes" => {
            let q = req_str(a, "query")?;
            let limit = opt_usize(a, "limit", 20).clamp(1, 200);
            let hits = if opt_bool(a, "per_chunk", false) {
                s.vault.db.search(q, limit)?
            } else {
                s.vault.db.search_notes(q, limit)?
            };
            json!({ "query": q, "hits": hits.iter().map(hit_json).collect::<Vec<_>>() })
        }
        "retrieve_context" => {
            let q = req_str(a, "question")?;
            let variants: Vec<String> = a["variants"]
                .as_array()
                .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let k = opt_usize(a, "k", 6).clamp(1, 30);
            let chunks = qa::retrieve(&s.vault.db, q, &variants, k)?;
            json!({
                "question": q,
                "chunks": chunks.iter().map(|c| json!({
                    "path": c.path, "heading_path": c.heading_path,
                    "start_line": c.start_line, "text": c.text,
                    "citation": citation(&c.path, &c.heading_path)
                })).collect::<Vec<_>>()
            })
        }
        "backlinks" => {
            let note = req_str(a, "note")?.replace('\\', "/");
            let rows = s.vault.db.backlinks(&note)?;
            json!({
                "note": note,
                "backlinks": rows.iter().map(|b| json!({
                    "src_path": b.src_path, "src_title": b.src_title, "kind": b.kind
                })).collect::<Vec<_>>()
            })
        }
        "outgoing_links" => {
            let (rel, _) = s.abs(req_str(a, "path")?)?;
            json!({ "path": rel, "links": outgoing_links(s, &rel)? })
        }
        "related_notes" => {
            let (rel, _) = s.abs(req_str(a, "path")?)?;
            let rows = s.vault.db.related_notes(&rel, opt_usize(a, "limit", 8).clamp(1, 50))?;
            json!({
                "path": rel,
                "related": rows.iter().map(|r| json!({ "path": r.path, "title": r.title, "reason": r.reason })).collect::<Vec<_>>()
            })
        }
        "unlinked_mentions" => {
            let (rel, _) = s.abs(req_str(a, "path")?)?;
            let hits = s.vault.db.unlinked_mentions(&rel, opt_usize(a, "limit", 20).clamp(1, 100))?;
            json!({ "path": rel, "mentions": hits.iter().map(hit_json).collect::<Vec<_>>() })
        }
        "broken_links" => broken_links(s)?,
        "orphans" => {
            let rows = s.vault.db.orphans()?;
            json!({ "orphans": rows.iter().map(|(p, t)| json!({ "path": p, "title": t })).collect::<Vec<_>>() })
        }
        "tags" => tags(s, opt_str(a, "tag"))?,
        "resolve_link" => {
            let t = req_str(a, "target")?;
            json!({ "target": t, "path": s.vault.db.resolve_target(t)? })
        }
        "graph" => graph(s)?,
        "list_canvases" => json!({ "canvases": list_canvases(s) }),
        "ask_vault" => ask_vault(s, req_str(a, "question")?)?,

        "create_note" => {
            let rel = with_md(&s.guard_rel(req_str(a, "path")?)?);
            let abs = s.vault.abs_path(&rel)?;
            if abs.exists() {
                tbail!("đã tồn tại: {rel}");
            }
            let stem = std::path::Path::new(&rel)
                .file_stem()
                .and_then(|x| x.to_str())
                .unwrap_or("Untitled");
            let content = opt_str(a, "content")
                .map(String::from)
                .unwrap_or_else(|| format!("# {stem}\n\n"));
            write_file(&abs, &content)?;
            s.vault.index()?;
            json!({ "path": rel, "created": true, "bytes": content.len() })
        }
        "write_note" => {
            let (rel, abs) = s.abs(req_str(a, "path")?)?;
            let content = a["content"].as_str().ok_or_else(|| ToolError::Args("thiếu `content`".into()))?;
            let created = !abs.exists();
            write_file(&abs, content)?;
            s.vault.index()?;
            json!({ "path": rel, "created": created, "bytes": content.len() })
        }
        "append_note" => append_note(s, a)?,
        "replace_in_note" => {
            let (rel, abs) = s.abs(req_str(a, "path")?)?;
            let old = a["old"].as_str().filter(|x| !x.is_empty()).ok_or_else(|| ToolError::Args("thiếu `old`".into()))?;
            let new = a["new"].as_str().ok_or_else(|| ToolError::Args("thiếu `new`".into()))?;
            let content = std::fs::read_to_string(&abs).map_err(|e| anyhow!("không đọc được {rel}: {e}"))?;
            let n = content.matches(old).count();
            if n == 0 {
                tbail!("không tìm thấy `old` trong {rel}");
            }
            if n > 1 && !opt_bool(a, "all", false) {
                tbail!("`old` khớp {n} chỗ trong {rel} — mở rộng ngữ cảnh hoặc truyền all=true");
            }
            let out = if n > 1 { content.replace(old, new) } else { content.replacen(old, new, 1) };
            write_file(&abs, &out)?;
            s.vault.index()?;
            json!({ "path": rel, "replaced": n })
        }
        "rename_note" => {
            let from = s.guard_rel(req_str(a, "from")?)?;
            let to = with_md(&s.guard_rel(req_str(a, "to")?)?);
            let snap = janitor::snapshot(&s.vault.root, &format!("mcp: rename {from} → {to}")).unwrap_or(false);
            let n = s.vault.rename_note(&from, &to)?;
            json!({ "from": from, "to": to, "links_rewritten": n, "snapshotted": snap })
        }
        "duplicate_note" => {
            let (rel, _) = s.abs(req_str(a, "path")?)?;
            json!({ "source": rel, "copy": s.vault.duplicate_note(&rel)? })
        }
        "trash_note" => {
            let (rel, abs) = s.abs(req_str(a, "path")?)?;
            if !abs.is_file() {
                tbail!("không tìm thấy note: {rel}");
            }
            let snap = janitor::snapshot(&s.vault.root, &format!("mcp: trash {rel}")).unwrap_or(false);
            s.vault.trash_note(&rel)?;
            json!({ "path": rel, "trashed": true, "snapshotted": snap, "trash_dir": ".brain/trash" })
        }
        "create_folder" => {
            let (rel, abs) = s.abs(req_str(a, "path")?)?;
            if abs.exists() {
                tbail!("đã tồn tại: {rel}");
            }
            std::fs::create_dir_all(&abs)?;
            json!({ "path": rel, "created": true })
        }
        "rename_folder" => {
            let from = s.guard_rel(req_str(a, "from")?)?;
            let to = s.guard_rel(req_str(a, "to")?)?;
            let snap = janitor::snapshot(&s.vault.root, &format!("mcp: rename dir {from} → {to}")).unwrap_or(false);
            s.vault.rename_dir(&from, &to)?;
            json!({ "from": from, "to": to, "snapshotted": snap })
        }
        "trash_folder" => {
            let (rel, _) = s.abs(req_str(a, "path")?)?;
            let snap = janitor::snapshot(&s.vault.root, &format!("mcp: trash dir {rel}")).unwrap_or(false);
            s.vault.trash_dir(&rel)?;
            json!({ "path": rel, "trashed": true, "snapshotted": snap })
        }
        "fix_broken_link" => {
            let bad = req_str(a, "bad_target")?;
            let new = req_str(a, "new_target")?;
            let n = s.vault.fix_link_target(bad, new)?;
            json!({ "bad_target": bad, "new_target": new, "links_fixed": n })
        }
        "daily_note" => {
            let date = match opt_str(a, "date") {
                Some(d) => {
                    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| ToolError::Args("date phải là YYYY-MM-DD".into()))?;
                    d.to_string()
                }
                None => chrono::Local::now().format("%Y-%m-%d").to_string(),
            };
            let rel = format!("Daily/{date}.md");
            let abs = s.vault.abs_path(&rel)?;
            let created = !abs.exists();
            if created {
                write_file(&abs, &format!("# {date}\n\n"))?;
                s.vault.index()?;
            }
            let content = std::fs::read_to_string(&abs)?;
            json!({ "path": rel, "created": created, "content": content })
        }

        "reindex" => {
            let st = s.vault.index()?;
            json!({ "scanned": st.scanned, "updated": st.updated, "removed": st.removed, "duration_ms": st.duration_ms as u64 })
        }
        "snapshot" => {
            let label = opt_str(a, "label").unwrap_or("mcp");
            let ok = janitor::snapshot(&s.vault.root, label)?;
            json!({ "snapshotted": ok, "note": if ok { "đã commit vào .brain/snapshots" } else { "không có git trên PATH" } })
        }
        "janitor_run" => {
            let mut report = janitor::run(&mut s.vault)?;
            if opt_bool(a, "tier2", false) {
                let provider = qa::provider_from_pref(&s.opts.llm_pref)
                    .ok_or_else(|| anyhow!("tầng 2 cần Claude Code CLI hoặc Codex CLI trên PATH"))?;
                report.proposals.extend(janitor::append_tier2(&mut s.vault, provider)?);
            }
            serde_json::to_value(&report)?
        }
        "janitor_report" => serde_json::to_value(janitor::latest_report(&s.vault)?)?,
        "janitor_apply" => {
            let id = a["action_id"].as_i64().ok_or_else(|| ToolError::Args("thiếu `action_id`".into()))?;
            json!({ "action_id": id, "result": janitor::apply_action(&mut s.vault, id)? })
        }
        "janitor_dismiss" => {
            let id = a["action_id"].as_i64().ok_or_else(|| ToolError::Args("thiếu `action_id`".into()))?;
            janitor::dismiss_action(&s.vault, id)?;
            json!({ "action_id": id, "dismissed": true })
        }
        _ => return Err(ToolError::Unknown),
    };
    Ok(v)
}

// ---------- helpers dùng chung với resources ----------

pub(crate) fn vault_stats(s: &Server) -> Result<Value> {
    let (notes, links, broken, tags, chunks) = s.vault.db.stats()?;
    Ok(json!({
        "root": s.vault.root.to_string_lossy(),
        "notes": notes, "links": links, "broken_links": broken, "tags": tags, "chunks": chunks,
        "fts_enabled": s.vault.db.fts_enabled,
        "read_only": s.opts.read_only
    }))
}

pub(crate) fn broken_links(s: &Server) -> Result<Value> {
    let rows = s.vault.db.broken_links()?;
    Ok(json!({
        "broken": rows.iter().map(|b| json!({ "src_path": b.src_path, "target": b.target, "kind": b.kind })).collect::<Vec<_>>()
    }))
}

pub(crate) fn graph(s: &Server) -> Result<Value> {
    let conn = &s.vault.db.conn;
    let mut stmt = conn.prepare(
        r#"SELECT n.path, n.title,
                  (SELECT COUNT(*) FROM link WHERE target_note = n.id)
                  + (SELECT COUNT(*) FROM link WHERE src_note = n.id AND target_note IS NOT NULL)
           FROM note n ORDER BY n.path"#,
    )?;
    let nodes = stmt
        .query_map([], |r| {
            Ok(json!({ "path": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "degree": r.get::<_, i64>(2)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare(
        r#"SELECT DISTINCT s.path, t.path
           FROM link l JOIN note s ON s.id = l.src_note JOIN note t ON t.id = l.target_note
           ORDER BY s.path, t.path"#,
    )?;
    let edges = stmt
        .query_map([], |r| Ok(json!({ "from": r.get::<_, String>(0)?, "to": r.get::<_, String>(1)? })))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "nodes": nodes, "edges": edges }))
}

fn list_notes(s: &Server, a: &Value) -> Result<Value> {
    let folder = opt_str(a, "folder").map(|f| f.replace('\\', "/").trim_matches('/').to_string() + "/");
    let mut rows: Vec<(String, String, i64)> = s
        .vault
        .db
        .note_list()?
        .into_iter()
        .filter(|(p, _, _)| folder.as_ref().is_none_or(|f| p.starts_with(f.as_str())))
        .collect();
    if opt_str(a, "sort") == Some("mtime") {
        rows.sort_by(|x, y| y.2.cmp(&x.2).then_with(|| x.0.cmp(&y.0)));
    }
    let total = rows.len();
    let offset = opt_usize(a, "offset", 0);
    let limit = opt_usize(a, "limit", 200).clamp(1, 2000);
    let notes: Vec<Value> = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(path, title, mtime)| json!({ "path": path, "title": title, "mtime": mtime }))
        .collect();
    Ok(json!({ "total": total, "offset": offset, "notes": notes }))
}

fn read_note(s: &Server, path: &str) -> Result<Value> {
    let (rel, abs) = s.abs(path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| anyhow!("không đọc được {rel}: {e}"))?;
    let meta = std::fs::metadata(&abs)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let title: Option<String> = s
        .vault
        .db
        .conn
        .query_row("SELECT title FROM note WHERE path = ?1", [&rel], |r| r.get(0))
        .ok();
    let tags = note_tags(s, &rel)?;
    let links = outgoing_links(s, &rel).unwrap_or_default();
    Ok(json!({
        "path": rel, "title": title, "mtime": mtime, "size": meta.len(),
        "tags": tags, "links": links, "content": content
    }))
}

fn outgoing_links(s: &Server, rel: &str) -> Result<Vec<Value>> {
    let mut stmt = s.vault.db.conn.prepare(
        r#"SELECT l.target_path, t.path, l.kind, l.heading
           FROM link l JOIN note n ON n.id = l.src_note LEFT JOIN note t ON t.id = l.target_note
           WHERE n.path = ?1 ORDER BY l.src_offset"#,
    )?;
    let rows = stmt
        .query_map([rel], |r| {
            Ok(json!({
                "target": r.get::<_, String>(0)?,
                "resolved_path": r.get::<_, Option<String>>(1)?,
                "kind": r.get::<_, String>(2)?,
                "heading": r.get::<_, Option<String>>(3)?
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn note_tags(s: &Server, rel: &str) -> Result<Vec<String>> {
    let mut stmt = s
        .vault
        .db
        .conn
        .prepare("SELECT t.tag FROM tag t JOIN note n ON n.id = t.note_id WHERE n.path = ?1 ORDER BY t.tag")?;
    let rows = stmt.query_map([rel], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn tags(s: &Server, tag: Option<&str>) -> Result<Value> {
    let conn = &s.vault.db.conn;
    match tag {
        Some(t) => {
            let t = t.trim_start_matches('#');
            let mut stmt = conn.prepare(
                "SELECT n.path, n.title FROM tag g JOIN note n ON n.id = g.note_id WHERE g.tag = ?1 COLLATE NOCASE ORDER BY n.path",
            )?;
            let notes = stmt
                .query_map([t], |r| Ok(json!({ "path": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)? })))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({ "tag": t, "notes": notes }))
        }
        None => {
            let mut stmt = conn.prepare("SELECT tag, COUNT(*) FROM tag GROUP BY tag ORDER BY COUNT(*) DESC, tag")?;
            let tags = stmt
                .query_map([], |r| Ok(json!({ "tag": r.get::<_, String>(0)?, "notes": r.get::<_, i64>(1)? })))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({ "tags": tags }))
        }
    }
}

fn list_canvases(s: &Server) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&s.vault.root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && [".brain", ".obsidian", ".trash", ".git"].contains(&name.as_ref()))
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file()
            && entry.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("canvas"))
        {
            if let Ok(rel) = entry.path().strip_prefix(&s.vault.root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

fn ask_vault(s: &Server, question: &str) -> Result<Value> {
    let provider = qa::provider_from_pref(&s.opts.llm_pref)
        .ok_or_else(|| anyhow!("không tìm thấy Claude Code CLI hoặc Codex CLI trên PATH"))?;
    let variants = qa::expand_query(provider, question);
    let sources = qa::retrieve(&s.vault.db, question, &variants, 6)?;
    if sources.is_empty() {
        return Ok(json!({
            "answer": "Vault chưa có nội dung nào liên quan để trả lời câu hỏi này.",
            "provider": provider.name(), "sources": []
        }));
    }
    let answer = qa::generate(provider, &qa::build_prompt(question, &sources))?;
    Ok(json!({
        "answer": answer,
        "provider": provider.name(),
        "sources": sources.iter().map(|c| json!({
            "path": c.path, "heading_path": c.heading_path, "start_line": c.start_line
        })).collect::<Vec<_>>()
    }))
}

fn append_note(s: &mut Server, a: &Value) -> Result<Value, ToolError> {
    let (rel, abs) = s.abs(req_str(a, "path")?)?;
    let add = a["content"].as_str().ok_or_else(|| ToolError::Args("thiếu `content`".into()))?;
    let mut content = match std::fs::read_to_string(&abs) {
        Ok(c) => c,
        Err(_) if opt_bool(a, "create", false) => String::new(),
        Err(e) => return Err(anyhow!("không đọc được {rel}: {e} (truyền create=true để tạo)").into()),
    };
    let add = add.trim_end_matches('\n');
    let mut inserted_under = None;
    match opt_str(a, "heading") {
        Some(h) => {
            let lines: Vec<&str> = content.lines().collect();
            let want = h.trim().trim_start_matches('#').trim().to_lowercase();
            let mut start = None;
            let mut level = 0;
            for (i, l) in lines.iter().enumerate() {
                if let Some((lvl, text)) = heading_of(l) {
                    if text.to_lowercase() == want {
                        start = Some(i);
                        level = lvl;
                        break;
                    }
                }
            }
            let Some(start) = start else {
                return Err(anyhow!("không tìm thấy heading `{h}` trong {rel}").into());
            };
            // Cuối section = ngay trước heading tiếp theo cùng cấp hoặc cao hơn.
            let mut end = lines.len();
            for (i, l) in lines.iter().enumerate().skip(start + 1) {
                if let Some((lvl, _)) = heading_of(l) {
                    if lvl <= level {
                        end = i;
                        break;
                    }
                }
            }
            // Bỏ dòng trống cuối section để chèn sát nội dung, giữ một dòng trống trước heading kế.
            let mut ins = end;
            while ins > start + 1 && lines[ins - 1].trim().is_empty() {
                ins -= 1;
            }
            let mut out: Vec<String> = lines[..ins].iter().map(|l| l.to_string()).collect();
            out.push(add.to_string());
            if end < lines.len() {
                out.push(String::new());
                out.extend(lines[end..].iter().map(|l| l.to_string()));
            }
            content = out.join("\n");
            content.push('\n');
            inserted_under = Some(h.to_string());
        }
        None => {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(add);
            content.push('\n');
        }
    }
    write_file(&abs, &content)?;
    s.vault.index()?;
    Ok(json!({ "path": rel, "appended_bytes": add.len(), "under_heading": inserted_under }))
}

fn heading_of(line: &str) -> Option<(usize, &str)> {
    let t = line.trim_start();
    let hashes = t.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &t[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    Some((hashes, rest.trim().trim_end_matches('#').trim()))
}

fn hit_json(h: &vault_core::db::SearchHit) -> Value {
    json!({
        "path": h.path, "title": h.title, "heading_path": h.heading_path,
        "start_line": h.start_line, "snippet": h.snippet
    })
}

fn citation(path: &str, heading_path: &str) -> String {
    let target = path.trim_end_matches(".md");
    let heading = heading_path.rsplit(" > ").next().unwrap_or("");
    if heading.is_empty() { format!("[[{target}]]") } else { format!("[[{target}#{heading}]]") }
}

fn with_md(rel: &str) -> String {
    if rel.to_lowercase().ends_with(".md") { rel.to_string() } else { format!("{rel}.md") }
}

fn write_file(abs: &std::path::Path, content: &str) -> Result<()> {
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(abs, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::heading_of;

    #[test]
    fn parses_headings() {
        assert_eq!(heading_of("## Việc cần làm"), Some((2, "Việc cần làm")));
        assert_eq!(heading_of("# Title #"), Some((1, "Title")));
        assert_eq!(heading_of("#tag không phải heading"), None);
        assert_eq!(heading_of("text"), None);
    }
}
