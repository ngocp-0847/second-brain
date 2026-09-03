//! Phân phối vault dưới dạng **plugin** cho agent CLI ngoài.
//!
//! Khác với [`crate::mcp_setup`] (chỉ đăng ký MCP server), module này dựng một
//! *marketplace local* chứa plugin `second-brain` gồm skill + khai báo MCP, rồi nhờ chính
//! CLI cài nó vào hệ thống. Nhờ vậy Claude Code / Codex nhận được cả **cách dùng** vault
//! (skill) lẫn **công cụ** (MCP tool), thay vì chỉ có tool trần.
//!
//! Template plugin nằm trong `plugin/` của repo và được bundle theo app. Vì `mcp.json` phải
//! trỏ tới đúng .exe và đúng vault đang mở — hai giá trị chỉ biết lúc chạy — nên khi cài,
//! template được *materialize* sang thư mục dữ liệu app rồi mới đăng ký.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};

pub const PLUGIN: &str = "second-brain";
pub const MARKETPLACE: &str = "second-brain-app";

/// Định danh plugin dùng cho mọi lệnh của cả hai CLI.
fn plugin_id() -> String {
    format!("{PLUGIN}@{MARKETPLACE}")
}

#[derive(Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
pub struct PluginInfo {
    /// Marketplace đã materialize (thư mục được đăng ký với CLI).
    pub dir: String,
    pub vault: String,
    pub id: String,
    pub skills: Vec<SkillInfo>,
    /// Đã cài chưa. None = CLI không có trên PATH.
    pub claude_installed: Option<bool>,
    pub codex_installed: Option<bool>,
    /// Lệnh cài tay, hiện trong Settings để copy.
    pub claude_cmds: Vec<String>,
    pub codex_cmds: Vec<String>,
}

/// Thư mục template trong bundle. Khi chạy `cargo tauri dev` thì resource dir chưa có gì,
/// nên fallback về `plugin/` trong repo.
fn template_dir(app: &AppHandle) -> Result<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("plugin");
        if p.join(".claude-plugin/marketplace.json").is_file() {
            return Ok(p);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin");
    if dev.join(".claude-plugin/marketplace.json").is_file() {
        return Ok(dev);
    }
    bail!("không tìm thấy template plugin (bundle thiếu `plugin/`)")
}

/// Nơi đặt marketplace đã materialize — ngoài vault, để không lẫn vào ghi chú của người dùng.
fn install_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .context("không lấy được thư mục dữ liệu app")?
        .join("agent-plugin"))
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &dst)?;
        } else {
            std::fs::copy(entry.path(), &dst)?;
        }
    }
    Ok(())
}

/// Chép template ra thư mục dữ liệu app và sinh `mcp.json` trỏ tới exe + vault hiện tại.
/// Chạy lại mỗi lần cài vì exe có thể đổi chỗ sau khi cập nhật app, và vault thì đổi thường xuyên.
pub fn materialize(app: &AppHandle, root: &Path) -> Result<PathBuf> {
    let src = template_dir(app)?;
    let dst = install_dir(app)?;
    // Xoá bản cũ để skill bị gỡ khỏi template không còn sót lại.
    if dst.exists() {
        std::fs::remove_dir_all(&dst).context("không xoá được bản plugin cũ")?;
    }
    copy_tree(&src, &dst)?;

    let (exe, args) = crate::mcp_setup::server_command(root)?;
    let cfg = serde_json::json!({
        "mcpServers": {
            crate::mcp_setup::SERVER_NAME: { "type": "stdio", "command": exe, "args": args }
        }
    });
    std::fs::write(
        dst.join("plugins").join(PLUGIN).join("mcp.json"),
        serde_json::to_string_pretty(&cfg)?,
    )
    .context("không ghi được mcp.json của plugin")?;
    Ok(dst)
}

/// Skill có trong template — đọc `name`/`description` từ frontmatter của từng SKILL.md.
fn skills(app: &AppHandle) -> Vec<SkillInfo> {
    let Ok(dir) = template_dir(app) else { return Vec::new() };
    let skills_dir = dir.join("plugins").join(PLUGIN).join("skills");
    let Ok(entries) = std::fs::read_dir(&skills_dir) else { return Vec::new() };
    let mut out: Vec<SkillInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
            Some(SkillInfo { description: front_matter_description(&text), name })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `description:` trong frontmatter YAML. Câu đầu là đủ để hiện trong Settings.
fn front_matter_description(text: &str) -> String {
    let Some(body) = text.strip_prefix("---") else { return String::new() };
    let Some(end) = body.find("\n---") else { return String::new() };
    let desc = body[..end]
        .lines()
        .skip_while(|l| !l.starts_with("description:"))
        .map(|l| l.trim_start_matches("description:").trim())
        .next()
        .unwrap_or_default()
        .trim_matches(['"', '\''].as_slice());
    match desc.split_once(". ") {
        Some((first, _)) => format!("{first}."),
        None => desc.to_string(),
    }
}

fn provider(cli: &str) -> Result<qa::Provider> {
    match cli {
        "claude" => Ok(qa::Provider::ClaudeCli),
        "codex" => Ok(qa::Provider::CodexCli),
        _ => bail!("CLI không hỗ trợ: {cli}"),
    }
}

/// Plugin đã cài chưa. None = CLI không chạy được.
///
/// `claude plugin list` chỉ in plugin đã cài, còn `codex plugin list` in cả plugin mới chỉ
/// *có sẵn* trong marketplace — nên với codex phải soi thêm cột STATUS.
fn installed(cli: &str) -> Option<bool> {
    if !qa::provider_available(provider(cli).ok()?) {
        return None;
    }
    let out = crate::agent::shell_command(cli, &["plugin", "list"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let id = plugin_id();
    Some(
        text.lines()
            .filter(|l| l.contains(&id))
            .any(|l| cli != "codex" || l.contains("installed")),
    )
}

pub fn info(app: &AppHandle, root: &Path) -> Result<PluginInfo> {
    let dir = install_dir(app)?.to_string_lossy().into_owned();
    let id = plugin_id();
    Ok(PluginInfo {
        claude_cmds: vec![
            format!("claude plugin marketplace add \"{dir}\""),
            format!("claude plugin install {id} --scope user -y"),
        ],
        codex_cmds: vec![
            format!("codex plugin marketplace add \"{dir}\""),
            format!("codex plugin add {id}"),
        ],
        skills: skills(app),
        claude_installed: installed("claude"),
        codex_installed: installed("codex"),
        vault: root.to_string_lossy().into_owned(),
        dir,
        id,
    })
}

/// Materialize rồi nhờ CLI cài. Trả output gộp để hiện cho người dùng.
pub fn install(cli: &str, app: &AppHandle, root: &Path) -> Result<String> {
    check_cli(cli)?;
    let dir = materialize(app, root)?;
    let dir = dir.to_string_lossy().into_owned();
    let id = plugin_id();

    // Marketplace đã đăng ký từ lần trước → `add` báo trùng; bỏ qua lỗi đó rồi refresh,
    // vì cái ta cần là CLI đọc lại đúng thư mục vừa materialize.
    if run(cli, &["plugin", "marketplace", "add", &dir]).is_err() {
        let refresh: Vec<&str> = match cli {
            "claude" => vec!["plugin", "marketplace", "update", MARKETPLACE],
            _ => vec!["plugin", "marketplace", "upgrade"],
        };
        let _ = run(cli, &refresh);
    }
    // Cả hai CLI đều COPY plugin vào cache riêng lúc cài. Mở vault khác thì `mcp.json` đổi
    // nhưng cache vẫn trỏ vault cũ — nên luôn gỡ bản cũ để lần cài này chép lại từ đầu.
    if installed(cli) == Some(true) {
        let _ = uninstall_plugin(cli);
    }
    let args: Vec<&str> = match cli {
        "claude" => vec!["plugin", "install", &id, "--scope", "user", "-y"],
        _ => vec!["plugin", "add", &id],
    };
    let log = run(cli, &args)?;

    if installed(cli) != Some(true) {
        bail!("cài xong nhưng `{cli} plugin list` không thấy {id}:\n{log}");
    }
    Ok(log)
}

pub fn uninstall(cli: &str) -> Result<String> {
    check_cli(cli)?;
    let log = uninstall_plugin(cli)?;
    // Marketplace không còn plugin nào thì gỡ luôn cho sạch; lỗi ở đây không đáng để fail.
    let _ = run(cli, &["plugin", "marketplace", "remove", MARKETPLACE]);
    Ok(log)
}

/// Gỡ riêng plugin, giữ marketplace — dùng khi cài lại để làm mới cache.
fn uninstall_plugin(cli: &str) -> Result<String> {
    let id = plugin_id();
    let args: Vec<&str> = match cli {
        "claude" => vec!["plugin", "uninstall", &id, "--scope", "user"],
        _ => vec!["plugin", "remove", &id],
    };
    run(cli, &args)
}

fn check_cli(cli: &str) -> Result<()> {
    if !qa::provider_available(provider(cli)?) {
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
    use super::front_matter_description;

    #[test]
    fn reads_first_sentence_of_description() {
        let md = "---\nname: x\ndescription: Làm việc A. Dùng khi B.\n---\n\n# x\n";
        assert_eq!(front_matter_description(md), "Làm việc A.");
    }

    #[test]
    fn tolerates_quotes_and_missing_frontmatter() {
        let md = "---\nname: x\ndescription: \"Chỉ một câu\"\n---\n";
        assert_eq!(front_matter_description(md), "Chỉ một câu");
        assert_eq!(front_matter_description("# không có frontmatter"), "");
    }
}
