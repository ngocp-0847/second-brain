//! MCP server (Model Context Protocol) cho vault — để agent ngoài (Claude Code,
//! Codex, Cursor…) đọc/sửa/tìm kiếm/tái cấu trúc vault qua tool có cấu trúc thay
//! vì mò file bằng shell.
//!
//! Transport: **stdio**, JSON-RPC 2.0, mỗi message một dòng (newline-delimited).
//! stdout CHỈ dành cho JSON-RPC; mọi log đi qua stderr. Hỗ trợ đầy đủ ba bề mặt
//! của spec: `tools` (đọc + ghi + bảo trì), `resources` (`brain://note/{path}`),
//! `prompts` (workflow có sẵn, kèm ngữ cảnh đã retrieve).
//!
//! Dùng chung `vault-core` với app và CLI nên mọi thao tác đi đúng đường của app:
//! rename tự rewrite wikilink, xóa = vào `.brain/trash`, index tăng dần sau mỗi lần ghi.

mod prompts;
mod resources;
mod tools;

use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use vault_core::Vault;

pub const SERVER_NAME: &str = "second-brain";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Phiên bản spec mới nhất mà server nói được; client cũ hơn thì server hạ theo.
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// Tùy chọn khi khởi động server.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Chỉ expose tool đọc (search/read/graph…), ẩn mọi tool ghi & bảo trì.
    pub read_only: bool,
    /// "auto" | "claude" | "codex" — provider cho tool `ask_vault`.
    pub llm_pref: String,
}

pub struct Server {
    pub vault: Vault,
    pub opts: Options,
    initialized: bool,
}

impl Server {
    pub fn new(vault: Vault, opts: Options) -> Self {
        Server { vault, opts, initialized: false }
    }

    /// Mở vault tại `root`, index tươi, sẵn sàng phục vụ.
    pub fn open(root: impl Into<PathBuf>, opts: Options) -> Result<Self> {
        let mut vault = Vault::open(root)?;
        vault.index()?;
        Ok(Self::new(vault, opts))
    }

    /// Xử lý một message JSON-RPC. Trả `None` cho notification (không cần reply).
    pub fn handle(&mut self, msg: Value) -> Option<Value> {
        // Spec 2025-03-26 bỏ batch; client cũ gửi mảng thì báo lỗi rõ.
        if msg.is_array() {
            return Some(error(Value::Null, -32600, "batch không được hỗ trợ"));
        }
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        // Reply từ client (cho request server gửi) — server này không gửi request nào.
        if method.is_empty() {
            return None;
        }
        // Notification: không có id → không reply, kể cả lỗi.
        let Some(id) = id else {
            if method == "notifications/initialized" {
                self.initialized = true;
            }
            return None;
        };

        let result = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "logging/setLevel" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools::list(&self.opts) })),
            "tools/call" => self.call_tool(&params),
            "resources/list" => resources::list(self, &params),
            "resources/templates/list" => Ok(resources::templates()),
            "resources/read" => resources::read(self, &params),
            "prompts/list" => Ok(json!({ "prompts": prompts::list() })),
            "prompts/get" => prompts::get(self, &params),
            // Không có subscribe nên completion/roots… đều báo chưa hỗ trợ.
            _ => Err(RpcError::method_not_found(method)),
        };
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => error(id, e.code, &e.message),
        })
    }

    fn initialize(&mut self, params: &Value) -> Value {
        let requested = params["protocolVersion"].as_str().unwrap_or(LATEST_PROTOCOL);
        let version =
            if SUPPORTED_PROTOCOLS.contains(&requested) { requested } else { LATEST_PROTOCOL };
        json!({
            "protocolVersion": version,
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": { "subscribe": false, "listChanged": false },
                "prompts": { "listChanged": false },
                "logging": {}
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "title": "Second Brain",
                "version": SERVER_VERSION
            },
            "instructions": self.instructions()
        })
    }

    fn instructions(&self) -> String {
        let mut s = format!(
            "Vault ghi chú Markdown kiểu Obsidian tại `{}`. Đường dẫn note là tương đối với \
             gốc vault, dùng `/`, có đuôi `.md` (vd `Projects/Alpha.md`). Wikilink `[[Tên note]]` \
             trỏ theo tên file (stem). Ưu tiên `search_notes` / `retrieve_context` để tìm rồi \
             `read_note` để đọc; sửa nhỏ dùng `replace_in_note` / `append_note` thay vì ghi đè \
             cả file. Đổi tên/di chuyển BẮT BUỘC qua `rename_note` để mọi wikilink được rewrite. \
             Xóa = `trash_note` (vào .brain/trash, khôi phục được). Không đụng vào `.brain/`, \
             `.obsidian/`, `.git/`.",
            self.vault.root.display()
        );
        if self.opts.read_only {
            s.push_str(" Server đang ở chế độ CHỈ ĐỌC: không có tool ghi.");
        }
        s
    }

    fn call_tool(&mut self, params: &Value) -> Result<Value, RpcError> {
        let name = params["name"].as_str().ok_or_else(|| RpcError::invalid_params("thiếu `name`"))?;
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if self.opts.read_only && !tools::is_read_only(name) {
            return Err(RpcError::invalid_params(&format!(
                "tool `{name}` không khả dụng: server chạy ở chế độ chỉ đọc"
            )));
        }
        match tools::call(self, name, &args) {
            Ok(out) => Ok(tool_result(out, false)),
            // Lỗi khi thực thi tool → isError trong result để LLM tự sửa, không phải lỗi protocol.
            Err(ToolError::Exec(e)) => Ok(tool_result(json!({ "error": e.to_string() }), true)),
            Err(ToolError::Unknown) => Err(RpcError::invalid_params(&format!("tool không tồn tại: {name}"))),
            Err(ToolError::Args(m)) => Err(RpcError::invalid_params(&m)),
        }
    }

    /// Path tương đối đã chuẩn hóa + chặn traversal và thư mục hệ thống của vault.
    pub(crate) fn guard_rel(&self, rel: &str) -> anyhow::Result<String> {
        let rel = rel.trim().replace('\\', "/");
        let rel = rel.trim_start_matches("./").trim_matches('/').to_string();
        if rel.is_empty() {
            anyhow::bail!("đường dẫn rỗng");
        }
        // abs_path đã chặn `..`; chặn thêm các thư mục app/tool.
        self.vault.abs_path(&rel)?;
        let first = rel.split('/').next().unwrap_or("");
        if [".brain", ".git", ".obsidian", ".trash"].contains(&first) {
            anyhow::bail!("không được truy cập thư mục hệ thống: {first}/");
        }
        Ok(rel)
    }

    pub(crate) fn abs(&self, rel: &str) -> anyhow::Result<(String, PathBuf)> {
        let rel = self.guard_rel(rel)?;
        let abs = self.vault.abs_path(&rel)?;
        Ok((rel, abs))
    }
}

/// Kết quả tool theo spec: `content` text (JSON pretty) cho client cũ +
/// `structuredContent` cho client 2025-06-18.
fn tool_result(out: Value, is_error: bool) -> Value {
    let text = match &out {
        Value::String(s) => s.clone(),
        v => serde_json::to_string_pretty(v).unwrap_or_default(),
    };
    let mut r = json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    });
    if out.is_object() {
        r["structuredContent"] = out;
    }
    r
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

pub(crate) struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    pub(crate) fn invalid_params(m: &str) -> Self {
        RpcError { code: -32602, message: m.to_string() }
    }
    pub(crate) fn method_not_found(m: &str) -> Self {
        RpcError { code: -32601, message: format!("method không hỗ trợ: {m}") }
    }
    pub(crate) fn internal(e: impl std::fmt::Display) -> Self {
        RpcError { code: -32603, message: e.to_string() }
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(e: anyhow::Error) -> Self {
        RpcError::internal(e)
    }
}

pub(crate) enum ToolError {
    Unknown,
    Args(String),
    Exec(anyhow::Error),
}

impl From<anyhow::Error> for ToolError {
    fn from(e: anyhow::Error) -> Self {
        ToolError::Exec(e)
    }
}

impl From<std::io::Error> for ToolError {
    fn from(e: std::io::Error) -> Self {
        ToolError::Exec(e.into())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(e: serde_json::Error) -> Self {
        ToolError::Exec(e.into())
    }
}

impl From<rusqlite::Error> for ToolError {
    fn from(e: rusqlite::Error) -> Self {
        ToolError::Exec(e.into())
    }
}

/// Chạy server trên stdin/stdout cho tới khi client đóng stdin.
pub fn serve_stdio(root: &Path, opts: Options) -> Result<()> {
    let mut server = Server::open(root, opts)?;
    eprintln!(
        "[second-brain mcp] vault={} read_only={}",
        server.vault.root.display(),
        server.opts.read_only
    );
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let r = error(Value::Null, -32700, &format!("parse error: {e}"));
                writeln!(out, "{r}")?;
                out.flush()?;
                continue;
            }
        };
        if let Some(reply) = server.handle(msg) {
            writeln!(out, "{reply}")?;
            out.flush()?;
        }
    }
    Ok(())
}

/// Đọc chuỗi bắt buộc từ arguments.
pub(crate) fn req_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::Args(format!("thiếu tham số `{key}`")))
}

pub(crate) fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

pub(crate) fn opt_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(default)
}

pub(crate) fn opt_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sb-mcp-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(dir.join("Projects")).unwrap();
        std::fs::write(dir.join("Projects/Alpha.md"), "# Alpha\n\nDự án alpha dùng tokio và [[Beta]].\n").unwrap();
        std::fs::write(dir.join("Beta.md"), "# Beta\n\nGhi chú beta nói về async runtime.\n#rust\n").unwrap();
        std::fs::write(dir.join("Gamma.md"), "# Gamma\n\nKhông link đi đâu.\n").unwrap();
        dir
    }

    fn server(dir: &Path) -> Server {
        Server::open(dir, Options::default()).unwrap()
    }

    fn call(s: &mut Server, name: &str, args: Value) -> Value {
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}))
            .unwrap();
        assert!(r.get("error").is_none(), "rpc error: {r}");
        r["result"].clone()
    }

    #[test]
    fn initialize_negotiates_version() {
        let dir = temp_vault();
        let mut s = server(&dir);
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}))
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}))
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], LATEST_PROTOCOL);
        assert!(s.handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_method_is_rpc_error() {
        let dir = temp_vault();
        let mut s = server(&dir);
        let r = s.handle(json!({"jsonrpc":"2.0","id":7,"method":"nope"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 7);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tools_list_has_schema_and_read_only_filters() {
        let dir = temp_vault();
        let mut s = server(&dir);
        let r = s.handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "rename_note"));
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
            assert!(t["description"].as_str().is_some_and(|d| !d.is_empty()));
        }
        s.opts.read_only = true;
        let r = s.handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"search_notes"));
        assert!(!names.contains(&"rename_note"));
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"trash_note","arguments":{"path":"Beta.md"}}}))
            .unwrap();
        assert_eq!(r["error"]["code"], -32602);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn search_read_backlinks() {
        let dir = temp_vault();
        let mut s = server(&dir);
        let r = call(&mut s, "search_notes", json!({"query":"tokio"}));
        assert_eq!(r["isError"], false);
        assert_eq!(r["structuredContent"]["hits"][0]["path"], "Projects/Alpha.md");
        let r = call(&mut s, "read_note", json!({"path":"Projects/Alpha.md"}));
        assert!(r["structuredContent"]["content"].as_str().unwrap().contains("tokio"));
        let r = call(&mut s, "backlinks", json!({"note":"Beta"}));
        assert_eq!(r["structuredContent"]["backlinks"][0]["src_path"], "Projects/Alpha.md");
        let r = call(&mut s, "outgoing_links", json!({"path":"Projects/Alpha.md"}));
        assert_eq!(r["structuredContent"]["links"][0]["resolved_path"], "Beta.md");
        let r = call(&mut s, "orphans", json!({}));
        assert_eq!(r["structuredContent"]["orphans"][0]["path"], "Gamma.md");
        let r = call(&mut s, "tags", json!({}));
        assert_eq!(r["structuredContent"]["tags"][0]["tag"], "rust");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_replace_append_rename_trash() {
        let dir = temp_vault();
        let mut s = server(&dir);
        call(&mut s, "create_note", json!({"path":"Ideas/New idea","content":"# New idea\n\nnội dung"}));
        assert!(dir.join("Ideas/New idea.md").exists());
        let r = call(&mut s, "create_note", json!({"path":"Ideas/New idea"}));
        assert_eq!(r["isError"], true, "tạo trùng phải báo lỗi tool");

        let r = call(&mut s, "replace_in_note", json!({"path":"Beta.md","old":"async runtime","new":"tokio runtime"}));
        assert_eq!(r["structuredContent"]["replaced"], 1);
        let r = call(&mut s, "replace_in_note", json!({"path":"Beta.md","old":"không có","new":"x"}));
        assert_eq!(r["isError"], true);

        call(&mut s, "append_note", json!({"path":"Beta.md","content":"- thêm dòng"}));
        let c = std::fs::read_to_string(dir.join("Beta.md")).unwrap();
        assert!(c.ends_with("- thêm dòng\n"), "{c:?}");

        let r = call(&mut s, "rename_note", json!({"from":"Beta.md","to":"Notes/Beta 2"}));
        assert_eq!(r["structuredContent"]["links_rewritten"], 1);
        let alpha = std::fs::read_to_string(dir.join("Projects/Alpha.md")).unwrap();
        assert!(alpha.contains("[[Beta 2]]"), "{alpha}");

        call(&mut s, "trash_note", json!({"path":"Gamma.md"}));
        assert!(!dir.join("Gamma.md").exists());
        assert!(dir.join(".brain/trash").is_dir());

        let r = call(&mut s, "read_note", json!({"path":"../secret.md"}));
        assert_eq!(r["isError"], true);
        let r = call(&mut s, "write_note", json!({"path":".brain/cache.db","content":"x"}));
        assert_eq!(r["isError"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resources_and_prompts() {
        let dir = temp_vault();
        let mut s = server(&dir);
        let r = s.handle(json!({"jsonrpc":"2.0","id":1,"method":"resources/list"})).unwrap();
        let list = r["result"]["resources"].as_array().unwrap();
        assert!(list.iter().any(|x| x["uri"] == "brain://note/Beta.md"));
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"brain://note/Beta.md"}}))
            .unwrap();
        assert!(r["result"]["contents"][0]["text"].as_str().unwrap().contains("Beta"));
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"brain://vault/stats"}}))
            .unwrap();
        assert_eq!(r["result"]["contents"][0]["mimeType"], "application/json");
        let r = s.handle(json!({"jsonrpc":"2.0","id":4,"method":"prompts/list"})).unwrap();
        assert!(r["result"]["prompts"].as_array().unwrap().len() >= 3);
        let r = s
            .handle(json!({"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{"name":"answer_from_vault","arguments":{"question":"tokio"}}}))
            .unwrap();
        let text = r["result"]["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("Alpha"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
