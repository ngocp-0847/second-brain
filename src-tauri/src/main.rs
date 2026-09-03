#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chế độ phụ: hook của Claude Code gọi `second-brain.exe --hook-sink <file>` để
    // nối JSON stdin vào file log — không khởi động Tauri, không mở cửa sổ.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--hook-sink" {
        second_brain_lib::hook_sink(&args[2]);
        return;
    }
    second_brain_lib::run()
}
