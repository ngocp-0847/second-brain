//! `prompts/*`: workflow có sẵn, đã nhúng ngữ cảnh từ vault (nội dung note, related,
//! trích đoạn retrieve) để client agent tự sinh — không cần server gọi LLM.

use crate::{req_str, RpcError, Server, ToolError};
use serde_json::{json, Value};

pub(crate) fn list() -> Value {
    json!([
        {
            "name": "summarize_note",
            "title": "Tóm tắt note",
            "description": "Tóm tắt một note thành các ý chính, giữ wikilink gốc.",
            "arguments": [{ "name": "path", "description": "Đường dẫn note (vd Projects/Alpha.md)", "required": true }]
        },
        {
            "name": "suggest_links",
            "title": "Gợi ý wikilink",
            "description": "Đọc note + related notes + unlinked mentions, đề xuất chỗ nên thêm [[wikilink]].",
            "arguments": [{ "name": "path", "description": "Đường dẫn note", "required": true }]
        },
        {
            "name": "answer_from_vault",
            "title": "Trả lời từ vault (RAG)",
            "description": "Retrieve BM25 các trích đoạn liên quan rồi trả lời CHỈ dựa trên chúng, kèm citation [[note#heading]].",
            "arguments": [{ "name": "question", "description": "Câu hỏi", "required": true }]
        },
        {
            "name": "review_note",
            "title": "Review & dọn note",
            "description": "Soát lỗi cấu trúc/frontmatter/link gãy của một note và đề xuất bản sửa.",
            "arguments": [{ "name": "path", "description": "Đường dẫn note", "required": true }]
        }
    ])
}

pub(crate) fn get(server: &mut Server, params: &Value) -> Result<Value, RpcError> {
    let name = params["name"].as_str().ok_or_else(|| RpcError::invalid_params("thiếu `name`"))?;
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let (description, text) = match name {
        "summarize_note" => {
            let (rel, content) = read(server, &args)?;
            (
                format!("Tóm tắt {rel}"),
                format!(
                    "Tóm tắt note `{rel}` dưới đây thành 3–7 ý chính (bullet), bằng ngôn ngữ của note. \
                     Giữ nguyên mọi wikilink [[...]] xuất hiện trong ý được tóm tắt. Không thêm thông tin ngoài note.\n\n\
                     --- NOTE ---\n{content}"
                ),
            )
        }
        "suggest_links" => {
            let (rel, content) = read(server, &args)?;
            let related = server.vault.db.related_notes(&rel, 8).map_err(RpcError::internal)?;
            let mentions = server.vault.db.unlinked_mentions(&rel, 20).map_err(RpcError::internal)?;
            let mut ctx = String::new();
            ctx.push_str("NOTE LIÊN QUAN (chưa link trực tiếp):\n");
            for r in &related {
                ctx.push_str(&format!("- {}  \"{}\"  [{}]\n", r.path, r.title, r.reason));
            }
            ctx.push_str("\nCHỖ NHẮC TÊN NOTE NÀY NHƯNG CHƯA LINK:\n");
            for m in &mentions {
                ctx.push_str(&format!("- {}:{}  {}\n", m.path, m.start_line, m.snippet.replace('\n', " ")));
            }
            (
                format!("Gợi ý link cho {rel}"),
                format!(
                    "Bạn đang làm việc với vault Obsidian. Với note `{rel}` dưới đây, đề xuất:\n\
                     1) Những cụm từ trong note nên bọc thành [[wikilink]] tới note đã tồn tại (liệt kê ở phần NOTE LIÊN QUAN).\n\
                     2) Những note khác đang nhắc tên note này mà chưa link — có nên link không.\n\
                     Trả lời dạng danh sách `file:dòng — sửa gì`. Nếu muốn áp dụng, dùng tool `replace_in_note` \
                     (chỉ sửa đúng cụm từ, không ghi đè cả file).\n\n--- NOTE ---\n{content}\n\n--- NGỮ CẢNH ---\n{ctx}"
                ),
            )
        }
        "answer_from_vault" => {
            let question = req_str(&args, "question").map_err(tool_err)?;
            let sources = qa::retrieve(&server.vault.db, question, &[], 6).map_err(RpcError::internal)?;
            let text = if sources.is_empty() {
                format!(
                    "CÂU HỎI: {question}\n\nVault không có trích đoạn nào khớp. Trả lời đúng một câu: \
                     \"Vault chưa có thông tin về câu hỏi này.\""
                )
            } else {
                qa::build_prompt(question, &sources)
            };
            (format!("Trả lời từ vault: {question}"), text)
        }
        "review_note" => {
            let (rel, content) = read(server, &args)?;
            let broken: Vec<String> = server
                .vault
                .db
                .broken_links()
                .map_err(RpcError::internal)?
                .into_iter()
                .filter(|b| b.src_path == rel)
                .map(|b| format!("[[{}]]", b.target))
                .collect();
            (
                format!("Review {rel}"),
                format!(
                    "Review note `{rel}` theo checklist: (a) tiêu đề H1 khớp tên file, (b) frontmatter YAML hợp lệ nếu có, \
                     (c) heading phân cấp đúng, (d) wikilink gãy: {broken:?} — gợi ý đích đúng bằng tool `resolve_link`/`search_notes`, \
                     (e) đoạn quá dài nên tách. Đưa ra danh sách sửa cụ thể; nếu người dùng đồng ý thì áp dụng bằng \
                     `replace_in_note` (từng chỗ) hoặc `fix_broken_link`.\n\n--- NOTE ---\n{content}"
                ),
            )
        }
        _ => return Err(RpcError::invalid_params(&format!("prompt không tồn tại: {name}"))),
    };
    Ok(json!({
        "description": description,
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
    }))
}

fn read(server: &Server, args: &Value) -> Result<(String, String), RpcError> {
    let path = req_str(args, "path").map_err(tool_err)?;
    let (rel, abs) = server.abs(path)?;
    let content = std::fs::read_to_string(&abs)
        .map_err(|e| RpcError::invalid_params(&format!("không đọc được {rel}: {e}")))?;
    Ok((rel, content))
}

fn tool_err(e: ToolError) -> RpcError {
    match e {
        ToolError::Args(m) => RpcError::invalid_params(&m),
        ToolError::Exec(e) => RpcError::internal(e),
        ToolError::Unknown => RpcError::invalid_params("không hợp lệ"),
    }
}
