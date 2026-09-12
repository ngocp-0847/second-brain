//! Hỏi–đáp trên vault (RAG):
//! retrieve (BM25 trên câu hỏi + các biến thể, RRF) → prompt kèm trích đoạn →
//! LLM qua agent CLI có sẵn
//! (Claude Code CLI headless hoặc Codex CLI — tận dụng đăng nhập sẵn có, không cần API key).
//!
//! Nguyên tắc: chỉ các trích đoạn được retrieve mới vào prompt (không gửi cả vault);
//! CLI chạy với working-dir là thư mục tạm để agent không tự đọc file ngoài phạm vi.

use anyhow::{bail, Context, Result};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use vault_core::db::Db;
use wait_timeout::ChildExt;

const LLM_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_CHUNK_CHARS: usize = 1500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    ClaudeCli,
    CodexCli,
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Provider::ClaudeCli => "claude",
            Provider::CodexCli => "codex",
        }
    }
}

/// Tìm agent CLI khả dụng trên PATH (ưu tiên claude). Cache kết quả cho cả phiên.
pub fn detect_provider() -> Option<Provider> {
    static CACHE: std::sync::OnceLock<Option<Provider>> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        for (p, cmd) in [(Provider::ClaudeCli, "claude"), (Provider::CodexCli, "codex")] {
            if cli_works(cmd) {
                return Some(p);
            }
        }
        None
    })
}

/// Resolve provider theo lựa chọn của user: "claude" / "codex" / "auto".
pub fn provider_from_pref(pref: &str) -> Option<Provider> {
    match pref {
        "claude" => provider_available(Provider::ClaudeCli).then_some(Provider::ClaudeCli),
        "codex" => provider_available(Provider::CodexCli).then_some(Provider::CodexCli),
        _ => detect_provider(),
    }
}

/// CLI của provider có chạy được không (cache theo phiên).
pub fn provider_available(p: Provider) -> bool {
    static CLAUDE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    static CODEX: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    match p {
        Provider::ClaudeCli => *CLAUDE.get_or_init(|| cli_works("claude")),
        Provider::CodexCli => *CODEX.get_or_init(|| cli_works("codex")),
    }
}

fn cli_works(cmd: &str) -> bool {
    // Trên Windows các CLI cài qua npm là shim .cmd → chạy qua cmd /c.
    let mut c = shell_command(cmd, &["--version"]);
    c.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
    matches!(c.status(), Ok(s) if s.success())
}

fn shell_command(cmd: &str, args: &[&str]) -> Command {
    // hide_console cho cả `cmd /c` lẫn lệnh trực tiếp: app GUI không có console nên
    // thiếu cờ này là mỗi lần gọi CLI (kể cả `--version`) sẽ nháy một cửa sổ đen.
    let mut c = if cfg!(windows) {
        let mut c = vault_core::proc::command("cmd");
        c.arg("/c").arg(cmd);
        c
    } else {
        vault_core::proc::command(cmd)
    };
    c.args(args);
    c
}

#[derive(Debug, Clone)]
pub struct SourceChunk {
    pub path: String,
    pub heading_path: String,
    pub start_line: i64,
    pub text: String,
}

#[derive(Debug)]
pub struct Answer {
    pub text: String,
    pub provider: &'static str,
    pub sources: Vec<SourceChunk>,
}

/// Reasoning search: nhờ agent CLI sinh các biến thể truy vấn
/// (đồng nghĩa, Anh↔Việt, thuật ngữ liên quan) để tăng recall của BM25.
pub fn expand_query(provider: Provider, question: &str) -> Vec<String> {
    let prompt = format!(
        "Người dùng tìm kiếm trong kho ghi chú cá nhân với truy vấn: \"{question}\"\n\
         Sinh đúng 4 truy vấn tìm kiếm thay thế giúp tìm được ghi chú liên quan: \
         từ đồng nghĩa, cách diễn đạt khác, bản dịch Anh/Việt tương ứng, thuật ngữ chuyên môn liên quan.\n\
         Trả về đúng 4 dòng, mỗi dòng một truy vấn, không đánh số, không giải thích."
    );
    match generate(provider, &prompt) {
        Ok(out) => out
            .lines()
            .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim().to_string())
            .filter(|l| !l.is_empty() && l.len() < 120)
            .take(4)
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Retrieve top-k chunk: FTS trên câu hỏi + các biến thể (reasoning), trộn RRF.
/// `variants` — các truy vấn mở rộng từ `expand_query` (rỗng = chỉ dùng câu gốc).
pub fn retrieve(
    db: &Db,
    question: &str,
    variants: &[String],
    k: usize,
) -> Result<Vec<SourceChunk>> {
    // RRF trên nhiều danh sách: câu gốc (trọng số qua thứ tự) rồi từng biến thể.
    use std::collections::HashMap;
    const RRF_K: f64 = 60.0;
    let mut scores: HashMap<i64, f64> = HashMap::new();

    let mut lists: Vec<Vec<vault_core::db::SearchHit>> = vec![db.search(question, 16)?];
    for v in variants {
        if let Ok(hits) = db.search(v, 8) {
            lists.push(hits);
        }
    }
    for list in &lists {
        for (rank, hit) in list.iter().enumerate() {
            *scores.entry(hit.chunk_id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut ranked: Vec<(i64, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let ids: Vec<i64> = ranked.into_iter().take(k).map(|(id, _)| id).collect();

    let full = db.full_chunks(&ids)?;
    Ok(full
        .into_iter()
        .map(|(path, heading_path, start_line, text)| SourceChunk {
            path,
            heading_path,
            start_line,
            text: truncate_chars(&text, MAX_CHUNK_CHARS),
        })
        .collect())
}

pub fn build_prompt(question: &str, sources: &[SourceChunk]) -> String {
    let mut p = String::with_capacity(4096);
    p.push_str(
        "Bạn là trợ lý hỏi đáp cho một kho ghi chú Markdown cá nhân (vault).\n\
         Chỉ được dùng thông tin trong các TRÍCH ĐOẠN dưới đây để trả lời. Quy tắc bắt buộc:\n\
         - Trả lời bằng ngôn ngữ của câu hỏi, ngắn gọn, đúng trọng tâm.\n\
         - Sau mỗi ý lấy từ trích đoạn nào, chèn citation wikilink của trích đoạn đó, \
           dạng [[đường/dẫn]] hoặc [[đường/dẫn#heading]] (đường dẫn bỏ đuôi .md, giữ nguyên chữ hoa thường).\n\
         - Nếu các trích đoạn không đủ thông tin, trả lời đúng một câu: \
           \"Vault chưa có thông tin về câu hỏi này.\" — tuyệt đối không suy diễn từ kiến thức ngoài.\n\
         - Không nhắc lại quy tắc, không mở bài, trả lời thẳng.\n\nTRÍCH ĐOẠN:\n",
    );
    for (i, s) in sources.iter().enumerate() {
        let target = s.path.trim_end_matches(".md");
        let heading = s.heading_path.rsplit(" > ").next().unwrap_or("");
        let cite = if heading.is_empty() {
            format!("[[{target}]]")
        } else {
            format!("[[{target}#{heading}]]")
        };
        p.push_str(&format!("\n--- [{}] citation: {cite}\n{}\n", i + 1, s.text.trim()));
    }
    p.push_str(&format!("\nCÂU HỎI: {question}\n"));
    p
}

/// Gọi agent CLI với prompt qua stdin (tránh giới hạn độ dài command line của Windows).
pub fn generate(provider: Provider, prompt: &str) -> Result<String> {
    let mut cmd = match provider {
        Provider::ClaudeCli => {
            shell_command("claude", &["-p", "--output-format", "text"])
        }
        // Thư mục tạm không phải git repo → thiếu --skip-git-repo-check là codex
        // chết ngay với đúng một dòng "Not inside a trusted directory".
        Provider::CodexCli => {
            shell_command("codex", &["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"])
        }
    };
    // Chạy trong thư mục tạm: agent không load CLAUDE.md / context của project nào.
    let workdir = std::env::temp_dir().join("second-brain-qa");
    std::fs::create_dir_all(&workdir).ok();
    cmd.current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().with_context(|| {
        format!("không chạy được `{}` — CLI có trên PATH không?", provider.name())
    })?;
    child
        .stdin
        .take()
        .context("stdin không mở được")?
        .write_all(prompt.as_bytes())?;

    // Vét cả hai pipe ở thread riêng: codex nói rất nhiều qua stderr, pipe đầy
    // mà không ai đọc là tiến trình treo cho tới khi hết timeout.
    let mut stdout = child.stdout.take().context("stdout không mở được")?;
    let mut stderr = child.stderr.take().context("stderr không mở được")?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    // Giữ status từ wait_timeout: nó đã reap tiến trình rồi, try_wait sau đó
    // trả None chứ không trả lại exit code.
    let status = child.wait_timeout(LLM_TIMEOUT)?;
    if status.is_none() {
        let _ = child.kill();
    }
    // Join SAU khi tiến trình kết thúc, và join cả hai trước khi bail — pipe
    // còn treo thì thread đọc không bao giờ về.
    let out = reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    let Some(status) = status else {
        bail!("{} không trả lời trong {}s", provider.name(), LLM_TIMEOUT.as_secs());
    };
    if !status.success() {
        match provider {
            Provider::CodexCli => bail!("codex thất bại: {}", explain_codex_failure(&err)),
            Provider::ClaudeCli => {
                bail!("claude thất bại: {}", truncate_chars(err.trim(), 400))
            }
        }
    }
    let text = clean_output(&out, provider);
    if text.is_empty() {
        bail!("{} trả về rỗng", provider.name());
    }
    Ok(text)
}

/// Pipeline đầy đủ: reasoning expand → retrieve → prompt → generate.
pub fn ask(db: &Db, question: &str) -> Result<Answer> {
    let provider = detect_provider().context(
        "không tìm thấy agent CLI nào (cần Claude Code CLI hoặc Codex CLI trên PATH)",
    )?;
    let variants = expand_query(provider, question);
    let sources = retrieve(db, question, &variants, 6)?;
    if sources.is_empty() {
        return Ok(Answer {
            text: "Vault chưa có nội dung nào liên quan để trả lời câu hỏi này.".into(),
            provider: provider.name(),
            sources,
        });
    }
    let prompt = build_prompt(question, &sources);
    let text = generate(provider, &prompt)?;
    Ok(Answer { text, provider: provider.name(), sources })
}

/// Codex exec in kèm log; giữ phần sau dòng trống cuối cùng của khối log đầu.
fn clean_output(out: &str, provider: Provider) -> String {
    match provider {
        Provider::ClaudeCli => out.trim().to_string(),
        Provider::CodexCli => clean_codex_output(out),
    }
}

/// Bỏ dòng log của `codex exec`, giữ lại phần câu trả lời.
pub fn clean_codex_output(out: &str) -> String {
    out.trim()
        .lines()
        .filter(|l| !l.starts_with('[') && !l.to_lowercase().contains("tokens used"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Vì sao `codex exec` chết, nói bằng tiếng người.
///
/// Codex đổ mọi thứ ra stderr và thoát với exit code 1 — in trần "exit code: 1"
/// thì người dùng chẳng biết phải sửa gì. Bắt vài lỗi hay gặp thành lời khuyên
/// cụ thể, còn lại thì trả về dòng ERROR/lỗi cuối cùng thay vì cả trang log.
pub fn explain_codex_failure(stderr: &str) -> String {
    let low = stderr.to_lowercase();
    if low.contains("not inside a trusted directory") {
        return "codex từ chối chạy ngoài git repo/thư mục tin cậy — bản codex này cần cờ \
                --skip-git-repo-check (cài lại app để lấy bản đã sửa), hoặc chạy \
                `codex` một lần trong thư mục vault để tin cậy nó"
            .into();
    }
    if low.contains("requires a newer version of codex") {
        return "model đang chọn cần bản codex mới hơn — chạy `npm i -g @openai/codex` \
                để nâng cấp, hoặc đổi model trong ~/.codex/config.toml"
            .into();
    }
    if low.contains("is not supported when using codex with a chatgpt account") {
        return "model đang chọn không dùng được với tài khoản ChatGPT — đổi model \
                trong ~/.codex/config.toml hoặc đăng nhập bằng API key"
            .into();
    }
    if low.contains("not logged in") || low.contains("please run `codex login`") {
        return "codex chưa đăng nhập — chạy `codex login` trong terminal".into();
    }
    // Dòng ERROR cuối là thứ sát nguyên nhân nhất; không có thì lấy dòng cuối.
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR") || l.to_lowercase().contains("error"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("không có thông tin lỗi");
    truncate_chars(line.trim(), 400)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push_str("\n[…cắt bớt]");
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn giai_thich_loi_codex_hay_gap() {
        // Lỗi hay gặp nhất: vault không phải git repo.
        let e = explain_codex_failure(
            "Not inside a trusted directory and --skip-git-repo-check was not specified.",
        );
        assert!(e.contains("skip-git-repo-check"), "{e}");

        let e = explain_codex_failure(
            r#"ERROR: {""message"":""The 'gpt-6-astra' model requires a newer version of Codex.""}"#,
        );
        assert!(e.contains("nâng cấp") || e.contains("npm i -g"), "{e}");

        let e = explain_codex_failure(
            "ERROR: The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
        );
        assert!(e.contains("ChatGPT"), "{e}");
    }

    #[test]
    fn loi_la_thi_lay_dong_error_cuoi_cung() {
        let log = "OpenAI Codex v0.145.0\nworkdir: D:\\\\vault\nERROR: quota exceeded\n";
        let e = explain_codex_failure(log);
        assert_eq!(e, "ERROR: quota exceeded");

        // Không có dòng ERROR nào → lấy dòng cuối còn chữ, không trả rỗng.
        let e = explain_codex_failure("dòng một\ndòng hai\n\n");
        assert_eq!(e, "dòng hai");
        assert!(!explain_codex_failure("").is_empty());
    }

    #[test]
    fn loc_log_cua_codex_exec() {
        let out = "[2026-09-12] meta\nCâu trả lời thật\ntokens used: 1234";
        assert_eq!(clean_codex_output(out), "Câu trả lời thật");
    }

    #[test]
    fn prompt_contains_citations_and_question() {
        let sources = vec![SourceChunk {
            path: "Tech/Rust.md".into(),
            heading_path: "Rust > Ownership".into(),
            start_line: 1,
            text: "Ownership là mô hình quản lý bộ nhớ.".into(),
        }];
        let p = build_prompt("ownership là gì?", &sources);
        assert!(p.contains("[[Tech/Rust#Ownership]]"));
        assert!(p.contains("CÂU HỎI: ownership là gì?"));
        assert!(p.contains("Ownership là mô hình"));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        let s = "ăâđêôơư".repeat(300);
        let t = truncate_chars(&s, 100);
        assert!(t.chars().count() <= 120);
    }
}
