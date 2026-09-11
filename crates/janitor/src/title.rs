//! Rule "untitled-note": note còn mang tên mặc định (`Untitled`, `Untitled 2`…)
//! thì đọc nội dung đoán một cái tên và đề xuất đổi.
//!
//! Deterministic, không cần LLM: lấy dòng có nghĩa đầu tiên của note. Note tạo
//! bằng nút "Note mới" có sẵn `# Untitled 2` nên phải bỏ qua chính dòng đó rồi
//! mới nhìn xuống dưới.
//!
//! Luôn ở mức propose — đổi tên file là thứ người dùng phải nhìn thấy trước khi
//! xảy ra, và `rename_note` còn rewrite mọi wikilink trỏ tới.

use crate::{Apply, Finding};
use anyhow::Result;
use std::path::Path;
use vault_core::Vault;

/// Tên gợi ý dài hơn ngưỡng này thì cắt ở ranh giới từ.
const MAX_TITLE_CHARS: usize = 60;
/// Quá ngắn thì không phải cái tên, thà để nguyên `Untitled`.
const MIN_TITLE_CHARS: usize = 3;
/// Trần số đề xuất mỗi lần chạy — vault bỏ bê có thể có hàng chục note Untitled,
/// đổ hết vào report thì không ai duyệt nổi.
const MAX_PER_RUN: usize = 20;

/// Tên mặc định do app (hoặc Obsidian) đặt, không mang thông tin gì.
pub(crate) fn is_placeholder(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    // "Untitled 2", "untitled-3", "Untitled_10" → cùng một gốc.
    let stem = lower
        .trim_end_matches(|c: char| c.is_ascii_digit() || c == ' ' || c == '-' || c == '_')
        .trim();
    matches!(stem, "untitled" | "untitled note" | "new note" | "không tên" | "khong ten")
}

fn strip_frontmatter(body: &str) -> &str {
    let rest = match body.strip_prefix("---\n").or_else(|| body.strip_prefix("---\r\n")) {
        Some(r) => r,
        None => return body,
    };
    // Dòng `---` đóng frontmatter; không có thì coi như không có frontmatter.
    match rest.split_once("\n---") {
        Some((_, after)) => after.trim_start_matches(['-', '\r', '\n']),
        None => body,
    }
}

/// Bỏ cú pháp inline để còn lại chữ người đọc: `**đậm**`, `` `code` ``,
/// `[nhãn](url)`, `[[note|nhãn]]`.
fn clean_inline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '_' | '`' | '~' => continue,
            '!' if chars.peek() == Some(&'[') => continue, // ảnh: bỏ dấu !, phần [alt] xử lý dưới
            '[' => {
                // `[[a|b]]` → b · `[[a]]` → a · `[t](u)` → t
                let wiki = chars.peek() == Some(&'[');
                if wiki {
                    chars.next();
                }
                let mut inner = String::new();
                let mut depth = 1;
                for c2 in chars.by_ref() {
                    if c2 == '[' {
                        depth += 1;
                    } else if c2 == ']' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                        continue;
                    }
                    inner.push(c2);
                }
                if wiki {
                    // nuốt nốt ']' thứ hai
                    if chars.peek() == Some(&']') {
                        chars.next();
                    }
                    let shown = inner.rsplit('|').next().unwrap_or(&inner);
                    out.push_str(shown);
                } else {
                    out.push_str(&inner);
                    // bỏ phần (url) đi kèm nếu có
                    if chars.peek() == Some(&'(') {
                        for c2 in chars.by_ref() {
                            if c2 == ')' {
                                break;
                            }
                        }
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cắt ở ranh giới từ, không cắt giữa chữ.
fn truncate_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out = String::new();
    for w in s.split_whitespace() {
        if out.chars().count() + w.chars().count() + 1 > max {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    if out.is_empty() {
        out = s.chars().take(max).collect();
    }
    format!("{}…", out.trim_end())
}

/// Dòng có nghĩa đầu tiên của note → tên gợi ý. None = không đoán được.
pub(crate) fn suggest_title(body: &str) -> Option<String> {
    let mut in_fence = false;
    for raw in strip_frontmatter(body).lines() {
        let line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        // Trong code block, bảng, hoặc dòng kẻ ngang: không phải câu chữ của note.
        if in_fence || line.is_empty() || line.starts_with('|') || line.starts_with("---") {
            continue;
        }
        let mut t = line.trim_start_matches('#').trim_start();
        t = t.trim_start_matches(['-', '*', '+', '>']).trim_start();
        for box_mark in ["[ ]", "[x]", "[X]"] {
            if let Some(rest) = t.strip_prefix(box_mark) {
                t = rest.trim_start();
            }
        }
        if t.starts_with("http://") || t.starts_with("https://") {
            continue; // URL trần làm tên note thì cũng như không
        }
        let cleaned = clean_inline(t);
        if cleaned.chars().count() < MIN_TITLE_CHARS || is_placeholder(&cleaned) {
            continue;
        }
        return Some(truncate_words(&cleaned, MAX_TITLE_CHARS));
    }
    None
}

/// Tên file hợp lệ trên Windows lẫn POSIX từ một tiêu đề tự do.
pub(crate) fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    // Windows không cho tên kết thúc bằng '.' hoặc khoảng trắng.
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .trim()
        .chars()
        .take(80)
        .collect()
}

/// Path chưa bị chiếm trong cùng thư mục với note cũ (`tên.md`, `tên 2.md`…).
pub(crate) fn unique_path(vault: &Vault, old_rel: &str, name: &str) -> Result<String> {
    let dir = match old_rel.rsplit_once('/') {
        Some((d, _)) => format!("{d}/"),
        None => String::new(),
    };
    let mut rel = format!("{dir}{name}.md");
    let mut i = 2;
    while rel != old_rel && vault.abs_path(&rel).map(|p| p.exists()).unwrap_or(false) {
        rel = format!("{dir}{name} {i}.md");
        i += 1;
    }
    Ok(rel)
}

/// Note nào còn tên mặc định → đề xuất tên lấy từ nội dung.
pub(crate) fn propose_titles(vault: &Vault) -> Result<Vec<Finding>> {
    let mut out = Vec::new();
    for (path, title, _) in vault.db.note_list()? {
        if out.len() >= MAX_PER_RUN {
            break;
        }
        let stem = Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or(&path);
        if !is_placeholder(stem) {
            continue;
        }
        // Title đã tử tế (user sửa H1 nhưng chưa đổi tên file) → dùng luôn,
        // khỏi phải đoán lại từ nội dung.
        let suggested = if is_placeholder(&title) {
            let Ok(abs) = vault.abs_path(&path) else { continue };
            let Ok(body) = std::fs::read_to_string(&abs) else { continue };
            match suggest_title(&body) {
                Some(t) => t,
                None => continue, // note rỗng — stale-stub lo phần đó
            }
        } else {
            truncate_words(&title, MAX_TITLE_CHARS)
        };

        let name = safe_file_name(&suggested);
        if name.is_empty() || is_placeholder(&name) {
            continue;
        }
        out.push(Finding {
            rule: "untitled-note",
            severity: "propose",
            description: format!("\"{stem}\" ({path}) còn tên mặc định → đặt tên \"{name}\" theo nội dung"),
            payload: Apply::RetitleNote { path, title: name },
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_forms() {
        assert!(is_placeholder("Untitled"));
        assert!(is_placeholder("Untitled 2"));
        assert!(is_placeholder("untitled-10"));
        assert!(is_placeholder("Không tên"));
        assert!(!is_placeholder("Untitled Symphony"));
        assert!(!is_placeholder("2024"));
        assert!(!is_placeholder("Họp CR"));
    }

    #[test]
    fn skips_placeholder_h1_and_code() {
        let body = "# Untitled 2\n\n```json\n{\"a\": 1}\n```\n\nCách ăn agreement của FPaaS\n";
        assert_eq!(suggest_title(body), Some("Cách ăn agreement của FPaaS".into()));
    }

    #[test]
    fn uses_first_real_heading() {
        let body = "---\ntitle: x\ntags: [a]\n---\n# Trạng thái các API shenshei\nnội dung\n";
        assert_eq!(suggest_title(body), Some("Trạng thái các API shenshei".into()));
    }

    #[test]
    fn strips_markdown_noise() {
        let body = "# Untitled\n\n- **[[Luồng qua trust idiom|Trust idiom]]** rất `quan trọng`\n";
        assert_eq!(suggest_title(body), Some("Trust idiom rất quan trọng".into()));
    }

    #[test]
    fn empty_note_has_no_suggestion() {
        assert_eq!(suggest_title("# Untitled 3\n\n"), None);
        assert_eq!(suggest_title(""), None);
    }

    #[test]
    fn long_line_is_cut_at_word_boundary() {
        let body = format!("# Untitled\n\n{}\n", "alpha ".repeat(40));
        let t = suggest_title(&body).unwrap();
        assert!(t.chars().count() <= MAX_TITLE_CHARS + 1, "{t}");
        assert!(t.ends_with('…'));
        assert!(!t.contains("alph…"));
    }

    #[test]
    fn file_name_drops_illegal_chars() {
        assert_eq!(safe_file_name("a/b: c*d?"), "a b c d");
        assert_eq!(safe_file_name("  nhiều   khoảng  trắng.  "), "nhiều khoảng trắng");
    }
}
