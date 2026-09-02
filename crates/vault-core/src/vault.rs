//! Vault: quét thư mục, index tăng dần vào SQLite.

use anyhow::Result;
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::db::Db;
use crate::parser::{parse_note, ParsedNote};

/// Các thư mục app/tool sinh ra, không bao giờ index.
const SKIP_DIRS: &[&str] = &[".brain", ".obsidian", ".trash", ".git", "node_modules"];

pub struct Vault {
    pub root: PathBuf,
    pub db: Db,
}

#[derive(Debug, Default)]
pub struct IndexStats {
    pub scanned: usize,
    pub updated: usize,
    pub removed: usize,
    pub duration_ms: u128,
}

struct FileMeta {
    rel_path: String,
    abs_path: PathBuf,
    mtime: i64,
    size: i64,
}

struct ParsedFile {
    rel_path: String,
    parsed: ParsedNote,
    mtime: i64,
    size: i64,
    hash: Vec<u8>,
}

impl Vault {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root: PathBuf = root.into();
        let db = Db::open(&root.join(".brain").join("cache.db"))?;
        Ok(Vault { root, db })
    }

    /// Index tăng dần: chỉ đọc + parse file có mtime/size đổi, chỉ ghi file có hash đổi.
    pub fn index(&mut self) -> Result<IndexStats> {
        let t0 = Instant::now();
        let mut stats = IndexStats::default();

        let files = self.scan_files();
        stats.scanned = files.len();

        let known: HashMap<String, (i64, i64, Vec<u8>)> = self
            .db
            .all_notes()?
            .into_iter()
            .map(|n| (n.path, (n.mtime, n.size, n.content_hash)))
            .collect();

        // Note trong db nhưng file đã biến mất → xóa.
        let on_disk: std::collections::HashSet<&str> =
            files.iter().map(|f| f.rel_path.as_str()).collect();
        let gone: Vec<String> =
            known.keys().filter(|p| !on_disk.contains(p.as_str())).cloned().collect();
        if !gone.is_empty() {
            stats.removed = self.db.remove_notes(&gone)?;
        }

        // Chỉ parse file mới hoặc có mtime/size khác cache.
        let dirty: Vec<&FileMeta> = files
            .iter()
            .filter(|f| {
                known
                    .get(&f.rel_path)
                    .map(|(m, s, _)| *m != f.mtime || *s != f.size)
                    .unwrap_or(true)
            })
            .collect();

        let parsed: Vec<ParsedFile> = dirty
            .par_iter()
            .filter_map(|f| {
                let content = std::fs::read_to_string(&f.abs_path).ok()?;
                let hash = blake3::hash(content.as_bytes()).as_bytes().to_vec();
                let stem = Path::new(&f.rel_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&f.rel_path);
                Some(ParsedFile {
                    rel_path: f.rel_path.clone(),
                    parsed: parse_note(&content, stem),
                    mtime: f.mtime,
                    size: f.size,
                    hash,
                })
            })
            .collect();

        for pf in &parsed {
            // mtime đổi nhưng nội dung y nguyên → khỏi ghi lại links/chunks.
            if known.get(&pf.rel_path).is_some_and(|(_, _, h)| *h == pf.hash) {
                continue;
            }
            self.db
                .upsert_note(&pf.rel_path, &pf.parsed, pf.mtime, pf.size, &pf.hash)?;
            stats.updated += 1;
        }

        if stats.updated > 0 || stats.removed > 0 {
            self.db.resolve_links()?;
        }

        stats.duration_ms = t0.elapsed().as_millis();
        Ok(stats)
    }

    /// Đường dẫn tuyệt đối của một path tương đối, chặn traversal ra ngoài vault.
    pub fn abs_path(&self, rel: &str) -> Result<PathBuf> {
        let rel = rel.replace('\\', "/");
        if rel.split('/').any(|c| c == ".." || c.is_empty() && rel.starts_with('/')) {
            anyhow::bail!("đường dẫn không hợp lệ: {rel}");
        }
        Ok(self.root.join(rel))
    }

    /// Đổi tên / di chuyển note và rewrite mọi wikilink trỏ tới nó.
    /// Trả về số link đã rewrite.
    pub fn rename_note(&mut self, old_rel: &str, new_rel: &str) -> Result<usize> {
        self.index()?; // offsets trong db phải khớp nội dung file hiện tại

        let old_norm = old_rel.replace('\\', "/");
        let mut new_norm = new_rel.replace('\\', "/");
        if !new_norm.to_lowercase().ends_with(".md") {
            new_norm.push_str(".md");
        }
        let id = self
            .db
            .note_id(&old_norm)?
            .ok_or_else(|| anyhow::anyhow!("không tìm thấy note: {old_norm}"))?;
        let incoming = self.db.incoming_links(id)?;

        let old_abs = self.abs_path(&old_norm)?;
        let new_abs = self.abs_path(&new_norm)?;
        if new_abs.exists() {
            anyhow::bail!("đích đã tồn tại: {new_norm}");
        }
        if let Some(dir) = new_abs.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&old_abs, &new_abs)?;

        // Target mới: dùng stem nếu không đụng độ với note khác, ngược lại dùng path đầy đủ.
        let new_stem = Path::new(&new_norm)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&new_norm)
            .to_string();
        let stem_taken = self.db.note_list()?.iter().any(|(p, _, _)| {
            p != &old_norm
                && Path::new(p)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case(&new_stem))
        });
        let wiki_target =
            if stem_taken { new_norm.trim_end_matches(".md").to_string() } else { new_stem };

        // Gom link theo file nguồn; incoming đã sắp DESC theo offset nên apply an toàn.
        let mut by_src: std::collections::HashMap<String, Vec<(i64, i64, String)>> =
            std::collections::HashMap::new();
        for (src, off, len, kind) in incoming {
            // Note tự link tới chính nó: sau fs::rename phải đọc ở path mới.
            let src = if src == old_norm { new_norm.clone() } else { src };
            by_src.entry(src).or_default().push((off, len, kind));
        }

        let mut rewritten = 0;
        for (src, links) in by_src {
            let src_abs = self.abs_path(&src)?;
            let mut content = std::fs::read_to_string(&src_abs)?;
            for (off, len, _kind) in links {
                let (off, len) = (off as usize, len as usize);
                let Some(slice) = content.get(off..off + len) else { continue };
                if let Some(new_link) = rewrite_link(slice, &wiki_target, &new_norm) {
                    content = format!("{}{}{}", &content[..off], new_link, &content[off + len..]);
                    rewritten += 1;
                }
            }
            std::fs::write(&src_abs, content)?;
        }

        self.index()?;
        Ok(rewritten)
    }

    /// Sửa mọi link gãy đang trỏ tới `bad_target` cho trỏ về `new_target`
    /// (một note đang tồn tại). Trả về số link đã sửa.
    pub fn fix_link_target(&mut self, bad_target: &str, new_target: &str) -> Result<usize> {
        self.index()?;
        let new_path = self
            .db
            .resolve_target(new_target)?
            .ok_or_else(|| anyhow::anyhow!("đích không tồn tại: {new_target}"))?;
        let wiki_target = Path::new(&new_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&new_path)
            .to_string();

        let rows: Vec<(String, i64, i64)> = {
            let mut stmt = self.db.conn.prepare(
                r#"SELECT s.path, l.src_offset, l.src_len
                   FROM link l JOIN note s ON s.id = l.src_note
                   WHERE l.target_note IS NULL AND l.target_path = ?1
                   ORDER BY s.path, l.src_offset DESC"#,
            )?;
            let rows = stmt
                .query_map([bad_target], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        let mut by_src: std::collections::HashMap<String, Vec<(i64, i64)>> =
            std::collections::HashMap::new();
        for (src, off, len) in rows {
            by_src.entry(src).or_default().push((off, len));
        }

        let mut fixed = 0;
        for (src, links) in by_src {
            let src_abs = self.abs_path(&src)?;
            let mut content = std::fs::read_to_string(&src_abs)?;
            for (off, len) in links {
                let (off, len) = (off as usize, len as usize);
                let Some(slice) = content.get(off..off + len) else { continue };
                if let Some(new_link) = rewrite_link(slice, &wiki_target, &new_path) {
                    content = format!("{}{}{}", &content[..off], new_link, &content[off + len..]);
                    fixed += 1;
                }
            }
            std::fs::write(&src_abs, content)?;
        }
        self.index()?;
        Ok(fixed)
    }

    /// Liệt kê mọi thư mục con (path tương đối, "/"), bỏ SKIP_DIRS — để UI hiện cả folder rỗng.
    pub fn list_dirs(&self) -> Vec<String> {
        WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && SKIP_DIRS.contains(&name.as_ref()))
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
            .filter_map(|e| {
                let rel = e
                    .path()
                    .strip_prefix(&self.root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                (!rel.is_empty()).then_some(rel)
            })
            .collect()
    }

    /// Đổi tên / di chuyển thư mục rồi re-index. Wikilink theo stem vẫn resolve
    /// sau khi index lại; link markdown theo path tuyệt đối sẽ do janitor bắt nếu gãy.
    pub fn rename_dir(&mut self, old_rel: &str, new_rel: &str) -> Result<()> {
        let old_abs = self.abs_path(old_rel)?;
        let new_abs = self.abs_path(new_rel)?;
        if !old_abs.is_dir() {
            anyhow::bail!("không phải thư mục: {old_rel}");
        }
        if new_abs.exists() {
            anyhow::bail!("đích đã tồn tại: {new_rel}");
        }
        if let Some(p) = new_abs.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::rename(&old_abs, &new_abs)?;
        self.index()?;
        Ok(())
    }

    /// "Xóa" = chuyển vào .brain/trash (giữ 90 ngày theo thiết kế, dọn dẹp là việc của janitor).
    pub fn trash_note(&mut self, rel: &str) -> Result<()> {
        let abs = self.abs_path(rel)?;
        std::fs::rename(&abs, self.trash_target(rel, "note.md")?)?;
        self.index()?;
        Ok(())
    }

    /// Xóa cả folder = chuyển nguyên thư mục vào .brain/trash, giống `trash_note`.
    pub fn trash_dir(&mut self, rel: &str) -> Result<()> {
        let rel_norm = rel.trim_matches('/').to_string();
        if rel_norm.is_empty() {
            anyhow::bail!("không thể xóa thư mục gốc của vault");
        }
        let abs = self.abs_path(&rel_norm)?;
        if !abs.is_dir() {
            anyhow::bail!("không phải thư mục: {rel_norm}");
        }
        std::fs::rename(&abs, self.trash_target(&rel_norm, "folder")?)?;
        self.index()?;
        Ok(())
    }

    /// Nhân bản note sang tên chưa bị chiếm (`ghi chú` → `ghi chú 1`).
    /// Trả về path tương đối của bản sao.
    pub fn duplicate_note(&mut self, rel: &str) -> Result<String> {
        let src = self.abs_path(rel)?;
        let rel_norm = rel.replace('\\', "/");
        let (stem, ext) = match rel_norm.rsplit_once('.') {
            Some((s, e)) => (s, e),
            None => (rel_norm.as_str(), "md"),
        };
        let mut i = 1;
        let mut dst_rel = format!("{stem} {i}.{ext}");
        while self.root.join(&dst_rel).exists() {
            i += 1;
            dst_rel = format!("{stem} {i}.{ext}");
        }
        std::fs::copy(&src, self.root.join(&dst_rel))?;
        self.index()?;
        Ok(dst_rel)
    }

    /// Chỗ trống trong .brain/trash cho `rel`, tên có timestamp để không đè nhau.
    fn trash_target(&self, rel: &str, fallback: &str) -> Result<PathBuf> {
        let trash = self.root.join(".brain").join("trash");
        std::fs::create_dir_all(&trash)?;
        let ts = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let name = Path::new(rel).file_name().and_then(|s| s.to_str()).unwrap_or(fallback);
        Ok(trash.join(format!("{ts}-{}", name.replace(['/', '\\'], "_"))))
    }

    fn scan_files(&self) -> Vec<FileMeta> {
        WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && SKIP_DIRS.contains(&name.as_ref()))
            })
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("md"))
            })
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                let mtime = meta
                    .modified()
                    .ok()?
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_secs() as i64;
                let rel = e
                    .path()
                    .strip_prefix(&self.root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                Some(FileMeta {
                    rel_path: rel,
                    abs_path: e.path().to_path_buf(),
                    mtime,
                    size: meta.len() as i64,
                })
            })
            .collect()
    }
}

/// Viết lại một link (slice nguyên văn từ file nguồn) để trỏ tới target mới,
/// giữ nguyên heading/block ref và alias.
fn rewrite_link(slice: &str, wiki_target: &str, new_rel: &str) -> Option<String> {
    if let Some(inner) =
        slice.strip_prefix("![[").or_else(|| slice.strip_prefix("[[")).and_then(|s| s.strip_suffix("]]"))
    {
        let prefix = if slice.starts_with('!') { "![[" } else { "[[" };
        let (target_part, alias) = match inner.split_once('|') {
            Some((t, a)) => (t, Some(a)),
            None => (inner, None),
        };
        let sub = target_part.split_once('#').map(|(_, s)| s);
        let mut out = format!("{prefix}{wiki_target}");
        if let Some(s) = sub {
            out.push('#');
            out.push_str(s);
        }
        if let Some(a) = alias {
            out.push('|');
            out.push_str(a);
        }
        out.push_str("]]");
        Some(out)
    } else if slice.starts_with('[') {
        // Markdown link: [label](url#fragment)
        let paren = slice.find("](")?;
        let label = &slice[..paren + 1];
        let url = slice[paren + 2..].strip_suffix(')')?;
        let fragment = url.split_once('#').map(|(_, f)| f);
        let mut new_url = new_rel.replace(' ', "%20");
        if let Some(f) = fragment {
            new_url.push('#');
            new_url.push_str(f);
        }
        Some(format!("{label}({new_url})"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn index_and_query_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("brain-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write(&tmp, "a.md", "# Alpha\nLink to [[Beta]] and [[Missing]].\n");
        write(&tmp, "sub/beta.md", "---\ntitle: Beta\n---\nContent about tokio runtime.\n");
        write(&tmp, "lonely.md", "# Lonely\nNo links at all.\n");

        let mut v = Vault::open(&tmp).unwrap();
        let s = v.index().unwrap();
        assert_eq!(s.scanned, 3);
        assert_eq!(s.updated, 3);

        // Backlink: a.md → Beta (resolve qua stem, không phân biệt hoa thường).
        let bl = v.db.backlinks("sub/beta.md").unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].src_path, "a.md");

        let broken = v.db.broken_links().unwrap();
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].target, "Missing");

        let orphans = v.db.orphans().unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].0, "lonely.md");

        // Index lần 2: không có gì đổi.
        let s2 = v.index().unwrap();
        assert_eq!(s2.updated, 0);
        assert_eq!(s2.removed, 0);

        // Xóa file → note biến mất, link thành broken.
        std::fs::remove_file(tmp.join("sub/beta.md")).unwrap();
        let s3 = v.index().unwrap();
        assert_eq!(s3.removed, 1);
        assert_eq!(v.db.broken_links().unwrap().len(), 2);

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rename_rewrites_incoming_links() {
        let tmp = std::env::temp_dir().join(format!("brain-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write(&tmp, "a.md", "See [[Beta]] and [[Beta#Intro|the beta note]].\nAlso [md](sub/beta.md#Intro).\n");
        write(&tmp, "sub/beta.md", "---\ntitle: Beta\n---\n# Intro\nHello.\n");

        let mut v = Vault::open(&tmp).unwrap();
        v.index().unwrap();

        let n = v.rename_note("sub/beta.md", "archive/Beta Renamed.md").unwrap();
        assert_eq!(n, 3);

        let a = std::fs::read_to_string(tmp.join("a.md")).unwrap();
        assert!(a.contains("[[Beta Renamed]]"), "got: {a}");
        assert!(a.contains("[[Beta Renamed#Intro|the beta note]]"), "got: {a}");
        assert!(a.contains("[md](archive/Beta%20Renamed.md#Intro)"), "got: {a}");
        assert!(tmp.join("archive/Beta Renamed.md").exists());

        // Sau rename: không còn broken link, backlink trỏ về path mới.
        assert!(v.db.broken_links().unwrap().is_empty());
        assert_eq!(v.db.backlinks("archive/Beta Renamed.md").unwrap().len(), 3);

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn related_notes_uses_tags_and_cocitation() {
        let tmp = std::env::temp_dir().join(format!("brain-related-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write(&tmp, "hub.md", "# Hub\nTrung tâm.\n");
        write(&tmp, "me.md", "---\ntags: [rust, async]\n---\n# Me\nXem [[hub]].\n");
        // Cùng tag + cùng link tới hub → phải đứng đầu.
        write(&tmp, "sibling.md", "---\ntags: [rust, async]\n---\n# Sibling\nXem [[hub]].\n");
        // Không tag, không link → không được xuất hiện.
        write(&tmp, "stranger.md", "# Stranger\nChuyện khác hẳn.\n");

        let mut v = Vault::open(&tmp).unwrap();
        v.index().unwrap();

        let rel = v.db.related_notes("me.md", 8).unwrap();
        assert_eq!(rel[0].path, "sibling.md", "got: {rel:?}");
        assert!(rel[0].reason.contains("tag chung"), "got: {}", rel[0].reason);
        // hub.md bị loại vì me.md link thẳng tới nó (đã hiện ở panel backlinks).
        assert!(!rel.iter().any(|r| r.path == "hub.md"), "got: {rel:?}");
        assert!(!rel.iter().any(|r| r.path == "stranger.md"), "got: {rel:?}");

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn duplicate_and_trash_dir() {
        let tmp = std::env::temp_dir().join(format!("brain-dup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "sub/ghi chú.md", "# Ghi chú\nNội dung.\n");

        let mut v = Vault::open(&tmp).unwrap();
        v.index().unwrap();

        // Nhân bản hai lần → " 1" rồi " 2", không đè lên nhau.
        assert_eq!(v.duplicate_note("sub/ghi chú.md").unwrap(), "sub/ghi chú 1.md");
        assert_eq!(v.duplicate_note("sub/ghi chú.md").unwrap(), "sub/ghi chú 2.md");
        assert_eq!(
            std::fs::read_to_string(tmp.join("sub/ghi chú 1.md")).unwrap(),
            "# Ghi chú\nNội dung.\n"
        );
        assert_eq!(v.db.note_list().unwrap().len(), 3);

        // Xóa folder → cả 3 note biến khỏi index, file nằm trong .brain/trash.
        v.trash_dir("sub").unwrap();
        assert!(!tmp.join("sub").exists());
        assert_eq!(v.db.note_list().unwrap().len(), 0);
        let trashed: Vec<_> = std::fs::read_dir(tmp.join(".brain/trash")).unwrap().collect();
        assert_eq!(trashed.len(), 1);

        // Không cho xóa gốc vault.
        assert!(v.trash_dir("").is_err());

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fts_search_finds_content() {
        let tmp = std::env::temp_dir().join(format!("brain-fts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "n.md", "# Runtime\nWe chose the tokio runtime for async IO.\n");

        let mut v = Vault::open(&tmp).unwrap();
        v.index().unwrap();
        let hits = v.db.search("tokio", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "n.md");

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn search_notes_gop_cac_chunk_cung_note() {
        let tmp = std::env::temp_dir().join(format!("brain-dedup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Mỗi heading là một chunk → note này khớp "tokio" ở ba chỗ.
        write(
            &tmp,
            "nhieu.md",
            "# Ghi chú\n## Một\nChỗ này nhắc tokio.\n## Hai\nCũng tokio.\n## Ba\nLại tokio.\n",
        );
        write(&tmp, "it.md", "# Khác\nMột lần tokio thôi.\n");

        let mut v = Vault::open(&tmp).unwrap();
        v.index().unwrap();

        // Mức chunk (RAG) vẫn thấy hết.
        assert!(v.db.search("tokio", 10).unwrap().len() >= 4);

        // Mức note (ô tìm kiếm) thì mỗi note một dòng.
        let hits = v.db.search_notes("tokio", 10).unwrap();
        assert_eq!(hits.len(), 2);
        let mut paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["it.md", "nhieu.md"]);

        // limit đếm theo note, không phải theo chunk.
        assert_eq!(v.db.search_notes("tokio", 1).unwrap().len(), 1);

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
