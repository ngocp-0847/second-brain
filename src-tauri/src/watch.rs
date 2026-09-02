//! Theo dõi vault trên đĩa và "bắt hook" của Claude Code.
//!
//! Hai nguồn sự kiện, một vòng lặp:
//! 1. **File watcher** (notify, debounce 400ms) trên toàn vault: file .md/.canvas đổi
//!    bởi bất kỳ ai (agent trong terminal, editor ngoài, git pull) → re-index, đẩy bản
//!    cũ vào revision history, phát `vault-changed` cho UI reload cây + note đang mở.
//!    Thay đổi do chính app ghi (autosave) được lọc qua `recent_writes` để UI không
//!    tự reload chính nội dung mình vừa gõ.
//! 2. **Hook Claude Code**: phiên `claude` trong terminal được spawn với `--settings`
//!    khai báo hook PostToolUse(Edit|Write|…) + Stop. Hook gọi lại chính exe này ở chế
//!    độ `--hook-sink` để nối JSON stdin vào `.brain/agent-events.jsonl`. Watcher đọc
//!    phần mới của file đó → gắn nhãn `source = "claude"` cho revision và phát
//!    `agent-turn` (kèm danh sách note đã sửa) khi Claude kết thúc một lượt.

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

/// Tên file log hook trong `.brain/` — hook của Claude nối từng dòng JSON vào đây.
pub const AGENT_EVENTS: &str = "agent-events.jsonl";
/// Nguồn ghi vào revision khi biết chắc là Claude Code sửa.
pub const SOURCE_CLAUDE: &str = "claude";
/// App vừa ghi path này trong khoảng đó → coi event watcher là echo của chính mình.
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);
/// Quá ngưỡng này lúc mở vault thì xoá log hook cũ (mỗi payload PostToolUse ~1–3KB).
const MAX_EVENTS_BYTES: u64 = 8 * 1024 * 1024;

pub type Handle = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

#[derive(Clone, Serialize)]
struct VaultChanged {
    /// Path tương đối (dấu `/`) của file/thư mục đổi từ bên ngoài app.
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
struct AgentTurn {
    /// Note Claude đã sửa trong lượt vừa kết thúc (rỗng nếu chỉ trả lời).
    files: Vec<String>,
    session_id: Option<String>,
}

/// Bắt đầu watch `root`. Drop `Handle` trả về là dừng: debouncer đóng kênh, thread thoát.
pub fn start(app: AppHandle, root: PathBuf) -> anyhow::Result<Handle> {
    let (tx, rx) = mpsc::channel::<DebounceEventResult>();
    let mut deb = new_debouncer(Duration::from_millis(400), tx)?;
    deb.watcher().watch(&root, RecursiveMode::Recursive)?;

    let events_file = root.join(".brain").join(AGENT_EVENTS);
    // Log hook chỉ có giá trị trong phiên đang chạy → quá lớn thì xoá, không cần rotate.
    let mut offset = std::fs::metadata(&events_file).map(|m| m.len()).unwrap_or(0);
    if offset > MAX_EVENTS_BYTES {
        let _ = std::fs::remove_file(&events_file);
        offset = 0;
    }
    // Bỏ qua event cũ còn sót từ phiên trước: chỉ đọc phần được nối thêm từ giờ.
    let mut pending_agent_files: BTreeSet<String> = BTreeSet::new();

    std::thread::spawn(move || {
        for batch in rx {
            let Ok(events) = batch else { continue };
            let mut changed: BTreeSet<String> = BTreeSet::new();
            let mut agent_hit = false;
            for e in events {
                let Some(rel) = rel_path(&root, &e.path) else { continue };
                if rel.is_empty() {
                    continue;
                }
                // Thư mục ẩn (.brain, .git, .obsidian, .claude…) không phải nội dung vault —
                // trừ đúng file log hook.
                if rel.starts_with('.') {
                    if rel == format!(".brain/{AGENT_EVENTS}") {
                        agent_hit = true;
                    }
                    continue;
                }
                changed.insert(rel);
            }
            // Hook trước, watcher sau: nhãn "claude" phải vào shadow trước khi
            // bản đó bị so với đĩa (xem History::track).
            if agent_hit {
                consume_agent_events(&app, &root, &events_file, &mut offset, &mut pending_agent_files);
            }
            if !changed.is_empty() {
                on_vault_changed(&app, &root, changed);
            }
        }
    });
    Ok(deb)
}

fn rel_path(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn is_note(rel: &str) -> bool {
    rel.ends_with(".md") || rel.ends_with(".canvas")
}

/// File .md/.canvas đổi trên đĩa: re-index + revision + báo UI (trừ echo của chính app).
fn on_vault_changed(app: &AppHandle, root: &Path, changed: BTreeSet<String>) {
    let state = app.state::<AppState>();

    let external: Vec<String> = {
        let now = Instant::now();
        let mut recent = match state.recent_writes.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        recent.retain(|_, t| now.duration_since(*t) < SELF_WRITE_WINDOW);
        changed.into_iter().filter(|p| !recent.contains_key(p)).collect()
    };
    if external.is_empty() {
        return;
    }

    // Vault có thể đã bị đổi sang thư mục khác trong lúc event còn trên kênh.
    if let Ok(mut g) = state.vault.lock() {
        match g.as_mut() {
            Some(v) if v.root == root => {
                let _ = v.index();
            }
            _ => return,
        }
    }

    if let Ok(h) = state.history.lock() {
        if let Some(h) = h.as_ref() {
            for p in external.iter().filter(|p| is_note(p)) {
                if let Ok(content) = std::fs::read_to_string(root.join(p)) {
                    let _ = h.track(p, &content, true, None);
                }
            }
        }
    }

    let _ = app.emit("vault-changed", VaultChanged { paths: external });
}

/// Đọc phần mới của `.brain/agent-events.jsonl` (mỗi dòng = một payload hook của Claude Code).
fn consume_agent_events(
    app: &AppHandle,
    root: &Path,
    file: &Path,
    offset: &mut u64,
    pending: &mut BTreeSet<String>,
) {
    let Ok(mut f) = std::fs::File::open(file) else { return };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0; // file bị xoá/ghi lại
    }
    if f.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_err() {
        return;
    }
    // Dòng cuối chưa có '\n' = hook đang ghi dở → để lần sau.
    let complete = match buf.rfind('\n') {
        Some(i) => &buf[..=i],
        None => return,
    };
    *offset += complete.len() as u64;

    for line in complete.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let event = v.get("hook_event_name").and_then(|s| s.as_str()).unwrap_or("");
        match event {
            "PostToolUse" => {
                let input = v.get("tool_input");
                let fp = input
                    .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
                    .and_then(|s| s.as_str());
                let Some(fp) = fp else { continue };
                let abs = PathBuf::from(fp);
                let abs = if abs.is_absolute() { abs } else { root.join(abs) };
                let Some(rel) = rel_path(root, &abs) else { continue };
                if !is_note(&rel) || rel.starts_with('.') {
                    continue;
                }
                pending.insert(rel.clone());
                if let Ok(content) = std::fs::read_to_string(&abs) {
                    label_claude(app, &rel, &content);
                }
            }
            "Stop" => {
                let files: Vec<String> = std::mem::take(pending).into_iter().collect();
                let session_id = v.get("session_id").and_then(|s| s.as_str()).map(String::from);
                let _ = app.emit("agent-turn", AgentTurn { files, session_id });
            }
            _ => {}
        }
    }
}

/// Ghi nhận bản nội dung hiện tại của `rel` là do Claude tạo ra (revision + nhãn nguồn).
fn label_claude(app: &AppHandle, rel: &str, content: &str) {
    let state = app.state::<AppState>();
    let guard = state.history.lock();
    if let Ok(h) = &guard {
        if let Some(h) = h.as_ref() {
            let _ = h.track(rel, content, true, Some(SOURCE_CLAUDE));
        }
    }
}

/// Chế độ `second-brain.exe --hook-sink <file>`: đọc stdin (JSON của hook Claude Code),
/// nén về một dòng và nối vào `file`. Chạy trước Tauri, không mở cửa sổ.
pub fn hook_sink(file: &str) {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let line = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v.to_string(),
        Err(_) => raw.split_whitespace().collect::<Vec<_>>().join(" "),
    };
    if line.is_empty() {
        return;
    }
    let path = Path::new(file);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Dựng dòng lệnh khởi động `claude` trong terminal: nếu có vault thì kèm `--settings`
/// trỏ tới file hook (ghi mới mỗi lần để đường dẫn exe luôn đúng bản đang chạy).
pub fn claude_command(root: Option<&Path>) -> String {
    let Some(root) = root else { return "claude".into() };
    let Ok(exe) = std::env::current_exe() else { return "claude".into() };
    let brain = root.join(".brain");
    if std::fs::create_dir_all(&brain).is_err() {
        return "claude".into();
    }
    // Dấu `/` để cùng một chuỗi chạy được dù hook được shell nào thực thi (cmd, sh, pwsh).
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let sink = format!(
        "\"{}\" --hook-sink \"{}\"",
        fwd(&exe),
        fwd(&brain.join(AGENT_EVENTS))
    );
    let hook = serde_json::json!({ "type": "command", "command": sink, "timeout": 10 });
    let settings = serde_json::json!({
        "hooks": {
            "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [hook] }],
            "Stop": [{ "hooks": [hook] }]
        }
    });
    let settings_path = brain.join("claude-hooks.json");
    if std::fs::write(&settings_path, settings.to_string()).is_err() {
        return "claude".into();
    }
    format!("claude --settings \"{}\"", fwd(&settings_path))
}
