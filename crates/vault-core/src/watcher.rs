//! Theo dõi vault và re-index khi file đổi. Re-index tăng dần rất rẻ
//! (so mtime/size rồi hash) nên mỗi đợt event chỉ gọi `Vault::index`.

use anyhow::Result;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use crate::vault::Vault;

/// Chạy vòng lặp watch cho tới khi kênh sự kiện đóng. Gọi `on_indexed` sau mỗi lần re-index.
pub fn watch(vault: &mut Vault, mut on_indexed: impl FnMut(&crate::vault::IndexStats)) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(300), tx)?;
    debouncer
        .watcher()
        .watch(&vault.root, RecursiveMode::Recursive)?;

    for events in rx {
        let Ok(events) = events else { continue };
        // Bỏ qua event chỉ chạm vào .brain (do chính ta ghi cache).
        let relevant = events.iter().any(|e| !under_brain(&e.path, &vault.root));
        if !relevant {
            continue;
        }
        let stats = vault.index()?;
        if stats.updated > 0 || stats.removed > 0 {
            on_indexed(&stats);
        }
    }
    Ok(())
}

fn under_brain(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .map(|r| r.components().next().is_some_and(|c| c.as_os_str() == ".brain"))
        .unwrap_or(false)
}
