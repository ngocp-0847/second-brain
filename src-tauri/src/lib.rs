//! Tauri shell: expose vault-core cho UI qua các command.
//! WebView chỉ render; mọi việc nặng (parse/index/search/refactor) chạy ở đây.

mod agent;
mod git;
mod history;
mod terminal;

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use vault_core::Vault;

#[derive(Default)]
struct AppState {
    vault: Mutex<Option<Vault>>,
    /// "auto" | "claude" | "codex"
    llm_pref: Mutex<String>,
    /// Revision history (.brain/history.db) — best-effort, lỗi không chặn thao tác note.
    history: Mutex<Option<history::History>>,
}

/// Chạy thao tác history best-effort: chưa mở vault / lỗi DB → bỏ qua trong im lặng.
fn with_history<T>(
    state: &State<AppState>,
    f: impl FnOnce(&history::History) -> anyhow::Result<T>,
) -> Option<T> {
    let guard = state.history.lock().ok()?;
    let h = guard.as_ref()?;
    f(h).ok()
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Không cho cửa sổ console nháy lên khi app GUI spawn process con (git, agent CLI).
pub(crate) use vault_core::proc::hide_console;

#[derive(Serialize)]
struct NoteMeta {
    path: String,
    title: String,
    /// Unix epoch giây — UI dùng để sắp "sửa gần đây".
    mtime: i64,
}

#[derive(Serialize)]
struct VaultInfo {
    root: String,
    notes: Vec<NoteMeta>,
    dirs: Vec<String>,
    stats: Stats,
}

#[derive(Serialize)]
struct Stats {
    notes: i64,
    links: i64,
    broken: i64,
    tags: i64,
    chunks: i64,
    index_ms: u128,
}

#[derive(Serialize)]
struct SearchHitDto {
    path: String,
    title: String,
    heading_path: String,
    start_line: i64,
    snippet: String,
}

#[derive(Serialize)]
struct BacklinkDto {
    src_path: String,
    src_title: String,
    kind: String,
}

fn with_vault<T>(state: &State<AppState>, f: impl FnOnce(&mut Vault) -> anyhow::Result<T>) -> CmdResult<T> {
    let mut guard = state.vault.lock().map_err(err)?;
    let vault = guard.as_mut().ok_or("chưa mở vault nào")?;
    f(vault).map_err(err)
}

fn vault_info(vault: &mut Vault, index_ms: u128) -> anyhow::Result<VaultInfo> {
    let notes = vault
        .db
        .note_list()?
        .into_iter()
        .map(|(path, title, mtime)| NoteMeta { path, title, mtime })
        .collect();
    let (n, l, b, t, c) = vault.db.stats()?;
    let mut dirs = vault.list_dirs();
    dirs.sort();
    Ok(VaultInfo {
        root: vault.root.to_string_lossy().into_owned(),
        notes,
        dirs,
        stats: Stats { notes: n, links: l, broken: b, tags: t, chunks: c, index_ms },
    })
}

#[tauri::command]
fn open_vault(path: String, state: State<AppState>) -> CmdResult<VaultInfo> {
    // Không có guard này thì Db::open sẽ create_dir_all và âm thầm dựng lại một
    // vault rỗng khi path đã biến mất (folder bị xoá, ổ rời rút ra, drive unmount).
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("Không tìm thấy thư mục vault: {path}"));
    }
    let mut vault = Vault::open(&path).map_err(err)?;
    let stats = vault.index().map_err(err)?;
    let info = vault_info(&mut vault, stats.duration_ms).map_err(err)?;
    *state.history.lock().map_err(err)? = history::History::open(&vault.root.join(".brain")).ok();
    *state.vault.lock().map_err(err)? = Some(vault);
    Ok(info)
}

#[tauri::command]
fn refresh(state: State<AppState>) -> CmdResult<VaultInfo> {
    with_vault(&state, |v| {
        let stats = v.index()?;
        vault_info(v, stats.duration_ms)
    })
}

#[tauri::command]
fn read_note(path: String, state: State<AppState>) -> CmdResult<String> {
    let content = with_vault(&state, |v| {
        let abs = v.abs_path(&path)?;
        Ok(std::fs::read_to_string(abs)?)
    })?;
    // Nội dung trên đĩa khác bản app biết (agent AI / tool ngoài vừa sửa)
    // → bản cũ vào revision ngay (force).
    with_history(&state, |h| h.track(&path, &content, true));
    Ok(content)
}

#[tauri::command]
/// `with_info` = true thì trả luôn VaultInfo đã index: trước đây editor phải gọi
/// thêm `refresh()` ngay sau mỗi lần lưu, tức là quét + index toàn vault HAI lần
/// cho một nhịp gõ. Canvas thì không cần, và vault_info có `list_dirs` (walkdir)
/// nên bắt nó dựng info mỗi 600ms lúc kéo node là phí.
fn write_note(
    path: String,
    content: String,
    with_info: Option<bool>,
    state: State<AppState>,
) -> CmdResult<Option<VaultInfo>> {
    let info = with_vault(&state, |v| {
        let abs = v.abs_path(&path)?;
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(abs, &content)?;
        let stats = v.index()?;
        if with_info.unwrap_or(false) {
            Ok(Some(vault_info(v, stats.duration_ms)?))
        } else {
            Ok(None)
        }
    })?;
    // Bản trước save vào revision theo interval gộp 2 phút (kiểu Obsidian).
    with_history(&state, |h| h.track(&path, &content, false));
    Ok(info)
}

#[tauri::command]
fn create_note(path: String, state: State<AppState>) -> CmdResult<String> {
    with_vault(&state, |v| {
        let mut rel = path.replace('\\', "/");
        if !rel.to_lowercase().ends_with(".md") {
            rel.push_str(".md");
        }
        let abs = v.abs_path(&rel)?;
        if abs.exists() {
            anyhow::bail!("đã tồn tại: {rel}");
        }
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let stem = std::path::Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled");
        std::fs::write(abs, format!("# {stem}\n\n"))?;
        v.index()?;
        Ok(rel)
    })
}

/// Đường dẫn assets/<name> chưa bị chiếm (trùng thì thêm hậu tố số).
fn unique_asset_path(root: &std::path::Path, name: &str) -> anyhow::Result<(String, std::path::PathBuf)> {
    let name = name.replace(['/', '\\'], "_");
    std::fs::create_dir_all(root.join("assets"))?;
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name.as_str(), "png"));
    let mut rel = format!("assets/{stem}.{ext}");
    let mut i = 1;
    while root.join(&rel).exists() {
        rel = format!("assets/{stem} {i}.{ext}");
        i += 1;
    }
    let abs = root.join(&rel);
    Ok((rel, abs))
}

/// Lưu ảnh dán từ clipboard (base64) vào assets/ của vault, trả về path tương đối.
#[tauri::command]
fn save_asset(name: String, data_base64: String, state: State<AppState>) -> CmdResult<String> {
    use base64::Engine;
    with_vault(&state, |v| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&data_base64)?;
        let (rel, abs) = unique_asset_path(&v.root, &name)?;
        std::fs::write(abs, bytes)?;
        Ok(rel)
    })
}

/// Copy một file ngoài vault (chọn qua dialog) vào assets/, trả về path tương đối.
#[tauri::command]
fn import_asset(src: String, state: State<AppState>) -> CmdResult<String> {
    with_vault(&state, |v| {
        let name = std::path::Path::new(&src)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow::anyhow!("đường dẫn không hợp lệ: {src}"))?;
        let (rel, abs) = unique_asset_path(&v.root, name)?;
        std::fs::copy(&src, abs)?;
        Ok(rel)
    })
}

/// Đọc file nhị phân trong vault dưới dạng base64 (hiển thị ảnh trong canvas).
#[tauri::command]
fn read_asset(path: String, state: State<AppState>) -> CmdResult<String> {
    use base64::Engine;
    with_vault(&state, |v| {
        let abs = v.abs_path(&path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(abs)?))
    })
}

#[tauri::command]
fn create_folder(path: String, state: State<AppState>) -> CmdResult<String> {
    with_vault(&state, |v| {
        let rel = path.replace('\\', "/");
        let rel = rel.trim_matches('/').to_string();
        if rel.is_empty() {
            anyhow::bail!("tên thư mục rỗng");
        }
        let abs = v.abs_path(&rel)?;
        if abs.exists() {
            anyhow::bail!("đã tồn tại: {rel}");
        }
        std::fs::create_dir_all(&abs)?;
        Ok(rel)
    })
}

#[tauri::command]
fn rename_folder(from: String, to: String, state: State<AppState>) -> CmdResult<()> {
    with_vault(&state, |v| v.rename_dir(&from, &to))?;
    Ok(())
}

#[tauri::command]
fn rename_note(from: String, to: String, state: State<AppState>) -> CmdResult<usize> {
    let n = with_vault(&state, |v| v.rename_note(&from, &to))?;
    // Mang lịch sử revision theo path mới (chuẩn hóa giống UI: thêm .md, / thay \).
    let to_norm = {
        let t = to.trim().replace('\\', "/");
        if t.to_lowercase().ends_with(".md") { t } else { format!("{t}.md") }
    };
    with_history(&state, |h| h.rename(&from, &to_norm));
    Ok(n)
}

#[tauri::command]
fn trash_note(path: String, state: State<AppState>) -> CmdResult<()> {
    // Snapshot nội dung trước khi vào thùng rác — xóa nhầm vẫn cứu được từ 🕘.
    let content = with_vault(&state, |v| {
        let abs = v.abs_path(&path)?;
        Ok(std::fs::read_to_string(abs).unwrap_or_default())
    });
    if let Ok(c) = content {
        with_history(&state, |h| h.track(&path, &c, true));
    }
    with_vault(&state, |v| v.trash_note(&path))
}

/// Đổi tên / di chuyển file KHÔNG phải note (canvas…). Chỉ move trên đĩa: các
/// file này không nằm trong link graph nên không có wikilink nào để rewrite.
/// Tự giữ lại đuôi gốc nếu tên mới thiếu. Trả về path tương đối mới.
#[tauri::command]
fn rename_file(from: String, to: String, state: State<AppState>) -> CmdResult<String> {
    let to_norm = with_vault(&state, |v| {
        let from_abs = v.abs_path(&from)?;
        let ext = std::path::Path::new(&from)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let mut to_norm = to.trim().replace('\\', "/");
        if !ext.is_empty() && !to_norm.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase()))
        {
            to_norm = format!("{to_norm}.{ext}");
        }
        let to_abs = v.abs_path(&to_norm)?;
        if to_abs.exists() {
            anyhow::bail!("đích đã tồn tại: {to_norm}");
        }
        if let Some(dir) = to_abs.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&from_abs, &to_abs)?;
        v.index()?;
        Ok(to_norm)
    })?;
    // Canvas cũng được ghi qua write_note nên có revision — mang theo path mới.
    with_history(&state, |h| h.rename(&from, &to_norm));
    Ok(to_norm)
}

/// Xóa cả folder (vào .brain/trash). Không snapshot từng note bên trong —
/// thùng rác giữ nguyên cây thư mục nên khôi phục tay được.
#[tauri::command]
fn trash_folder(path: String, state: State<AppState>) -> CmdResult<()> {
    with_vault(&state, |v| v.trash_dir(&path))
}

/// Nhân bản note, trả về path tương đối của bản sao.
#[tauri::command]
fn duplicate_note(path: String, state: State<AppState>) -> CmdResult<String> {
    with_vault(&state, |v| v.duplicate_note(&path))
}

/// Đường dẫn tuyệt đối (dạng native, để copy hoặc đưa cho shell).
/// `path` rỗng → thư mục gốc của vault.
#[tauri::command]
fn abs_path(path: String, state: State<AppState>) -> CmdResult<String> {
    with_vault(&state, |v| {
        let p = if path.is_empty() { v.root.clone() } else { v.abs_path(&path)? };
        Ok(p.to_string_lossy().into_owned())
    })
}

/// Mở File Explorer và chọn sẵn file. `path` rỗng → mở thư mục vault.
#[tauri::command]
fn reveal_in_explorer(path: String, state: State<AppState>) -> CmdResult<()> {
    let abs = abs_path(path.clone(), state)?;
    #[cfg(windows)]
    {
        // explorer trả exit code khác 0 kể cả khi thành công → không check status.
        let mut c = vault_core::proc::command("explorer");
        if path.is_empty() {
            c.arg(&abs);
        } else {
            c.arg(format!("/select,{abs}"));
        }
        c.spawn().map_err(err)?;
    }
    #[cfg(not(windows))]
    {
        let dir = std::path::Path::new(&abs).parent().unwrap_or(std::path::Path::new(&abs));
        vault_core::proc::command("xdg-open").arg(dir).spawn().map_err(err)?;
    }
    Ok(())
}

/// Mở file bằng app mặc định của hệ điều hành.
#[tauri::command]
fn open_external(path: String, state: State<AppState>) -> CmdResult<()> {
    let abs = abs_path(path, state)?;
    #[cfg(windows)]
    // `start` là lệnh nội bộ của cmd nên phải qua `cmd /C`; tham số "" là tiêu đề
    // cửa sổ — thiếu nó thì start hiểu nhầm đường dẫn có dấu nháy là tiêu đề.
    vault_core::proc::command("cmd").args(["/C", "start", "", &abs]).spawn().map_err(err)?;
    #[cfg(not(windows))]
    vault_core::proc::command("xdg-open").arg(&abs).spawn().map_err(err)?;
    Ok(())
}

/// Mở note (hoặc canvas) trong một cửa sổ riêng. Cửa sổ con dùng chung AppState
/// (cùng process) nên thấy ngay vault đang mở; `?note=` báo cho UI biết chỉ mở
/// đúng file đó.
#[tauri::command]
fn open_note_window(path: String, app: AppHandle) -> CmdResult<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let title = path
        .rsplit('/')
        .next()
        .unwrap_or(&path)
        .trim_end_matches(".md")
        .trim_end_matches(".canvas")
        .to_string();
    let url = format!("index.html?note={}", urlencode(&path));
    WebviewWindowBuilder::new(&app, format!("note-{n}"), WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 700.0)
        .build()
        .map_err(err)?;
    Ok(())
}

/// Percent-encode đủ dùng cho query string (không kéo thêm dependency).
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Danh sách revision của một note (mới nhất trước).
#[tauri::command]
fn note_history(path: String, state: State<AppState>) -> CmdResult<Vec<history::RevisionMeta>> {
    with_history(&state, |h| h.list(&path)).ok_or_else(|| "chưa mở vault".to_string())
}

/// Nội dung đầy đủ của một revision.
#[tauri::command]
fn history_get(id: i64, state: State<AppState>) -> CmdResult<String> {
    with_history(&state, |h| h.get(id)).ok_or_else(|| "không tìm thấy revision".to_string())
}

/// Search từ khóa (FTS5/BM25).
#[tauri::command]
fn search_notes(query: String, limit: usize, state: State<AppState>) -> CmdResult<Vec<SearchHitDto>> {
    with_vault(&state, |v| Ok(v.db.search(&query, limit)?.into_iter().map(hit_dto).collect()))
}

#[derive(Serialize)]
struct RelatedDto {
    path: String,
    title: String,
    reason: String,
}

/// Note liên quan với note đang mở (tag chung / đồng trích dẫn / trùng từ khóa).
#[tauri::command]
fn related_notes(path: String, state: State<AppState>) -> CmdResult<Vec<RelatedDto>> {
    with_vault(&state, |v| {
        Ok(v.db
            .related_notes(&path, 8)?
            .into_iter()
            .map(|r| RelatedDto { path: r.path, title: r.title, reason: r.reason })
            .collect())
    })
}

/// Chỗ nhắc tới tên note nhưng chưa link.
#[tauri::command]
fn unlinked_mentions(path: String, state: State<AppState>) -> CmdResult<Vec<SearchHitDto>> {
    with_vault(&state, |v| {
        Ok(v.db.unlinked_mentions(&path, 20)?.into_iter().map(hit_dto).collect())
    })
}

#[derive(Serialize)]
struct AnswerDto {
    answer: String,
    provider: String,
    sources: Vec<SourceDto>,
}

#[derive(Serialize)]
struct SourceDto {
    path: String,
    heading_path: String,
    start_line: i64,
}

/// Hỏi đáp RAG. Chạy trên thread pool của tauri; lock vault chỉ trong lúc retrieve,
/// còn 2 lần gọi agent CLI (expand + generate) diễn ra ngoài lock.
#[derive(Serialize)]
struct LlmSettings {
    pref: String,
    claude_ok: bool,
    codex_ok: bool,
    active: Option<String>,
}

#[tauri::command]
fn get_llm_settings(state: State<AppState>) -> CmdResult<LlmSettings> {
    let pref = state.llm_pref.lock().map_err(err)?.clone();
    let active = qa::provider_from_pref(&pref).map(|p| p.name().to_string());
    Ok(LlmSettings {
        pref,
        claude_ok: qa::provider_available(qa::Provider::ClaudeCli),
        codex_ok: qa::provider_available(qa::Provider::CodexCli),
        active,
    })
}

#[tauri::command]
fn set_llm_pref(pref: String, state: State<AppState>) -> CmdResult<()> {
    if !["auto", "claude", "codex"].contains(&pref.as_str()) {
        return Err("giá trị không hợp lệ".into());
    }
    *state.llm_pref.lock().map_err(err)? = pref;
    Ok(())
}

#[tauri::command(async)]
fn ask_vault(question: String, state: State<AppState>) -> CmdResult<AnswerDto> {
    let pref = state.llm_pref.lock().map_err(err)?.clone();
    let provider = qa::provider_from_pref(&pref)
        .ok_or("không tìm thấy Claude Code CLI hoặc Codex CLI trên PATH (kiểm tra Settings ⚙)")?;

    let variants = qa::expand_query(provider, &question);
    let sources = with_vault(&state, |v| qa::retrieve(&v.db, &question, &variants, 6))?;
    if sources.is_empty() {
        return Ok(AnswerDto {
            answer: "Vault chưa có nội dung nào liên quan để trả lời câu hỏi này.".into(),
            provider: provider.name().into(),
            sources: Vec::new(),
        });
    }
    let prompt = qa::build_prompt(&question, &sources);
    let answer = qa::generate(provider, &prompt).map_err(err)?;
    Ok(AnswerDto {
        answer,
        provider: provider.name().into(),
        sources: sources
            .into_iter()
            .map(|s| SourceDto {
                path: s.path,
                heading_path: s.heading_path,
                start_line: s.start_line,
            })
            .collect(),
    })
}

/// Sync GitHub: add → commit → push trong vault (chạy git CLI).
#[tauri::command(async)]
fn git_sync(state: State<AppState>) -> CmdResult<String> {
    let root = with_vault(&state, |v| Ok(v.root.clone()))?;
    git::sync(&root).map_err(err)
}

/// Chat với agent (Claude Code / Codex headless, cwd = vault) — agent được phép sửa file.
#[tauri::command(async)]
fn agent_chat(
    message: String,
    context_path: Option<String>,
    session_id: Option<String>,
    app: AppHandle,
    state: State<AppState>,
) -> CmdResult<agent::AgentReply> {
    let pref = state.llm_pref.lock().map_err(err)?.clone();
    let provider = qa::provider_from_pref(&pref)
        .ok_or("không tìm thấy Claude Code CLI hoặc Codex CLI trên PATH (kiểm tra Settings ⚙)")?;
    let root = with_vault(&state, |v| Ok(v.root.clone()))?;
    // Lưới an toàn: git snapshot cả vault trước khi cho agent sửa file.
    let _ = janitor::snapshot(&root, "agent");
    agent::chat(&app, provider, &root, &message, context_path.as_deref(), session_id.as_deref())
        .map_err(err)
}

/// Sửa vùng chọn trong editor bằng agent: trả về text mới cho ĐÚNG vùng đó,
/// UI tự thay vào (không ghi file ở đây → Ctrl+Z hoàn tác được).
#[tauri::command(async)]
fn agent_transform(
    selection: String,
    instruction: String,
    context_path: Option<String>,
    state: State<AppState>,
) -> CmdResult<String> {
    if selection.trim().is_empty() {
        return Err("vùng chọn rỗng".into());
    }
    if instruction.trim().is_empty() {
        return Err("chưa nhập yêu cầu".into());
    }
    let pref = state.llm_pref.lock().map_err(err)?.clone();
    let provider = qa::provider_from_pref(&pref)
        .ok_or("không tìm thấy Claude Code CLI hoặc Codex CLI trên PATH (kiểm tra Settings ⚙)")?;
    agent::transform(provider, &selection, &instruction, context_path.as_deref()).map_err(err)
}

#[tauri::command]
fn term_open(
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<AppState>,
    term: State<terminal::TermState>,
) -> CmdResult<u32> {
    let cwd = state.vault.lock().ok().and_then(|g| g.as_ref().map(|v| v.root.clone()));
    let run_claude = qa::provider_available(qa::Provider::ClaudeCli);
    terminal::open(app, &term, cwd, cols, rows, run_claude).map_err(err)
}

#[tauri::command]
fn term_write(id: u32, data: String, term: State<terminal::TermState>) -> CmdResult<()> {
    terminal::write(&term, id, &data).map_err(err)
}

#[tauri::command]
fn term_resize(id: u32, cols: u16, rows: u16, term: State<terminal::TermState>) -> CmdResult<()> {
    terminal::resize(&term, id, cols, rows).map_err(err)
}

#[tauri::command]
fn term_kill(id: u32, term: State<terminal::TermState>) -> CmdResult<()> {
    terminal::kill(&term, id);
    Ok(())
}

#[tauri::command(async)]
fn janitor_run(app: AppHandle, state: State<AppState>) -> CmdResult<janitor::Report> {
    let report = with_vault(&state, |v| janitor::run(v))?;
    let pref = state.llm_pref.lock().map_err(err)?.clone();
    let root = with_vault(&state, |v| Ok(v.root.clone()))?;
    spawn_janitor_tier2(app, root, pref);
    Ok(report)
}

/// Tầng 2 (LLM sinh MOC) chạy nền với Vault connection riêng —
/// không giữ lock của app trong lúc chờ agent CLI (có thể cả phút).
fn spawn_janitor_tier2(app: AppHandle, root: std::path::PathBuf, pref: String) {
    use tauri::Emitter;
    let Some(provider) = qa::provider_from_pref(&pref) else { return };
    std::thread::spawn(move || {
        let Ok(mut vault) = Vault::open(&root) else { return };
        if let Ok(rows) = janitor::append_tier2(&mut vault, provider) {
            if !rows.is_empty() {
                if let Ok(Some(r)) = janitor::latest_report(&vault) {
                    let _ = app.emit("janitor-report-ready", &r);
                }
            }
        }
    });
}

#[tauri::command]
fn janitor_latest(state: State<AppState>) -> CmdResult<Option<janitor::Report>> {
    with_vault(&state, |v| janitor::latest_report(v))
}

#[tauri::command]
fn janitor_apply(action_id: i64, state: State<AppState>) -> CmdResult<String> {
    let msg = with_vault(&state, |v| janitor::apply_action(v, action_id))?;
    Ok(msg)
}

#[tauri::command]
fn janitor_dismiss(action_id: i64, state: State<AppState>) -> CmdResult<()> {
    with_vault(&state, |v| janitor::dismiss_action(v, action_id))
}

/// Scheduler hằng đêm: kiểm tra mỗi 30 phút, chạy khi lần trước đã quá 24h.
/// (App thường mở cả ngày; lần chạy sẽ rơi vào lúc đêm/sáng sớm một cách tự nhiên.
/// Ai muốn đúng 02:00 kể cả khi app đóng → cron `brain janitor` qua Task Scheduler.)
fn spawn_nightly_janitor(app: AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30 * 60));
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let state = app.state::<AppState>();
        let report = {
            let mut guard = match state.vault.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let Some(v) = guard.as_mut() else { continue };
            let due = janitor::last_run_age(v, now_secs).map(|age| age > 24 * 3600).unwrap_or(true);
            if !due {
                continue;
            }
            (janitor::run(v), v.root.clone())
        };
        let (report, root) = report;
        if let Ok(r) = report {
            let _ = app.emit("janitor-report-ready", &r);
            let pref = state.llm_pref.lock().map(|g| g.clone()).unwrap_or_default();
            spawn_janitor_tier2(app.clone(), root, pref);
        }
    });
}

#[derive(Serialize)]
struct GraphNode {
    path: String,
    title: String,
    degree: i64,
}

#[derive(Serialize)]
struct GraphEdge {
    from: String,
    to: String,
}

#[derive(Serialize)]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

#[tauri::command]
fn graph_data(state: State<AppState>) -> CmdResult<GraphData> {
    with_vault(&state, |v| {
        let nodes = {
            let mut stmt = v.db.conn.prepare(
                r#"SELECT n.path, n.title,
                          (SELECT COUNT(*) FROM link WHERE target_note = n.id)
                          + (SELECT COUNT(*) FROM link WHERE src_note = n.id AND target_note IS NOT NULL)
                   FROM note n"#,
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(GraphNode { path: r.get(0)?, title: r.get(1)?, degree: r.get(2)? })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let edges = {
            let mut stmt = v.db.conn.prepare(
                r#"SELECT DISTINCT s.path, t.path
                   FROM link l JOIN note s ON s.id = l.src_note JOIN note t ON t.id = l.target_note"#,
            )?;
            let rows = stmt
                .query_map([], |r| Ok(GraphEdge { from: r.get(0)?, to: r.get(1)? }))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        Ok(GraphData { nodes, edges })
    })
}

/// Liệt kê file .canvas trong vault (định dạng JSON Canvas tương thích Obsidian).
#[tauri::command]
fn list_canvases(state: State<AppState>) -> CmdResult<Vec<String>> {
    with_vault(&state, |v| {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(&v.root)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir()
                    && [".brain", ".obsidian", ".trash", ".git"].contains(&name.as_ref()))
            })
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("canvas"))
            {
                if let Ok(rel) = entry.path().strip_prefix(&v.root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        out.sort();
        Ok(out)
    })
}

fn hit_dto(h: vault_core::db::SearchHit) -> SearchHitDto {
    SearchHitDto {
        path: h.path,
        title: h.title,
        heading_path: h.heading_path,
        start_line: h.start_line,
        snippet: h.snippet,
    }
}

#[tauri::command]
fn backlinks(path: String, state: State<AppState>) -> CmdResult<Vec<BacklinkDto>> {
    with_vault(&state, |v| {
        Ok(v.db
            .backlinks(&path)?
            .into_iter()
            .map(|b| BacklinkDto { src_path: b.src_path, src_title: b.src_title, kind: b.kind })
            .collect())
    })
}

#[tauri::command]
fn resolve_link(target: String, state: State<AppState>) -> CmdResult<Option<String>> {
    with_vault(&state, |v| v.db.resolve_target(&target))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .manage(terminal::TermState::default())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            refresh,
            read_note,
            write_note,
            create_note,
            create_folder,
            rename_folder,
            rename_note,
            trash_note,
            trash_folder,
            rename_file,
            duplicate_note,
            abs_path,
            reveal_in_explorer,
            open_external,
            open_note_window,
            search_notes,
            backlinks,
            resolve_link,
            related_notes,
            unlinked_mentions,
            ask_vault,
            get_llm_settings,
            set_llm_pref,
            git_sync,
            agent_chat,
            agent_transform,
            note_history,
            history_get,
            term_open,
            term_write,
            term_resize,
            term_kill,
            janitor_run,
            janitor_latest,
            janitor_apply,
            janitor_dismiss,
            graph_data,
            list_canvases,
            save_asset,
            import_asset,
            read_asset
        ])
        .setup(|app| {
            spawn_nightly_janitor(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("lỗi khởi động tauri");
}
