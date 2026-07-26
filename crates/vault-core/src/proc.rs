//! Tiện ích spawn process con cho app GUI.
//!
//! App Tauri không có console: mỗi `Command` chạy CLI (git, claude, codex) sẽ tự
//! mở một cửa sổ console nháy lên rồi tắt — rất rối mắt. `hide_console` phải được
//! gọi cho MỌI `Command` trong workspace, kể cả các lệnh chạy nhanh như `--version`.

use std::process::Command;

/// Chạy process con không kèm cửa sổ console (Windows). No-op trên OS khác.
#[cfg(windows)]
pub fn hide_console(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_c: &mut Command) {}

/// `Command::new` đã ẩn console — dùng thay cho `Command::new` ở mọi nơi.
pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    hide_console(&mut c);
    c
}
