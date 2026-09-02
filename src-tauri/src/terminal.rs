//! Terminal panel: PTY thật (ConPTY trên Windows) chạy shell trong vault,
//! stream output về WebView qua event `term-output`, nhận phím gõ qua `term_write`.

use anyhow::Context;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct TermSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TermState {
    sessions: Mutex<HashMap<u32, TermSession>>,
}

#[derive(Clone, Serialize)]
struct TermOutput {
    id: u32,
    /// Base64 của bytes thô — giữ nguyên UTF-8 multibyte bị cắt giữa chunk cho xterm tự ráp.
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: u32,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Mở PTY chạy shell (PowerShell trên Windows) trong `cwd`; `run_claude` thì gõ sẵn
/// lệnh `claude` để vào thẳng phiên agent — thoát claude vẫn còn shell để dùng tiếp.
pub fn open(
    app: AppHandle,
    state: &TermState,
    cwd: Option<std::path::PathBuf>,
    cols: u16,
    rows: u16,
    run_claude: bool,
    mcp_config: Option<std::path::PathBuf>,
) -> anyhow::Result<u32> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;

    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()))
    };
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // ConPTY buffer input nên gõ sớm trước khi shell sẵn sàng vẫn được nhận.
    if run_claude {
        // `--mcp-config` cắm MCP server của vault vào phiên claude này (không cần đăng ký tay).
        let line = match &mcp_config {
            Some(p) => format!("claude --mcp-config \"{}\"\r", p.to_string_lossy()),
            None => "claude\r".to_string(),
        };
        let _ = writer.write_all(line.as_bytes());
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        use base64::Engine;
        let mut child = child;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("term-output", TermOutput { id, data });
                }
            }
        }
        let _ = child.wait();
        let _ = app2.emit("term-exit", TermExit { id });
    });

    state
        .sessions
        .lock()
        .map_err(|_| anyhow::anyhow!("term state poisoned"))?
        .insert(id, TermSession { writer, master: pair.master, killer });
    Ok(id)
}

pub fn write(state: &TermState, id: u32, data: &str) -> anyhow::Result<()> {
    let mut g = state.sessions.lock().map_err(|_| anyhow::anyhow!("term state poisoned"))?;
    let s = g.get_mut(&id).context("terminal đã đóng")?;
    s.writer.write_all(data.as_bytes())?;
    s.writer.flush()?;
    Ok(())
}

pub fn resize(state: &TermState, id: u32, cols: u16, rows: u16) -> anyhow::Result<()> {
    let g = state.sessions.lock().map_err(|_| anyhow::anyhow!("term state poisoned"))?;
    let s = g.get(&id).context("terminal đã đóng")?;
    s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
    Ok(())
}

pub fn kill(state: &TermState, id: u32) {
    if let Ok(mut g) = state.sessions.lock() {
        if let Some(mut s) = g.remove(&id) {
            let _ = s.killer.kill();
        }
    }
}
