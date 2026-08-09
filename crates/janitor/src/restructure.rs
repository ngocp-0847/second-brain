//! Janitor tầng 2 (DESIGN/ARCHITECTURE.md §8.2): sinh MOC `_index.md` cho
//! folder lớn bằng LLM (qua agent CLI).
//!
//! Luôn ở mức propose — user duyệt trong report. Phần user viết tay phía trên
//! marker được giữ nguyên khi ghi đè.

use crate::{Apply, Finding};
use anyhow::Result;
use std::collections::HashMap;
use vault_core::Vault;

const MOC_MIN_NOTES: usize = 5;
const MAX_MOC_PER_RUN: usize = 3;
pub const MOC_MARKER: &str = "<!-- brain:begin-generated -->";

fn folder_of(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

/// Sinh/cập nhật MOC cho các folder lớn. Trả về findings mức propose.
pub(crate) fn propose_mocs(vault: &Vault, provider: qa::Provider, now: i64) -> Result<Vec<Finding>> {
    let notes = vault.db.note_list()?;
    let mut by_folder: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (p, t, _) in &notes {
        if p.ends_with("_index.md") {
            continue;
        }
        by_folder.entry(folder_of(p)).or_default().push((p.clone(), t.clone()));
    }

    let mut findings = Vec::new();
    for (folder, items) in by_folder {
        if findings.len() >= MAX_MOC_PER_RUN || folder.is_empty() || items.len() < MOC_MIN_NOTES {
            continue;
        }
        let moc_rel = format!("{folder}/_index.md");
        // MOC còn tươi (<7 ngày) thì thôi.
        if let Ok(abs) = vault.abs_path(&moc_rel) {
            if let Ok(meta) = std::fs::metadata(&abs) {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                if now - mtime < 7 * 24 * 3600 {
                    continue;
                }
            }
        }

        let list = items
            .iter()
            .map(|(p, t)| format!("- [[{}]] — title: {t}", p.trim_end_matches(".md")))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "Viết nội dung Map of Content (MOC) cho folder \"{folder}\" của một vault Markdown.\n\
             Các note trong folder:\n{list}\n\
             Yêu cầu: mở đầu 1 câu mô tả folder; nhóm các note theo chủ đề con với heading `##`; \
             mỗi note một dòng dạng `- [[wikilink]] — mô tả 1 câu` (giữ nguyên wikilink như đã cho). \
             Chỉ trả về markdown, không lời dẫn."
        );
        let Ok(body) = qa::generate(provider, &prompt) else { continue };
        let content = format!(
            "---\ngenerated: true\n---\n{MOC_MARKER}\n# {folder} — MOC\n\n{}\n",
            body.trim()
        );
        findings.push(Finding {
            rule: "moc",
            severity: "propose",
            description: format!("Sinh/cập nhật MOC {moc_rel} ({} notes)", items.len()),
            payload: Apply::WriteMoc { path: moc_rel, content },
        });
    }
    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_of_basics() {
        assert_eq!(folder_of("a/b/c.md"), "a/b");
        assert_eq!(folder_of("c.md"), "");
    }
}
