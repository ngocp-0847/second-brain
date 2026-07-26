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
        p.push_str(&format!(
            "\nNote người dùng đang mở trong app: \"{path}\". Khi họ nói \"note này\" / \"note đang mở\", \
             luôn hiểu là đúng file đó — TUYỆT ĐỐI không tự đoán note khác \
             (không dò .obsidian/workspace hay tab nào cả).\n"
        ));
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
    // Path nhúng thẳng vào tin nhắn — system prompt có thể không được áp lại khi --resume,
    // và agent từng tự đoán "note đang mở" qua .obsidian/workspace thay vì dùng ngữ cảnh.
    let message = match context_path {
        Some(p) => format!("(Ngữ cảnh: note tôi đang mở là \"{p}\")\n\n{message}"),
        None => message.to_string(),
    };
    match provider {
        qa::Provider::ClaudeCli => chat_claude(app, root, &message, context_path, session_id),
        qa::Provider::CodexCli => chat_codex(root, &message, context_path),
    }
}

/// Sửa đúng một vùng chọn trong note: agent chỉ SINH TEXT (không có tool, cwd là thư mục
/// tạm) rồi UI thay vào vùng chọn bằng transaction — nên Ctrl+Z hoàn tác được và tuyệt đối
/// không có nguy cơ agent sửa lan sang file khác.
pub fn transform(
    provider: qa::Provider,
    selection: &str,
    instruction: &str,
    context_path: Option<&str>,
) -> Result<String> {
    let where_ = context_path.map(|p| format!(" trong note \"{p}\"")).unwrap_or_default();
    let prompt = format!(
        "Bạn là trợ lý biên tập Markdown. Người dùng đã chọn một đoạn{where_} và yêu cầu:\n\
         \"{instruction}\"\n\n\
         Chỉ áp dụng yêu cầu đó lên ĐOẠN ĐƯỢC CHỌN dưới đây. Quy tắc bắt buộc:\n\
         - Xuất ra DUY NHẤT nội dung Markdown mới của đoạn đó — không mở bài, không giải thích, \
           không nhắc lại yêu cầu, không bọc toàn bộ kết quả trong ``` (trừ khi chính nội dung cần code block).\n\
         - Đoạn này nằm giữa một note lớn hơn: giữ mức thụt lề và không thêm/bớt dòng trống ở đầu-cuối.\n\
         - Giữ nguyên mọi wikilink [[...]], link, và không bịa thêm thông tin mới.\n\
         - Nếu yêu cầu không rõ hoặc không áp dụng được, trả về đoạn gốc y nguyên.\n\n\
         ĐOẠN ĐƯỢC CHỌN:\n{selection}"
    );
    let out = qa::generate(provider, &prompt)?;
    Ok(strip_wrapper_fence(&out, selection))
}

/// Model hay bọc cả câu trả lời trong ```markdown … ``` — bóc ra, trừ khi bản thân
/// đoạn gốc đã là một fenced block (khi đó fence là nội dung thật).
fn strip_wrapper_fence(out: &str, selection: &str) -> String {
    let t = out.trim_matches('\n');
    if selection.trim_start().starts_with("```") {
        return t.to_string();
    }
    let mut lines: Vec<&str> = t.lines().collect();
    let Some(first) = lines.first().map(|l| l.trim()) else { return t.to_string() };
    let info = first.strip_prefix("```").map(str::trim).unwrap_or("").to_lowercase();
    if !first.starts_with("```") || !matches!(info.as_str(), "" | "markdown" | "md") {
        return t.to_string();
    }
    if lines.last().map(|l| l.trim()) != Some("```") {
        return t.to_string();
    }
    lines.remove(0);
    lines.pop();
    lines.join("\n")
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

#[cfg(test)]
mod tests {
    use super::strip_wrapper_fence;

    #[test]
    fn strips_markdown_wrapper() {
        let out = "```markdown\n| a | b |\n| - | - |\n```";
        assert_eq!(strip_wrapper_fence(out, "a, b"), "| a | b |\n| - | - |");
    }

    #[test]
    fn keeps_real_code_block() {
        let out = "```rust\nfn main() {}\n```";
        assert_eq!(strip_wrapper_fence(out, "fn main"), out);
    }

    #[test]
    fn keeps_fence_when_selection_was_a_fence() {
        let out = "```\nfoo\n```";
        assert_eq!(strip_wrapper_fence(out, "```\nbar\n```"), out);
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(strip_wrapper_fence("\nxin chào\n", "chào"), "xin chào");
    }
}
