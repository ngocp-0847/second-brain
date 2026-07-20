//! Chat với agent CLI (Claude Code / Codex) chạy headless với working-dir là vault
//! để sửa nội dung note, làm đẹp format, hoặc tái cấu trúc — stream tiến trình về UI
//! qua event `agent-progress`.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

/// Agent có thể chạy nhiều tool call liên tiếp — cho phép tối đa 15 phút.
const AGENT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Serialize)]
pub struct AgentReply {
    pub text: String,
    pub session_id: Option<String>,
    pub provider: String,
}

#[derive(Clone, Serialize)]
struct AgentProgress {
    label: String,
}

/// Ranh giới làm việc cho agent: chỉ trong vault, giữ wikilink.
fn system_prompt(context_path: Option<&str>) -> String {
    let mut p = String::from(
        "Bạn là agent trợ giúp cho một vault ghi chú Markdown kiểu Obsidian — \
         thư mục làm việc hiện tại chính là vault.\n\
         Quy tắc:\n\
         - Chỉ đọc/sửa file bên trong vault. Không đụng vào .brain/, .git/, .obsidian/.\n\
         - Giữ nguyên wikilink [[...]] trừ khi được yêu cầu; đổi tên/di chuyển file thì cập nhật mọi link trỏ tới.\n\
         - Trả lời ngắn gọn bằng tiếng Việt, cuối câu trả lời liệt kê file đã thay đổi (nếu có).\n",
    );
    if let Some(path) = context_path {
        p.push_str(&format!("\nNgười dùng đang mở note: {path}\n"));
    }
    p
}

/// CLI cài qua npm trên Windows là shim `.cmd` → phải chạy qua `cmd /c`.
fn shell_command(cmd: &str, args: &[&str]) -> Command {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(cmd);
        c
    } else {
        Command::new(cmd)
    };
    c.args(args);
    crate::hide_console(&mut c);
    c
}

pub fn chat(
    app: &AppHandle,
    provider: qa::Provider,
    root: &std::path::Path,
    message: &str,
    context_path: Option<&str>,
    session_id: Option<&str>,
) -> Result<AgentReply> {
    match provider {
        qa::Provider::ClaudeCli => chat_claude(app, root, message, context_path, session_id),
        qa::Provider::CodexCli => chat_codex(root, message, context_path),
    }
}

/// Claude Code headless: stream-json để bắt tiến trình từng tool call,
/// `--resume` giữ ngữ cảnh hội thoại giữa các tin nhắn.
fn chat_claude(
    app: &AppHandle,
    root: &std::path::Path,
    message: &str,
    context_path: Option<&str>,
    session_id: Option<&str>,
) -> Result<AgentReply> {
    let sys = system_prompt(context_path);
    let mut args = vec![
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash,Edit,Write,MultiEdit",
        "--append-system-prompt",
        &sys,
    ];
    if let Some(id) = session_id {
        args.push("--resume");
        args.push(id);
    }
    let mut cmd = shell_command("claude", &args);
    cmd.current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().context("không chạy được claude — CLI có trên PATH không?")?;
    child
        .stdin
        .take()
        .context("stdin không mở được")?
        .write_all(message.as_bytes())?;

    let stdout = child.stdout.take().context("stdout không mở được")?;
    let app2 = app.clone();
    // Đọc stream ở thread riêng: emit tiến trình, gom kết quả cuối.
    let reader = std::thread::spawn(move || -> (String, Option<String>, String) {
        let mut result = String::new();
        let mut sid = None;
        let mut last_text = String::new();
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("assistant") => {
                    for c in v["message"]["content"].as_array().unwrap_or(&Vec::new()) {
                        match c["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = c["text"].as_str() {
                                    last_text = t.to_string();
                                    let label: String = t.chars().take(90).collect();
                                    let _ = app2.emit("agent-progress", AgentProgress { label });
                                }
                            }
                            Some("tool_use") => {
                                let name = c["name"].as_str().unwrap_or("tool");
                                let target = c["input"]["file_path"]
                                    .as_str()
                                    .or_else(|| c["input"]["command"].as_str())
                                    .unwrap_or("");
                                let label =
                                    format!("⚙ {name} {}", target.chars().take(70).collect::<String>());
                                let _ = app2.emit("agent-progress", AgentProgress { label });
                            }
                            _ => {}
                        }
                    }
                }
                Some("result") => {
                    if let Some(r) = v["result"].as_str() {
                        result = r.to_string();
                    }
                    sid = v["session_id"].as_str().map(String::from);
                }
                _ => {}
            }
        }
        (result, sid, last_text)
    });

    match child.wait_timeout(AGENT_TIMEOUT)? {
        Some(status) if status.success() => {}
        Some(status) => {
            let mut err = String::new();
            if let Some(mut se) = child.stderr.take() {
                use std::io::Read;
                let _ = se.read_to_string(&mut err);
            }
            bail!("claude exit {}: {}", status, err.chars().take(500).collect::<String>());
        }
        None => {
            let _ = child.kill();
            bail!("agent không xong trong {} phút", AGENT_TIMEOUT.as_secs() / 60);
        }
    }
    let (result, sid, last_text) = reader.join().unwrap_or_default();
    let text = if result.is_empty() { last_text } else { result };
    if text.is_empty() {
        bail!("claude trả về rỗng");
    }
    Ok(AgentReply { text, session_id: sid, provider: "claude".into() })
}

/// Codex exec: không giữ session giữa các lần gọi — mỗi tin nhắn là một lượt độc lập.
fn chat_codex(root: &std::path::Path, message: &str, context_path: Option<&str>) -> Result<AgentReply> {
    let prompt = format!("{}\n\n{message}", system_prompt(context_path));
    let mut cmd = shell_command("codex", &["exec", "--full-auto", "-"]);
    cmd.current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("không chạy được codex — CLI có trên PATH không?")?;
    child.stdin.take().context("stdin không mở được")?.write_all(prompt.as_bytes())?;

    let mut stdout = child.stdout.take().context("stdout không mở được")?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    match child.wait_timeout(AGENT_TIMEOUT)? {
        Some(status) if status.success() => {}
        Some(status) => bail!("codex exit {status}"),
        None => {
            let _ = child.kill();
            bail!("agent không xong trong {} phút", AGENT_TIMEOUT.as_secs() / 60);
        }
    }
    let out = reader.join().unwrap_or_default();
    // codex exec in kèm log meta ('[...]', 'tokens used') — lọc thô.
    let text = out
        .trim()
        .lines()
        .filter(|l| !l.starts_with('[') && !l.to_lowercase().contains("tokens used"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        bail!("codex trả về rỗng");
    }
    Ok(AgentReply { text, session_id: None, provider: "codex".into() })
}
