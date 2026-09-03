#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `second-brain --mcp --vault <path> [--read-only]`: chạy MCP server trên stdio thay
    // cho GUI. Chính file .exe của app là server nên đăng ký với Claude Code / Codex
    // không cần cài thêm binary `brain`. Subsystem "windows" vẫn đọc/ghi được stdio
    // khi được process cha spawn với pipe.
    if let Some(opts) = second_brain_lib::mcp_setup::parse_cli(std::env::args().skip(1)) {
        if let Err(e) = mcp::serve_stdio(&opts.vault, opts.options) {
            eprintln!("[second-brain mcp] lỗi: {e}");
            std::process::exit(1);
        }
        return;
    }
    // Chế độ phụ: hook của Claude Code gọi `second-brain.exe --hook-sink <file>` để
    // nối JSON stdin vào file log — không khởi động Tauri, không mở cửa sổ.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--hook-sink" {
        second_brain_lib::hook_sink(&args[2]);
        return;
    }
    second_brain_lib::run()
}
