//! Sync GitHub một chạm: add → commit → push bằng git CLI trong vault.

use anyhow::{bail, Context, Result};
use std::process::Command;

/// Chạy git trong `root`, trả (thành công?, stdout+stderr).
fn git(root: &std::path::Path, args: &[&str]) -> Result<(bool, String)> {
    let mut c = Command::new("git");
    c.current_dir(root).args(args);
    crate::hide_console(&mut c);
    let out = c.output().context("không chạy được git — đã cài git chưa?")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((out.status.success(), text))
}

pub fn sync(root: &std::path::Path) -> Result<String> {
    let (ok, _) = git(root, &["rev-parse", "--is-inside-work-tree"])?;
    if !ok {
        bail!("vault chưa phải git repo — mở terminal chạy `git init` và `git remote add origin <url>` trước");
    }
    git(root, &["add", "-A"])?;
    let (_, status) = git(root, &["status", "--porcelain"])?;
    let n_changes = status.lines().filter(|l| !l.trim().is_empty()).count();
    if n_changes > 0 {
        let (ok, out) = git(root, &["commit", "-m", &format!("vault sync ({n_changes} file)")])?;
        if !ok {
            bail!("git commit lỗi: {}", out.trim().chars().take(300).collect::<String>());
        }
    }
    let (ok, out) = git(root, &["push"])?;
    if !ok {
        // Nhánh mới chưa có upstream → thử push -u origin HEAD một lần.
        if out.contains("--set-upstream") || out.contains("no upstream") {
            let (ok2, out2) = git(root, &["push", "-u", "origin", "HEAD"])?;
            if !ok2 {
                bail!("git push lỗi: {}", out2.trim().chars().take(300).collect::<String>());
            }
        } else {
            bail!("git push lỗi: {}", out.trim().chars().take(300).collect::<String>());
        }
    }
    Ok(if n_changes > 0 {
        format!("Đã commit {n_changes} thay đổi và push lên GitHub ✓")
    } else {
        "Không có thay đổi mới — remote đã cập nhật ✓".into()
    })
}
