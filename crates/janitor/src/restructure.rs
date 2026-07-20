//! Janitor tầng 2: semantic restructure (DESIGN/ARCHITECTURE.md §8.2).
//!
//! - Phát hiện note "đặt sai chỗ": similarity với centroid folder khác cao hơn
//!   hẳn folder hiện tại (embeddings từ sqlite-vec).
//! - LLM (qua agent CLI) thẩm định danh sách ứng viên → đề xuất move,
//!   **luôn ở mức propose** — user duyệt từng move trong report.
//! - Sinh MOC `_index.md` cho folder lớn; phần user viết tay phía trên marker
//!   được giữ nguyên khi ghi đè.
//!
//! Guardrails: tối đa MAX_MOVES move/lần; chỉ move vào folder có sẵn;
//! độ sâu ≤ 4; note sửa <24h được miễn trừ; move dùng `rename_note`
//! nên mọi wikilink tự cập nhật (không thể tạo thêm broken link).

use crate::{Apply, Finding};
use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;
use vault_core::Vault;

const MAX_MOVES: usize = 20;
const MAX_CANDIDATES: usize = 15;
const SIM_MARGIN: f32 = 0.03;
const MIN_FOLDER_NOTES: usize = 3;
const MAX_DEPTH: usize = 4;
const MOC_MIN_NOTES: usize = 5;
const MAX_MOC_PER_RUN: usize = 3;
pub const MOC_MARKER: &str = "<!-- brain:begin-generated -->";

fn folder_of(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

struct Candidate {
    path: String,
    title: String,
    cur_folder: String,
    best_folder: String,
    gain: f32,
}

/// Tìm note lệch chỗ bằng centroid folder. Thuần số học, không LLM.
fn misplaced_candidates(vault: &Vault, sem: &semantic::SemanticIndex, now: i64) -> Result<Vec<Candidate>> {
    let vectors = sem.note_vectors()?;
    if vectors.is_empty() {
        return Ok(Vec::new());
    }
    // note_id → (path, title, mtime)
    let meta: HashMap<i64, (String, String, i64)> = {
        let mut stmt = vault.db.conn.prepare("SELECT id, path, title, mtime FROM note")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().collect()
    };

    // Gom tổng vector theo folder (giữ sum + count để leave-one-out).
    let mut sums: HashMap<String, (Vec<f32>, usize)> = HashMap::new();
    for (id, v) in &vectors {
        if let Some((path, _, _)) = meta.get(id) {
            let e = sums.entry(folder_of(path)).or_insert_with(|| (vec![0f32; v.len()], 0));
            for (a, x) in e.0.iter_mut().zip(v) {
                *a += x;
            }
            e.1 += 1;
        }
    }
    let eligible: HashMap<&String, &(Vec<f32>, usize)> =
        sums.iter().filter(|(_, (_, n))| *n >= MIN_FOLDER_NOTES).collect();
    if eligible.len() < 2 {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for (id, v) in &vectors {
        let Some((path, title, mtime)) = meta.get(id) else { continue };
        if now - mtime < 24 * 3600 || path.ends_with("_index.md") {
            continue; // mới sửa / file MOC → không đụng
        }
        let cur = folder_of(path);
        // Leave-one-out: centroid folder hiện tại KHÔNG tính chính note này,
        // nếu không note lạc loài tự kéo centroid về phía mình.
        let own_sim = eligible
            .get(&cur)
            .map(|(sum, n)| {
                let m = (*n - 1).max(1) as f32;
                let loo: Vec<f32> = sum.iter().zip(v).map(|(s, x)| (s - x) / m).collect();
                cosine(v, &loo)
            })
            .unwrap_or(0.0);
        let mut best: Option<(&String, f32)> = None;
        for (f, (sum, n)) in &eligible {
            if **f == cur {
                continue;
            }
            let c: Vec<f32> = sum.iter().map(|s| s / *n as f32).collect();
            let s = cosine(v, &c);
            if best.map(|(_, bs)| s > bs).unwrap_or(true) {
                best = Some((f, s));
            }
        }
        if let Some((bf, bs)) = best {
            if bs - own_sim > SIM_MARGIN {
                out.push(Candidate {
                    path: path.clone(),
                    title: title.clone(),
                    cur_folder: cur,
                    best_folder: (*bf).clone(),
                    gain: bs - own_sim,
                });
            }
        }
    }
    out.sort_by(|a, b| b.gain.total_cmp(&a.gain));
    out.truncate(MAX_CANDIDATES);
    Ok(out)
}

#[derive(Deserialize)]
struct MoveSpec {
    from: String,
    to: String,
    #[serde(default)]
    reason: String,
}

/// Trích mảng JSON đầu tiên trong output LLM (chịu được ```json fence, lời dẫn).
fn extract_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    (end > start).then(|| &s[start..=end])
}

/// Đề xuất move qua LLM. Trả về findings mức propose.
pub(crate) fn propose_moves(
    vault: &Vault,
    sem: &semantic::SemanticIndex,
    provider: qa::Provider,
    now: i64,
) -> Result<Vec<Finding>> {
    let candidates = misplaced_candidates(vault, sem, now)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Cây folder (kèm số note) cho LLM có bối cảnh.
    let mut folder_counts: HashMap<String, usize> = HashMap::new();
    for (p, _) in vault.db.note_list()? {
        *folder_counts.entry(folder_of(&p)).or_default() += 1;
    }
    let mut tree: Vec<String> = folder_counts
        .iter()
        .map(|(f, n)| format!("- {} ({n} notes)", if f.is_empty() { "(gốc)" } else { f }))
        .collect();
    tree.sort();

    let mut cand_lines = String::new();
    for c in &candidates {
        cand_lines.push_str(&format!(
            "- path: {} | title: \"{}\" | đang ở: {} | gần với: {} (chênh {:.2})\n",
            c.path,
            c.title,
            if c.cur_folder.is_empty() { "(gốc)" } else { &c.cur_folder },
            c.best_folder,
            c.gain
        ));
    }

    let prompt = format!(
        "Bạn giúp tái cấu trúc một vault ghi chú Markdown. Dưới đây là cây folder hiện tại \
         và các note mà phân tích embedding cho thấy có thể đang đặt sai folder.\n\n\
         CÂY FOLDER:\n{}\n\nNOTE NGHI ĐẶT SAI CHỖ:\n{}\n\
         Chọn những move THẬT SỰ hợp lý về mặt chủ đề (bỏ qua nếu không chắc). Quy tắc:\n\
         - `to` phải là một folder CÓ SẴN trong cây trên (không tạo folder mới).\n\
         - Tối đa {MAX_MOVES} move.\n\
         Trả về DUY NHẤT một mảng JSON, không giải thích ngoài JSON:\n\
         [{{\"from\": \"đường/dẫn/note.md\", \"to\": \"folder/đích\", \"reason\": \"lý do ngắn\"}}]\n\
         Nếu không move nào hợp lý, trả về [].",
        tree.join("\n"),
        cand_lines
    );

    let out = qa::generate(provider, &prompt)?;
    let json = extract_json_array(&out).unwrap_or("[]");
    let moves: Vec<MoveSpec> = serde_json::from_str(json).unwrap_or_default();

    let valid_paths: std::collections::HashSet<String> =
        vault.db.note_list()?.into_iter().map(|(p, _)| p).collect();
    let mut findings = Vec::new();
    for m in moves.into_iter().take(MAX_MOVES) {
        let to_folder = m.to.trim_matches('/').to_string();
        // Guardrails: nguồn tồn tại, đích là folder có sẵn, độ sâu hợp lệ, không move tại chỗ.
        if !valid_paths.contains(&m.from)
            || !folder_counts.contains_key(&to_folder)
            || to_folder.split('/').count() > MAX_DEPTH
            || folder_of(&m.from) == to_folder
        {
            continue;
        }
        let file = m.from.rsplit('/').next().unwrap_or(&m.from);
        let to_path = if to_folder.is_empty() { file.to_string() } else { format!("{to_folder}/{file}") };
        findings.push(Finding {
            rule: "restructure",
            severity: "propose",
            description: format!(
                "Di chuyển {} → {} ({})",
                m.from,
                to_path,
                if m.reason.is_empty() { "chủ đề gần hơn" } else { &m.reason }
            ),
            payload: Apply::MoveNote { from: m.from, to: to_path },
        });
    }
    Ok(findings)
}

/// Sinh/cập nhật MOC cho các folder lớn. Trả về findings mức propose.
pub(crate) fn propose_mocs(vault: &Vault, provider: qa::Provider, now: i64) -> Result<Vec<Finding>> {
    let notes = vault.db.note_list()?;
    let mut by_folder: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (p, t) in &notes {
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
    fn json_extraction_survives_fences() {
        let s = "Đây là kết quả:\n```json\n[{\"from\":\"a.md\",\"to\":\"b\"}]\n```";
        let j = extract_json_array(s).unwrap();
        let v: Vec<MoveSpec> = serde_json::from_str(j).unwrap();
        assert_eq!(v[0].from, "a.md");
        assert_eq!(extract_json_array("không có json"), None);
    }

    #[test]
    fn cosine_basics() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }
}
