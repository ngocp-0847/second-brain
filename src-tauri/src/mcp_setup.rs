//! Nối app với agent ngoài qua MCP: chính file .exe của app chạy được như MCP server
//! (`second-brain --mcp --vault <path>`), module này lo phần "đăng ký" server đó
//! với Claude Code / Codex và sinh config cho terminal / agent headless trong app.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

pub const SERVER_NAME: &str = "second-brain";

pub struct McpCli {
    pub vault: PathBuf,
    pub options: mcp::Options,
}

/// Nhận diện chế độ MCP từ argv. `None` = chạy GUI như thường.
pub fn parse_cli(args: impl Iterator<Item = String>) -> Option<McpCli> {
    let args: Vec<String> = args.collect();
    if !args.iter().any(|a| a == "--mcp") {
        return None;
    }
    let mut vault = None;
    let mut read_only = false;
    let mut llm = "auto".to_string();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--vault" => vault = it.next().map(PathBuf::from),
            "--read-only" => read_only = true,
            "--llm" => {
                if let Some(v) = it.next() {
                    llm = v.clone();
                }
            }
            _ => {}
        }
    }
    let vault = vault.unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    Some(McpCli { vault, options: mcp::Options { read_only, llm_pref: llm } })
}

/// (exe, args) để spawn server cho vault này.
pub fn server_command(root: &Path) -> Result<(String, Vec<String>)> {
    let exe = std::env::current_exe().context("không lấy được đường dẫn exe")?;
    Ok((
        exe.to_string_lossy().into_owned(),
        vec!["--mcp".into(), "--vault".into(), root.to_string_lossy().into_owned()],
    ))
}

/// Ghi `.brain/mcp.json` (định dạng `--mcp-config` của Claude Code) cho vault, trả path.
/// Ghi lại mỗi lần vì exe có thể đổi chỗ sau khi cập nhật app.
pub fn write_config(root: &Path) -> Result<PathBuf> {
    let (exe, args) = server_command(root)?;
    let cfg = serde_json::json!({
        "mcpServers": { SERVER_NAME: { "type": "stdio", "command": exe, "args": args } }
    });
    let dir = root.join(".brain");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("mcp.json");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(path)
}

#[derive(Serialize)]
pub struct McpInfo {
    pub exe: String,
    pub vault: String,
    /// Lệnh đăng ký tay cho từng CLI (hiện trong Settings để copy).
    pub claude_cmd: String,
    pub codex_cmd: String,
    /// Snippet JSON generic (Cursor, Windsurf, Claude Desktop…).
    pub json_config: String,
    /// Đã có server tên `second-brain` trong CLI chưa. None = CLI không có trên PATH.
    pub claude_registered: Option<bool>,
    pub codex_registered: Option<bool>,
}

pub fn info(root: &Path) -> Result<McpInfo> {
    let (exe, args) = server_command(root)?;
    let quoted_args = args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
    let json_config = serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": { SERVER_NAME: { "command": &exe, "args": &args } }
    }))?;
    Ok(McpInfo {
        claude_cmd: format!("claude mcp add --scope user {SERVER_NAME} -- {} {quoted_args}", quote(&exe)),
        codex_cmd: format!("codex mcp add {SERVER_NAME} -- {} {quoted_args}", quote(&exe)),
        json_config,
        claude_registered: registered("claude"),
        codex_registered: registered("codex"),
        exe,
        vault: root.to_string_lossy().into_owned(),
    })
}

fn quote(s: &str) -> String {
    if s.contains(' ') { format!("\"{s}\"") } else { s.to_string() }
}

/// `<cli> mcp get second-brain` thành công ⇔ đã đăng ký. None nếu CLI không chạy được.
fn registered(cli: &str) -> Option<bool> {
    let provider = if cli == "claude" { qa::Provider::ClaudeCli } else { qa::Provider::CodexCli };
    if !qa::provider_available(provider) {
        return None;
    }
    let out = crate::agent::shell_command(cli, &["mcp", "get", SERVER_NAME])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    Some(out.status.success())
}

/// Đăng ký (hoặc cập nhật path) server với CLI. Trả output để hiện cho người dùng.
pub fn register(cli: &str, root: &Path) -> Result<String> {
    check_cli(cli)?;
    let (exe, args) = server_command(root)?;
    // Đã có → gỡ trước để cập nhật đường dẫn vault/exe mới.
    if registered(cli) == Some(true) {
        let _ = run(cli, &remove_args(cli));
    }
    let mut a: Vec<&str> = match cli {
        "claude" => vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--"],
        _ => vec!["mcp", "add", SERVER_NAME, "--"],
    };
    a.push(&exe);
    a.extend(args.iter().map(String::as_str));
    let out = run(cli, &a)?;
    if registered(cli) != Some(true) {
        bail!("đăng ký xong nhưng `{cli} mcp get {SERVER_NAME}` không thấy server:\n{out}");
    }
    Ok(out)
}

pub fn unregister(cli: &str) -> Result<String> {
    check_cli(cli)?;
    run(cli, &remove_args(cli))
}

fn remove_args(cli: &str) -> Vec<&'static str> {
    match cli {
        "claude" => vec!["mcp", "remove", "--scope", "user", SERVER_NAME],
        _ => vec!["mcp", "remove", SERVER_NAME],
    }
}

fn check_cli(cli: &str) -> Result<()> {
    let provider = match cli {
        "claude" => qa::Provider::ClaudeCli,
        "codex" => qa::Provider::CodexCli,
        _ => bail!("CLI không hỗ trợ: {cli}"),
    };
    if !qa::provider_available(provider) {
        bail!("không tìm thấy `{cli}` trên PATH");
    }
    Ok(())
}

fn run(cli: &str, args: &[&str]) -> Result<String> {
    let out = crate::agent::shell_command(cli, args)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("không chạy được {cli}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    if !out.status.success() {
        bail!("{cli} {} thất bại: {text}", args.join(" "));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::parse_cli;

    #[test]
    fn parses_mcp_flags() {
        let c = parse_cli(["--mcp", "--vault", "D:/vault", "--read-only", "--llm", "codex"].map(String::from).into_iter())
            .unwrap();
        assert_eq!(c.vault.to_string_lossy(), "D:/vault");
        assert!(c.options.read_only);
        assert_eq!(c.options.llm_pref, "codex");
        assert!(parse_cli(["foo.md"].map(String::from).into_iter()).is_none());
    }
}
