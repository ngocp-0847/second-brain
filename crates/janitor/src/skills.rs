//! Skill: luật thường trực do người dùng viết bằng tiếng Việt, agent chạy lại
//! mỗi nhịp heartbeat.
//!
//! > "Các file tôi note kiểu về spec thì đưa vào folder daily"
//!
//! Mỗi skill là MỘT FILE trong `.brain/skills/<id>.md` — sửa được bằng UI, bằng
//! tay, và nằm trong git snapshot của janitor. Không nhét vào SQLite: luật là
//! thứ người dùng phải đọc lại và sửa được, không phải dữ liệu máy.
//!
//! Kết quả mỗi lần chạy KHÔNG tự áp dụng: nó đi vào đúng đường proposal của
//! janitor (snapshot → report → user duyệt), trừ khi skill được bật `auto`.

use crate::{Apply, Finding};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use vault_core::Vault;

/// Mỗi lần chạy chỉ soi số note vừa đổi này — vault bị đụng hàng loạt (git pull,
/// sync) thì cũng không nhồi cả nghìn note vào một prompt.
const MAX_CANDIDATES: usize = 30;
/// Số ký tự đầu mỗi note gửi cho LLM — đủ để biết note nói về cái gì.
const PREVIEW_CHARS: usize = 400;
/// Trần action mỗi lần chạy, kể cả khi LLM hào hứng quá.
const MAX_ACTIONS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    /// Tên file (không đuôi) — id ổn định kể cả khi đổi tên hiển thị.
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// `propose` (mặc định, chờ duyệt) hoặc `auto` (làm luôn, có snapshot).
    pub autonomy: String,
    pub created: i64,
    /// Lần heartbeat gần nhất đã soi tới đâu (epoch giây).
    pub last_run: i64,
    /// Nguyên văn câu luật người dùng viết.
    pub rule: String,
}

impl Skill {
    pub fn is_auto(&self) -> bool {
        self.autonomy == "auto"
    }
}

fn skills_dir(root: &Path) -> PathBuf {
    root.join(".brain").join("skills")
}

/// Tên hiển thị → tên file an toàn, không dấu tiếng Việt để khỏi lệ thuộc
/// encoding của từng máy.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.trim().to_lowercase().chars() {
        let c = deaccent(c);
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let s = out.trim_matches('-').chars().take(48).collect::<String>();
    if s.is_empty() {
        "rule".into()
    } else {
        s
    }
}

fn deaccent(c: char) -> char {
    const TABLE: [(&str, char); 12] = [
        ("àáảãạăằắẳẵặâầấẩẫậ", 'a'),
        ("èéẻẽẹêềếểễệ", 'e'),
        ("ìíỉĩị", 'i'),
        ("òóỏõọôồốổỗộơờớởỡợ", 'o'),
        ("ùúủũụưừứửữự", 'u'),
        ("ỳýỷỹỵ", 'y'),
        ("đ", 'd'),
        ("ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬ", 'a'),
        ("ÈÉẺẼẸÊỀẾỂỄỆ", 'e'),
        ("ÌÍỈĨỊ", 'i'),
        ("ÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢ", 'o'),
        ("ÙÚỦŨỤƯỪỨỬỮỰ", 'u'),
    ];
    for (set, base) in TABLE {
        if set.contains(c) {
            return base;
        }
    }
    c
}

fn parse_skill(id: &str, text: &str) -> Skill {
    let mut name = id.to_string();
    let mut enabled = true;
    let mut autonomy = "propose".to_string();
    let mut created = 0;
    let mut last_run = 0;
    let body = match text.strip_prefix("---") {
        Some(rest) => match rest.split_once("\n---") {
            Some((fm, body)) => {
                for line in fm.lines() {
                    let Some((k, v)) = line.split_once(':') else { continue };
                    let v = v.trim();
                    match k.trim() {
                        "name" => name = v.trim_matches('"').to_string(),
                        "enabled" => enabled = v != "false",
                        "autonomy" => autonomy = v.to_string(),
                        "created" => created = v.parse().unwrap_or(0),
                        "last_run" => last_run = v.parse().unwrap_or(0),
                        _ => {}
                    }
                }
                body.trim_start_matches('-')
            }
            None => text,
        },
        None => text,
    };
    Skill { id: id.into(), name, enabled, autonomy, created, last_run, rule: body.trim().to_string() }
}

fn render_skill(s: &Skill) -> String {
    format!(
        "---\nname: {}\nenabled: {}\nautonomy: {}\ncreated: {}\nlast_run: {}\n---\n{}\n",
        s.name, s.enabled, s.autonomy, s.created, s.last_run, s.rule.trim()
    )
}

pub fn list(root: &Path) -> Result<Vec<Skill>> {
    let dir = skills_dir(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        out.push(parse_skill(id, &text));
    }
    out.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub fn get(root: &Path, id: &str) -> Result<Option<Skill>> {
    Ok(list(root)?.into_iter().find(|s| s.id == id))
}

/// Tạo mới (id rỗng) hoặc ghi đè một skill. Trả về bản đã lưu (có id thật).
pub fn save(root: &Path, mut skill: Skill, now: i64) -> Result<Skill> {
    let dir = skills_dir(root);
    std::fs::create_dir_all(&dir)?;
    if skill.rule.trim().is_empty() {
        anyhow::bail!("luật rỗng");
    }
    if skill.name.trim().is_empty() {
        // Chưa đặt tên thì lấy câu luật làm tên, cắt ngắn cho vừa danh sách.
        let short: String = skill.rule.chars().take(48).collect();
        skill.name = short.trim().to_string();
    }
    if skill.id.trim().is_empty() {
        let base = slugify(&skill.name);
        let mut id = base.clone();
        let mut i = 2;
        while dir.join(format!("{id}.md")).exists() {
            id = format!("{base}-{i}");
            i += 1;
        }
        skill.id = id;
        skill.created = now;
    }
    if skill.autonomy != "auto" {
        skill.autonomy = "propose".into();
    }
    std::fs::write(dir.join(format!("{}.md", skill.id)), render_skill(&skill))
        .with_context(|| format!("ghi skill {}", skill.id))?;
    Ok(skill)
}

pub fn delete(root: &Path, id: &str) -> Result<()> {
    let p = skills_dir(root).join(format!("{id}.md"));
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

/// Đánh dấu đã chạy tới mốc `now` cho mọi skill đang bật.
pub fn mark_run(root: &Path, now: i64) -> Result<()> {
    for mut s in list(root)?.into_iter().filter(|s| s.enabled) {
        s.last_run = now;
        save(root, s, now)?;
    }
    Ok(())
}

/// Mốc thời gian cần soi từ đó: skill nào "lạc hậu" nhất quyết định.
/// Skill vừa tạo (`last_run` = 0) thì chỉ soi 7 ngày gần đây, không lôi cả vault.
pub fn scan_since(skills: &[Skill], now: i64) -> i64 {
    skills
        .iter()
        .filter(|s| s.enabled)
        .map(|s| if s.last_run == 0 { now - 7 * 24 * 3600 } else { s.last_run })
        .min()
        .unwrap_or(now)
}

/// Có skill nào đang bật mà quá `every` giây chưa chạy không.
pub fn due(root: &Path, now: i64, every: i64) -> bool {
    list(root)
        .map(|ss| ss.iter().any(|s| s.enabled && now - s.last_run >= every))
        .unwrap_or(false)
}

// ---------- một nhịp chạy ----------

#[derive(Debug, Deserialize)]
struct PlanItem {
    path: String,
    action: String,
    #[serde(default)]
    to: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    rule: String,
    #[serde(default)]
    reason: String,
}

/// Cắt lấy mảng JSON trong câu trả lời của LLM (nó hay bọc ```json hoặc kèm lời dẫn).
fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start).then(|| &text[start..=end])
}

fn sanitize_dir(raw: &str) -> Option<String> {
    let d = raw.trim().trim_matches('/').replace('\\', "/");
    if d.is_empty() || d.split('/').any(|seg| seg == ".." || seg == "." || seg.is_empty()) {
        return None;
    }
    // Không cho agent lôi note vào vùng nội bộ.
    let lower = d.to_lowercase();
    if lower.starts_with(".brain") || lower.starts_with(".obsidian") || lower.starts_with(".git") {
        return None;
    }
    Some(d)
}

fn sanitize_tag(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('#').trim();
    if t.is_empty() || t.contains(char::is_whitespace) {
        return None;
    }
    Some(t.to_string())
}

fn dir_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some((d, _)) => d,
        None => "",
    }
}

fn build_prompt(skills: &[Skill], folders: &[String], candidates: &[(String, String, String)]) -> String {
    let rules = skills
        .iter()
        .map(|s| format!("- [{}] {}", s.name, s.rule))
        .collect::<Vec<_>>()
        .join("\n");
    let folder_list =
        if folders.is_empty() { "(vault chưa có thư mục con)".to_string() } else { folders.join(", ") };
    let notes = candidates
        .iter()
        .map(|(path, title, preview)| format!("### {path}\ntitle: {title}\n{preview}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "Bạn là trợ lý sắp xếp một vault ghi chú Markdown. Người dùng đã đặt các luật sau:\n\
         {rules}\n\n\
         Thư mục hiện có trong vault: {folder_list}\n\n\
         Dưới đây là các note vừa thay đổi. Với MỖI note, quyết định xem có luật nào áp \
         dụng được không.\n\n{notes}\n\n\
         Trả về DUY NHẤT một mảng JSON, không lời dẫn, không markdown. Mỗi phần tử:\n\
         {{\"path\": \"<path y hệt ở trên>\", \"action\": \"move\"|\"tag\", \
         \"to\": \"<thư mục đích, chỉ cho action move>\", \"tag\": \"<tag, chỉ cho action tag>\", \
         \"rule\": \"<tên luật đã áp dụng>\", \"reason\": \"<1 câu tiếng Việt>\"}}\n\
         Quy tắc trả lời:\n\
         - Note nào không khớp luật nào thì BỎ QUA, đừng bịa hành động.\n\
         - Ưu tiên thư mục đã có (khớp không phân biệt hoa thường) thay vì tạo tên mới.\n\
         - Không đổi tên file, không sửa nội dung, không xóa.\n\
         - Không có gì để làm thì trả về []."
    )
}

/// Chạy một nhịp: soi note đổi từ `since`, hỏi LLM, trả findings cho janitor.
pub(crate) fn run_once(vault: &Vault, provider: qa::Provider, since: i64) -> Result<Vec<Finding>> {
    let skills: Vec<Skill> = list(&vault.root)?.into_iter().filter(|s| s.enabled).collect();
    if skills.is_empty() {
        return Ok(Vec::new());
    }

    let notes = vault.db.note_list()?;
    let mut folders: Vec<String> = notes
        .iter()
        .map(|(p, _, _)| dir_of(p).to_string())
        .filter(|d| !d.is_empty())
        .collect();
    folders.sort();
    folders.dedup();

    let mut candidates = Vec::new();
    for (path, title, mtime) in &notes {
        if *mtime <= since || candidates.len() >= MAX_CANDIDATES {
            continue;
        }
        let Ok(abs) = vault.abs_path(path) else { continue };
        let Ok(body) = std::fs::read_to_string(&abs) else { continue };
        let preview: String = body.chars().take(PREVIEW_CHARS).collect();
        candidates.push((path.clone(), title.clone(), preview));
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let answer = qa::generate(provider, &build_prompt(&skills, &folders, &candidates))?;
    Ok(plan_to_findings(&skills, &candidates, &answer))
}

/// Câu trả lời của LLM → findings đã kiểm chứng. Tách riêng để test được mà
/// không cần gọi LLM thật.
pub(crate) fn plan_to_findings(
    skills: &[Skill],
    candidates: &[(String, String, String)],
    answer: &str,
) -> Vec<Finding> {
    let Some(json) = extract_json_array(answer) else { return Vec::new() };
    let Ok(items) = serde_json::from_str::<Vec<PlanItem>>(json) else { return Vec::new() };

    let mut out = Vec::new();
    for item in items {
        if out.len() >= MAX_ACTIONS {
            break;
        }
        // Path phải là một trong những note ta vừa đưa cho LLM — nó không được
        // tự nghĩ ra file khác trong vault để đụng vào.
        if !candidates.iter().any(|(p, _, _)| p == &item.path) {
            continue;
        }
        // Luật nào đang áp dụng quyết định mức tự trị; không khớp tên thì lấy
        // mức thận trọng nhất.
        let skill = skills.iter().find(|s| s.name.eq_ignore_ascii_case(item.rule.trim()));
        let severity = if skill.map(|s| s.is_auto()).unwrap_or(false) { "auto" } else { "propose" };
        let rule_name = skill.map(|s| s.name.clone()).unwrap_or_else(|| item.rule.clone());
        let reason = item.reason.trim();

        match item.action.trim().to_lowercase().as_str() {
            "move" => {
                let Some(to) = sanitize_dir(&item.to) else { continue };
                if to.eq_ignore_ascii_case(dir_of(&item.path)) {
                    continue; // đã nằm đúng chỗ rồi
                }
                let mut description = format!("[{rule_name}] {} → chuyển vào {to}/", item.path);
                if !reason.is_empty() {
                    description.push_str(&format!(" · {reason}"));
                }
                out.push(Finding {
                    rule: "skill",
                    severity,
                    description,
                    payload: Apply::MoveNote { path: item.path, to_dir: to },
                });
            }
            "tag" => {
                let Some(tag) = sanitize_tag(&item.tag) else { continue };
                out.push(Finding {
                    rule: "skill",
                    severity,
                    description: format!(
                        "[{rule_name}] {} → gắn tag #{tag}{}",
                        item.path,
                        if reason.is_empty() { String::new() } else { format!(" · {reason}") }
                    ),
                    payload: Apply::AddTag { path: item.path, tag },
                });
            }
            _ => {}
        }
    }
    out
}

/// Thêm tag vào frontmatter, giữ nguyên phần còn lại. None = đã có tag đó rồi.
pub(crate) fn with_tag(body: &str, tag: &str) -> Option<String> {
    let stem = "x";
    let parsed = vault_core::parser::parse_note(body, stem);
    if parsed.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
        return None;
    }
    // Không có frontmatter → thêm hẳn một khối mới lên đầu.
    let Some(rest) = body.strip_prefix("---\n").or_else(|| body.strip_prefix("---\r\n")) else {
        return Some(format!("---\ntags: [{tag}]\n---\n{body}"));
    };
    let Some(end) = rest.find("\n---") else {
        return Some(format!("---\ntags: [{tag}]\n---\n{body}"));
    };
    let (fm, after) = rest.split_at(end);
    let new_fm = match fm.lines().position(|l| l.trim_start().starts_with("tags:")) {
        Some(i) => {
            let mut lines: Vec<String> = fm.lines().map(str::to_string).collect();
            let line = lines[i].clone();
            lines[i] = match line.rsplit_once(']') {
                // `tags: [a, b]` → chèn trước dấu ]
                Some((head, tail)) if head.contains('[') => {
                    let sep = if head.trim_end().ends_with('[') { "" } else { ", " };
                    format!("{head}{sep}{tag}]{tail}")
                }
                // `tags:` + list nhiều dòng, hoặc `tags: a` → thêm dòng gạch đầu dòng
                _ if line.trim() == "tags:" => {
                    lines.insert(i + 1, format!("  - {tag}"));
                    line
                }
                _ => format!("{line}, {tag}"),
            };
            lines.join("\n")
        }
        None => format!("{}\ntags: [{tag}]", fm.trim_end()),
    };
    Some(format!("---\n{new_fm}{after}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, autonomy: &str) -> Skill {
        Skill {
            id: slugify(name),
            name: name.into(),
            enabled: true,
            autonomy: autonomy.into(),
            created: 1,
            last_run: 0,
            rule: "luật gì đó".into(),
        }
    }

    fn candidates() -> Vec<(String, String, String)> {
        vec![("00-Inbox/spec api.md".into(), "spec api".into(), "nội dung".into())]
    }

    #[test]
    fn slug_bo_dau_tieng_viet() {
        assert_eq!(slugify("Spec thì vào Daily"), "spec-thi-vao-daily");
        assert_eq!(slugify("  !!!  "), "rule");
    }

    #[test]
    fn frontmatter_roundtrip() {
        let s = Skill {
            id: "spec-daily".into(),
            name: "Spec vào Daily".into(),
            enabled: false,
            autonomy: "auto".into(),
            created: 10,
            last_run: 20,
            rule: "Các file note về spec thì đưa vào folder Daily".into(),
        };
        let back = parse_skill("spec-daily", &render_skill(&s));
        assert_eq!(back.name, s.name);
        assert!(!back.enabled);
        assert_eq!(back.autonomy, "auto");
        assert_eq!(back.created, 10);
        assert_eq!(back.last_run, 20);
        assert_eq!(back.rule, s.rule);
    }

    #[test]
    fn plan_chi_nhan_path_da_gui_va_hanh_dong_hop_le() {
        let skills = vec![skill("Spec vào Daily", "propose")];
        let answer = r#"Đây là kế hoạch:
```json
[
 {"path": "00-Inbox/spec api.md", "action": "move", "to": "Daily", "rule": "Spec vào Daily", "reason": "note về spec"},
 {"path": "note-khong-gui.md", "action": "move", "to": "Daily", "rule": "Spec vào Daily"},
 {"path": "00-Inbox/spec api.md", "action": "delete", "rule": "Spec vào Daily"},
 {"path": "00-Inbox/spec api.md", "action": "move", "to": "../../etc", "rule": "Spec vào Daily"}
]
```"#;
        let f = plan_to_findings(&skills, &candidates(), answer);
        assert_eq!(f.len(), 1, "chỉ giữ đúng một action hợp lệ");
        assert_eq!(f[0].severity, "propose");
        match &f[0].payload {
            Apply::MoveNote { path, to_dir } => {
                assert_eq!(path, "00-Inbox/spec api.md");
                assert_eq!(to_dir, "Daily");
            }
            other => panic!("payload sai: {other:?}"),
        }
    }

    #[test]
    fn skill_auto_thi_finding_la_auto() {
        let skills = vec![skill("Spec vào Daily", "auto")];
        let answer = r##"[{"path":"00-Inbox/spec api.md","action":"tag","tag":"#spec","rule":"Spec vào Daily"}]"##;
        let f = plan_to_findings(&skills, &candidates(), answer);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].severity, "auto");
        matches!(&f[0].payload, Apply::AddTag { tag, .. } if tag == "spec");
    }

    #[test]
    fn khong_move_khi_note_da_dung_cho() {
        let skills = vec![skill("Spec vào Daily", "propose")];
        let cands = vec![("Daily/spec api.md".into(), "spec api".into(), "x".into())];
        let answer = r#"[{"path":"Daily/spec api.md","action":"move","to":"daily","rule":"Spec vào Daily"}]"#;
        assert!(plan_to_findings(&skills, &cands, answer).is_empty());
    }

    #[test]
    fn tra_loi_rac_thi_khong_lam_gi() {
        let skills = vec![skill("Spec vào Daily", "propose")];
        assert!(plan_to_findings(&skills, &candidates(), "xin lỗi tôi không chắc").is_empty());
        assert!(plan_to_findings(&skills, &candidates(), "[{broken").is_empty());
    }

    #[test]
    fn them_tag_vao_frontmatter() {
        assert_eq!(
            with_tag("# Note\nnội dung\n", "spec").unwrap(),
            "---\ntags: [spec]\n---\n# Note\nnội dung\n"
        );
        assert_eq!(
            with_tag("---\ntitle: A\ntags: [x]\n---\nbody\n", "spec").unwrap(),
            "---\ntitle: A\ntags: [x, spec]\n---\nbody\n"
        );
        assert_eq!(
            with_tag("---\ntitle: A\n---\nbody\n", "spec").unwrap(),
            "---\ntitle: A\ntags: [spec]\n---\nbody\n"
        );
        // Đã có tag rồi thì không đụng vào file.
        assert!(with_tag("---\ntags: [spec]\n---\nbody\n", "spec").is_none());
        assert!(with_tag("---\ntags: [spec]\n---\nbody\n", "SPEC").is_none());
    }

    #[test]
    fn scan_since_lay_moc_lac_hau_nhat() {
        let now = 1_000_000;
        let mut a = skill("A", "propose");
        a.last_run = now - 3600;
        let mut b = skill("B", "propose");
        b.last_run = now - 7200;
        let mut off = skill("C", "propose");
        off.enabled = false;
        off.last_run = 0;
        assert_eq!(scan_since(&[a.clone(), b.clone(), off], now), now - 7200);
        // Skill mới toanh: chỉ ngoái lại 7 ngày.
        let fresh = skill("D", "propose");
        assert_eq!(scan_since(&[fresh], now), now - 7 * 24 * 3600);
    }
}
