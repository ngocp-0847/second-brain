//! Parse một note Markdown: frontmatter, wikilinks, tags, chunks theo heading.
//!
//! Cú pháp tương thích Obsidian: `[[note]]`, `[[note|alias]]`, `[[note#heading]]`,
//! `[[note#^block]]`, `![[embed]]`, YAML frontmatter, `#tag` inline.
//! Offset của link là byte offset trong nội dung file gốc (kể cả frontmatter)
//! để về sau rewrite link khi rename/move không cần parse lại.

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Wiki,
    Embed,
    Markdown,
}

impl LinkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Embed => "embed",
            LinkKind::Markdown => "md",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RawLink {
    /// Phần target thô, chưa resolve: "Note Title" hoặc "folder/note".
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub alias: Option<String>,
    pub kind: LinkKind,
    /// Byte offset của toàn bộ link (kể cả `[[`/`![[`) trong file gốc.
    pub offset: usize,
    /// Độ dài byte của toàn bộ link.
    pub len: usize,
}

#[derive(Debug, Clone)]
pub struct Chunk {
    /// Breadcrumb heading, ví dụ "Rust > Ownership > Borrowing". Rỗng nếu trước heading đầu.
    pub heading_path: String,
    pub start_line: usize, // 1-based, inclusive
    pub end_line: usize,   // 1-based, inclusive
    pub text: String,
}

#[derive(Debug)]
pub struct ParsedNote {
    pub title: String,
    pub frontmatter: Option<serde_json::Value>,
    pub links: Vec<RawLink>,
    pub tags: Vec<String>,
    pub chunks: Vec<Chunk>,
}

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?)\[\[([^\[\]]+?)\]\]").unwrap());
static MDLINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[[^\]]*\]\(([^)\s]+)\)").unwrap());
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}/_-]*)").unwrap());
static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").unwrap());

/// `stem` = tên file không đuôi, dùng làm title fallback.
pub fn parse_note(content: &str, stem: &str) -> ParsedNote {
    let (frontmatter, body_offset) = split_frontmatter(content);

    let mut links = Vec::new();
    let mut tags = Vec::new();
    let mut chunks = Vec::new();
    let mut first_h1: Option<String> = None;

    // Tags từ frontmatter: `tags: [a, b]` hoặc `tags: a` hoặc list nhiều dòng.
    if let Some(fm) = &frontmatter {
        match fm.get("tags") {
            Some(serde_json::Value::Array(arr)) => {
                for t in arr {
                    if let Some(s) = t.as_str() {
                        tags.push(s.trim_start_matches('#').to_string());
                    }
                }
            }
            Some(serde_json::Value::String(s)) => {
                for t in s.split([',', ' ']).filter(|t| !t.is_empty()) {
                    tags.push(t.trim_start_matches('#').to_string());
                }
            }
            _ => {}
        }
    }

    // Quét body theo dòng, theo dõi byte offset và fenced code block.
    let body = &content[body_offset..];
    let mut in_fence = false;
    let mut fence_marker = "";
    let mut offset = body_offset;

    // Trạng thái chunk hiện tại.
    let mut heading_stack: Vec<(u8, String)> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_start_line = 1usize;
    let mut cur_path = String::new();

    let base_line = content[..body_offset].matches('\n').count(); // số dòng frontmatter chiếm

    for (i, line) in body.split_inclusive('\n').enumerate() {
        let line_no = base_line + i + 1;
        let trimmed = line.trim_start();

        // Fenced code: ``` hoặc ~~~
        let fence = if trimmed.starts_with("```") {
            "```"
        } else if trimmed.starts_with("~~~") {
            "~~~"
        } else {
            ""
        };
        if !fence.is_empty() {
            if !in_fence {
                in_fence = true;
                fence_marker = fence;
            } else if fence == fence_marker {
                in_fence = false;
            }
            cur_text.push_str(line);
            offset += line.len();
            continue;
        }

        if in_fence {
            cur_text.push_str(line);
            offset += line.len();
            continue;
        }

        // Heading ATX → chốt chunk hiện tại, mở chunk mới.
        if let Some((level, text)) = parse_heading(trimmed) {
            if !cur_text.trim().is_empty() {
                chunks.push(Chunk {
                    heading_path: cur_path.clone(),
                    start_line: cur_start_line,
                    end_line: line_no.saturating_sub(1),
                    text: std::mem::take(&mut cur_text),
                });
            } else {
                cur_text.clear();
            }
            if level == 1 && first_h1.is_none() {
                first_h1 = Some(text.clone());
            }
            while heading_stack.last().is_some_and(|(l, _)| *l >= level) {
                heading_stack.pop();
            }
            heading_stack.push((level, text));
            cur_path = heading_stack
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>()
                .join(" > ");
            cur_start_line = line_no;
            cur_text.push_str(line);
            offset += line.len();
            continue;
        }

        // Che inline code bằng khoảng trắng cùng độ dài để offset không lệch.
        let scannable = if line.contains('`') {
            INLINE_CODE_RE
                .replace_all(line, |c: &regex::Captures| " ".repeat(c[0].len()))
                .into_owned()
        } else {
            line.to_string()
        };

        for cap in WIKILINK_RE.captures_iter(&scannable) {
            let whole = cap.get(0).unwrap();
            let is_embed = !cap[1].is_empty();
            let inner = &cap[2];
            let (target_part, alias) = match inner.split_once('|') {
                Some((t, a)) => (t, Some(a.trim().to_string())),
                None => (inner, None),
            };
            let (target, heading, block) = match target_part.split_once('#') {
                Some((t, rest)) => {
                    if let Some(b) = rest.strip_prefix('^') {
                        (t, None, Some(b.trim().to_string()))
                    } else {
                        (t, Some(rest.trim().to_string()), None)
                    }
                }
                None => (target_part, None, None),
            };
            links.push(RawLink {
                target: target.trim().to_string(),
                heading,
                block,
                alias,
                kind: if is_embed { LinkKind::Embed } else { LinkKind::Wiki },
                offset: offset + whole.start(),
                len: whole.len(),
            });
        }

        for cap in MDLINK_RE.captures_iter(&scannable) {
            let whole = cap.get(0).unwrap();
            let url = &cap[1];
            if url.contains("://") || url.starts_with("mailto:") || url.starts_with('#') {
                continue;
            }
            let decoded = percent_decode(url);
            let (path, heading) = match decoded.split_once('#') {
                Some((p, h)) => (p.to_string(), Some(h.to_string())),
                None => (decoded, None),
            };
            links.push(RawLink {
                target: path,
                heading,
                block: None,
                alias: None,
                kind: LinkKind::Markdown,
                offset: offset + whole.start(),
                len: whole.len(),
            });
        }

        for cap in TAG_RE.captures_iter(&scannable) {
            tags.push(cap[2].to_string());
        }

        cur_text.push_str(line);
        offset += line.len();
    }

    let total_lines = base_line + body.split_inclusive('\n').count();
    if !cur_text.trim().is_empty() {
        chunks.push(Chunk {
            heading_path: cur_path,
            start_line: cur_start_line,
            end_line: total_lines,
            text: cur_text,
        });
    }

    tags.sort();
    tags.dedup();

    let title = frontmatter
        .as_ref()
        .and_then(|fm| fm.get("title"))
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .or(first_h1)
        .unwrap_or_else(|| stem.to_string());

    ParsedNote { title, frontmatter, links, tags, chunks }
}

/// Trả về (frontmatter đã parse, byte offset nơi body bắt đầu).
fn split_frontmatter(content: &str) -> (Option<serde_json::Value>, usize) {
    let after = if let Some(rest) = content.strip_prefix("---\r\n") {
        (rest, 5)
    } else if let Some(rest) = content.strip_prefix("---\n") {
        (rest, 4)
    } else {
        return (None, 0);
    };
    let (rest, prefix_len) = after;
    for pat in ["\n---\n", "\n---\r\n", "\r\n---\r\n", "\r\n---\n"] {
        if let Some(end) = rest.find(pat) {
            let yaml = &rest[..end];
            let fm = serde_yaml::from_str::<serde_json::Value>(yaml)
                .ok()
                .filter(|v| v.is_object());
            return (fm, prefix_len + end + pat.len());
        }
    }
    // Frontmatter mở nhưng không đóng → coi toàn bộ là body.
    (None, 0)
}

fn parse_heading(trimmed: &str) -> Option<(u8, String)> {
    let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some((hashes as u8, rest.trim().trim_end_matches('#').trim().to_string()))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\ntitle: My Note\ntags: [rust, wiki]\n---\n# Heading One\nText with [[Other Note]] and [[Folder/Deep|alias]].\n\n## Sub\nEmbed ![[image.png]] and [[Note#Section]] plus [[Note#^block1]].\nInline #tag-one here.\n\n```rust\nlet x = \"[[not a link]]\";\n```\n[md link](other%20note.md)\n";

    #[test]
    fn parses_links_and_skips_code() {
        let n = parse_note(SAMPLE, "sample");
        let targets: Vec<_> = n.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(
            targets,
            vec!["Other Note", "Folder/Deep", "image.png", "Note", "Note", "other note.md"]
        );
        assert!(!targets.contains(&"not a link"));
        assert_eq!(n.links[1].alias.as_deref(), Some("alias"));
        assert_eq!(n.links[2].kind, LinkKind::Embed);
        assert_eq!(n.links[3].heading.as_deref(), Some("Section"));
        assert_eq!(n.links[4].block.as_deref(), Some("block1"));
    }

    #[test]
    fn link_offsets_point_at_source() {
        let n = parse_note(SAMPLE, "sample");
        for l in &n.links {
            let slice = &SAMPLE[l.offset..l.offset + l.len];
            assert!(slice.starts_with("[[") || slice.starts_with("![[") || slice.starts_with('['), "bad slice: {slice}");
        }
    }

    #[test]
    fn title_tags_chunks() {
        let n = parse_note(SAMPLE, "sample");
        assert_eq!(n.title, "My Note");
        assert!(n.tags.contains(&"rust".to_string()));
        assert!(n.tags.contains(&"tag-one".to_string()));
        assert_eq!(n.chunks.len(), 2);
        assert_eq!(n.chunks[0].heading_path, "Heading One");
        assert_eq!(n.chunks[1].heading_path, "Heading One > Sub");
    }

    #[test]
    fn title_fallback_to_stem() {
        let n = parse_note("just text, no heading", "my-file");
        assert_eq!(n.title, "my-file");
        assert_eq!(n.chunks.len(), 1);
    }
}
