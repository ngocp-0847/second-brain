//! Cache SQLite trong `.brain/cache.db`. Toàn bộ dữ liệu tái tạo được từ file .md.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;

/// Bump khi đổi schema: cache là dữ liệu tái tạo được nên chỉ cần drop & rebuild.
const SCHEMA_VERSION: i64 = 3;

pub struct Db {
    pub conn: Connection,
    pub fts_enabled: bool,
}

#[derive(Debug)]
pub struct NoteRow {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub size: i64,
    pub content_hash: Vec<u8>,
}

#[derive(Debug)]
pub struct BacklinkRow {
    pub src_path: String,
    pub src_title: String,
    pub kind: String,
    pub offset: i64,
}

#[derive(Debug)]
pub struct BrokenLinkRow {
    pub src_path: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug)]
pub struct RelatedRow {
    pub path: String,
    pub title: String,
    /// Vì sao note này được coi là liên quan ("2 tag chung · trùng từ khóa").
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub path: String,
    pub title: String,
    pub heading_path: String,
    pub start_line: i64,
    pub snippet: String,
}

impl Db {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = connect(db_path)?;

        // Schema cũ/hỏng → xóa cả file làm lại (cache tái tạo được từ .md).
        // Xóa cả file thay vì DROP từng bảng: file cũ có thể còn bảng của phiên
        // bản trước (ví dụ virtual table `chunk_vec` của sqlite-vec đã bỏ) mà
        // connection này không nạp module tương ứng nên không DROP nổi.
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let schema_ok = conn.prepare("SELECT text_hash FROM chunk LIMIT 0").is_ok();
        let has_tables = conn.prepare("SELECT id FROM note LIMIT 0").is_ok();
        if has_tables && (version != SCHEMA_VERSION || !schema_ok) {
            drop(conn);
            for suffix in ["", "-wal", "-shm"] {
                let mut p = db_path.as_os_str().to_owned();
                p.push(suffix);
                let _ = std::fs::remove_file(std::path::PathBuf::from(p));
            }
            conn = connect(db_path)?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS note (
              id INTEGER PRIMARY KEY,
              path TEXT UNIQUE NOT NULL,
              title TEXT NOT NULL,
              frontmatter TEXT,
              mtime INTEGER NOT NULL,
              size INTEGER NOT NULL,
              content_hash BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS link (
              id INTEGER PRIMARY KEY,
              src_note INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
              target_path TEXT NOT NULL,
              target_note INTEGER,
              kind TEXT NOT NULL,
              heading TEXT,
              block TEXT,
              src_offset INTEGER NOT NULL,
              src_len INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_link_src ON link(src_note);
            CREATE INDEX IF NOT EXISTS idx_link_target ON link(target_note);
            CREATE TABLE IF NOT EXISTS tag (
              note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
              tag TEXT NOT NULL,
              PRIMARY KEY (note_id, tag)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS chunk (
              id INTEGER PRIMARY KEY,
              note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
              heading_path TEXT NOT NULL,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              text TEXT NOT NULL,
              text_hash BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunk_note ON chunk(note_id);
            "#,
        )?;

        // FTS5 có trong SQLite bundled; fallback LIKE nếu build thiếu.
        let fts_enabled = conn
            .execute_batch(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
                  text, content='chunk', content_rowid='id', tokenize='unicode61'
                );
                CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
                  INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
                END;
                CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
                  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
                END;
                "#,
            )
            .is_ok();

        Ok(Db { conn, fts_enabled })
    }

    pub fn all_notes(&self) -> Result<Vec<NoteRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, path, title, mtime, size, content_hash FROM note")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NoteRow {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    title: r.get(2)?,
                    mtime: r.get(3)?,
                    size: r.get(4)?,
                    content_hash: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Ghi (insert/update) một note đã parse cùng links/tags/chunks, trong 1 transaction.
    pub fn upsert_note(
        &mut self,
        path: &str,
        parsed: &crate::parser::ParsedNote,
        mtime: i64,
        size: i64,
        hash: &[u8],
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            r#"INSERT INTO note (path, title, frontmatter, mtime, size, content_hash)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(path) DO UPDATE SET
                 title=excluded.title, frontmatter=excluded.frontmatter,
                 mtime=excluded.mtime, size=excluded.size, content_hash=excluded.content_hash"#,
            params![
                path,
                parsed.title,
                parsed.frontmatter.as_ref().map(|f| f.to_string()),
                mtime,
                size,
                hash
            ],
        )?;
        let id: i64 =
            tx.query_row("SELECT id FROM note WHERE path = ?1", [path], |r| r.get(0))?;

        tx.execute("DELETE FROM link WHERE src_note = ?1", [id])?;
        tx.execute("DELETE FROM tag WHERE note_id = ?1", [id])?;
        tx.execute("DELETE FROM chunk WHERE note_id = ?1", [id])?;

        {
            let mut ins_link = tx.prepare_cached(
                r#"INSERT INTO link (src_note, target_path, kind, heading, block, src_offset, src_len)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            )?;
            for l in &parsed.links {
                ins_link.execute(params![
                    id,
                    l.target,
                    l.kind.as_str(),
                    l.heading,
                    l.block,
                    l.offset as i64,
                    l.len as i64
                ])?;
            }
            let mut ins_tag =
                tx.prepare_cached("INSERT OR IGNORE INTO tag (note_id, tag) VALUES (?1, ?2)")?;
            for t in &parsed.tags {
                ins_tag.execute(params![id, t])?;
            }
            let mut ins_chunk = tx.prepare_cached(
                r#"INSERT INTO chunk (note_id, heading_path, start_line, end_line, text, text_hash)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            )?;
            for c in &parsed.chunks {
                ins_chunk.execute(params![
                    id,
                    c.heading_path,
                    c.start_line as i64,
                    c.end_line as i64,
                    c.text,
                    blake3::hash(c.text.as_bytes()).as_bytes().as_slice()
                ])?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn remove_notes(&mut self, paths: &[String]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut n = 0;
        {
            let mut del = tx.prepare_cached("DELETE FROM note WHERE path = ?1")?;
            for p in paths {
                n += del.execute([p])?;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    /// Resolve toàn bộ wikilink theo kiểu Obsidian:
    /// khớp đường dẫn tương đối trước, sau đó khớp theo tên file (stem) không phân biệt hoa thường.
    pub fn resolve_links(&mut self) -> Result<()> {
        use std::collections::HashMap;
        let notes = self.all_notes()?;
        let mut by_path: HashMap<String, i64> = HashMap::new();
        let mut by_stem: HashMap<String, Vec<i64>> = HashMap::new();
        for n in &notes {
            let lower = n.path.to_lowercase();
            by_path.insert(lower.clone(), n.id);
            by_path.insert(lower.trim_end_matches(".md").to_string(), n.id);
            let stem = Path::new(&n.path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            by_stem.entry(stem).or_default().push(n.id);
        }

        let links: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare("SELECT id, target_path FROM link")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        let tx = self.conn.transaction()?;
        {
            let mut upd = tx.prepare_cached("UPDATE link SET target_note = ?1 WHERE id = ?2")?;
            for (link_id, target) in links {
                let key = target.replace('\\', "/").to_lowercase();
                let key = key.trim_start_matches("./").trim_end_matches('/');
                let resolved = by_path
                    .get(key)
                    .copied()
                    .or_else(|| by_path.get(key.trim_end_matches(".md")).copied())
                    .or_else(|| {
                        let stem = key.rsplit('/').next().unwrap_or(key);
                        let stem = stem.trim_end_matches(".md");
                        match by_stem.get(stem).map(Vec::as_slice) {
                            Some([single]) => Some(*single),
                            Some(multi) if !multi.is_empty() => Some(multi[0]),
                            _ => None,
                        }
                    });
                upd.execute(params![resolved, link_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn backlinks(&self, note_ref: &str) -> Result<Vec<BacklinkRow>> {
        let mut stmt = self.conn.prepare(
            r#"SELECT s.path, s.title, l.kind, l.src_offset
               FROM link l
               JOIN note s ON s.id = l.src_note
               JOIN note t ON t.id = l.target_note
               WHERE t.path = ?1 COLLATE NOCASE
                  OR t.title = ?1 COLLATE NOCASE
                  OR t.path = ?1 || '.md' COLLATE NOCASE
               ORDER BY s.path"#,
        )?;
        let rows = stmt
            .query_map([note_ref], |r| {
                Ok(BacklinkRow {
                    src_path: r.get(0)?,
                    src_title: r.get(1)?,
                    kind: r.get(2)?,
                    offset: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn broken_links(&self) -> Result<Vec<BrokenLinkRow>> {
        let mut stmt = self.conn.prepare(
            r#"SELECT s.path, l.target_path, l.kind
               FROM link l JOIN note s ON s.id = l.src_note
               WHERE l.target_note IS NULL
                 AND l.kind IN ('wiki', 'md')
               ORDER BY s.path"#,
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(BrokenLinkRow { src_path: r.get(0)?, target: r.get(1)?, kind: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Note không có link đến (backlink) và cũng không link đi đâu (đã resolve).
    pub fn orphans(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            r#"SELECT path, title FROM note n
               WHERE NOT EXISTS (SELECT 1 FROM link WHERE target_note = n.id)
                 AND NOT EXISTS (SELECT 1 FROM link WHERE src_note = n.id AND target_note IS NOT NULL)
               ORDER BY path"#,
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        if self.fts_enabled {
            let mut stmt = self.conn.prepare(
                r#"SELECT c.id, n.path, n.title, c.heading_path, c.start_line,
                          snippet(chunk_fts, 0, '»', '«', ' … ', 12)
                   FROM chunk_fts
                   JOIN chunk c ON c.id = chunk_fts.rowid
                   JOIN note n ON n.id = c.note_id
                   WHERE chunk_fts MATCH ?1
                   ORDER BY rank LIMIT ?2"#,
            )?;
            let q = sanitize_fts_query(query);
            let rows = stmt
                .query_map(params![q, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let mut stmt = self.conn.prepare(
                r#"SELECT c.id, n.path, n.title, c.heading_path, c.start_line,
                          substr(c.text, 1, 160)
                   FROM chunk c JOIN note n ON n.id = c.note_id
                   WHERE c.text LIKE '%' || ?1 || '%'
                   LIMIT ?2"#,
            )?;
            let rows = stmt
                .query_map(params![query, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    }

    /// Note liên quan với `note_path` — thuần SQL, không cần model.
    ///
    /// Cộng điểm từ ba tín hiệu của chính graph vault: tag chung, cùng link tới
    /// một note (co-citation), cùng được một note nhắc tới. Thêm nhánh dự phòng
    /// khớp từ khóa trong tiêu đề để note chưa có tag/link vẫn ra kết quả.
    /// Note đã link trực tiếp bị loại — chúng đã hiện ở panel backlinks.
    pub fn related_notes(&self, note_path: &str, limit: usize) -> Result<Vec<RelatedRow>> {
        use std::collections::{HashMap, HashSet};

        let Some(id) = self.note_id(note_path)? else {
            return Ok(Vec::new());
        };
        // note_id → (điểm, các mảnh lý do)
        let mut acc: HashMap<i64, (f64, Vec<String>)> = HashMap::new();

        // 1. Tag chung — tín hiệu do người dùng tự gắn nên đáng tin nhất.
        {
            let mut stmt = self.conn.prepare(
                r#"SELECT t2.note_id, COUNT(*) FROM tag t1
                   JOIN tag t2 ON t2.tag = t1.tag AND t2.note_id != t1.note_id
                   WHERE t1.note_id = ?1 GROUP BY t2.note_id"#,
            )?;
            for row in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
                let (nid, n) = row?;
                let e = acc.entry(nid).or_default();
                e.0 += 2.0 * n as f64;
                e.1.push(format!("{n} tag chung"));
            }
        }

        // 2. Cùng link tới một note.
        {
            let mut stmt = self.conn.prepare(
                r#"SELECT l2.src_note, COUNT(DISTINCT l1.target_note) FROM link l1
                   JOIN link l2 ON l2.target_note = l1.target_note AND l2.src_note != ?1
                   WHERE l1.src_note = ?1 AND l1.target_note IS NOT NULL
                   GROUP BY l2.src_note"#,
            )?;
            for row in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
                let (nid, n) = row?;
                let e = acc.entry(nid).or_default();
                e.0 += 1.5 * n as f64;
                e.1.push(format!("cùng link tới {n} note"));
            }
        }

        // 3. Cùng được một note nhắc tới.
        {
            let mut stmt = self.conn.prepare(
                r#"SELECT l2.target_note, COUNT(DISTINCT l1.src_note) FROM link l1
                   JOIN link l2 ON l2.src_note = l1.src_note AND l2.target_note != ?1
                   WHERE l1.target_note = ?1 AND l2.target_note IS NOT NULL
                   GROUP BY l2.target_note"#,
            )?;
            for row in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
                let (nid, n) = row?;
                let e = acc.entry(nid).or_default();
                e.0 += 1.0 * n as f64;
                e.1.push(format!("cùng được {n} note nhắc tới"));
            }
        }

        // 4. Dự phòng: note nào chứa từ trong tiêu đề (OR, không phải AND như search).
        if self.fts_enabled {
            let title: String =
                self.conn.query_row("SELECT title FROM note WHERE id = ?1", [id], |r| r.get(0))?;
            let terms: Vec<String> = title
                .split_whitespace()
                .filter(|t| t.chars().count() >= 2)
                .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
                .collect();
            if !terms.is_empty() {
                let mut stmt = self.conn.prepare(
                    r#"SELECT c.note_id FROM chunk_fts
                       JOIN chunk c ON c.id = chunk_fts.rowid
                       WHERE chunk_fts MATCH ?1 AND c.note_id != ?2
                       ORDER BY rank LIMIT 40"#,
                )?;
                let rows = stmt
                    .query_map(params![terms.join(" OR "), id], |r| r.get::<_, i64>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut seen = HashSet::new();
                for (rank, nid) in rows.into_iter().enumerate() {
                    if !seen.insert(nid) {
                        continue;
                    }
                    let e = acc.entry(nid).or_default();
                    e.0 += 1.0 / (10.0 + rank as f64);
                    e.1.push("trùng từ khóa".into());
                }
            }
        }

        // Note đã link trực tiếp (cả hai chiều) → panel backlinks lo rồi.
        let linked: HashSet<i64> = {
            let mut stmt = self.conn.prepare(
                r#"SELECT target_note FROM link WHERE src_note = ?1 AND target_note IS NOT NULL
                   UNION
                   SELECT src_note FROM link WHERE target_note = ?1"#,
            )?;
            let ids = stmt
                .query_map([id], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            ids
        };

        let mut ranked: Vec<(i64, f64, Vec<String>)> = acc
            .into_iter()
            .filter(|(nid, _)| *nid != id && !linked.contains(nid))
            .map(|(nid, (score, reason))| (nid, score, reason))
            .collect();
        // id làm tiebreak để thứ tự ổn định giữa các lần gọi.
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.truncate(limit);

        let mut stmt = self.conn.prepare("SELECT path, title FROM note WHERE id = ?1")?;
        let mut out = Vec::with_capacity(ranked.len());
        for (nid, _, reason) in ranked {
            if let Ok((path, title)) =
                stmt.query_row([nid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                out.push(RelatedRow { path, title, reason: reason.join(" · ") });
            }
        }
        Ok(out)
    }

    /// Chỗ nhắc tới tên note dưới dạng text thuần (chưa link hóa):
    /// tìm cụm từ = tên file của note trong các note chưa link tới nó.
    pub fn unlinked_mentions(&self, note_path: &str, limit: usize) -> Result<Vec<SearchHit>> {
        if !self.fts_enabled {
            return Ok(Vec::new());
        }
        let Some(target_id) = self.note_id(note_path)? else {
            return Ok(Vec::new());
        };
        let stem = Path::new(note_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(note_path);
        let phrase = format!("\"{}\"", stem.replace('"', "\"\""));
        let mut stmt = self.conn.prepare(
            r#"SELECT c.id, n.path, n.title, c.heading_path, c.start_line,
                      snippet(chunk_fts, 0, '»', '«', ' … ', 12)
               FROM chunk_fts
               JOIN chunk c ON c.id = chunk_fts.rowid
               JOIN note n ON n.id = c.note_id
               WHERE chunk_fts MATCH ?1
                 AND n.id != ?2
                 AND n.id NOT IN (SELECT src_note FROM link WHERE target_note = ?2)
               ORDER BY rank LIMIT ?3"#,
        )?;
        let rows = stmt
            .query_map(params![phrase, target_id, limit as i64], row_to_hit)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Chunk đầy đủ text (phục vụ RAG). Trả về (path, heading_path, start_line, text).
    pub fn full_chunks(&self, ids: &[i64]) -> Result<Vec<(String, String, i64, String)>> {
        let mut out = Vec::with_capacity(ids.len());
        let mut stmt = self.conn.prepare_cached(
            r#"SELECT n.path, c.heading_path, c.start_line, c.text
               FROM chunk c JOIN note n ON n.id = c.note_id WHERE c.id = ?1"#,
        )?;
        for id in ids {
            if let Ok(row) =
                stmt.query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// (path, title, mtime) — mtime để UI sắp theo "sửa gần đây".
    pub fn note_list(&self) -> Result<Vec<(String, String, i64)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, title, mtime FROM note ORDER BY path")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Resolve một target wikilink ("Note Title", "folder/note") → path trong vault.
    pub fn resolve_target(&self, target: &str) -> Result<Option<String>> {
        let key = target.replace('\\', "/").to_lowercase();
        let key = key.trim_start_matches("./").trim_end_matches('/').to_string();
        let by_path: Option<String> = self
            .conn
            .query_row(
                "SELECT path FROM note WHERE LOWER(path) = ?1 OR LOWER(path) = ?1 || '.md' LIMIT 1",
                [&key],
                |r| r.get(0),
            )
            .ok();
        if by_path.is_some() {
            return Ok(by_path);
        }
        let stem = key.rsplit('/').next().unwrap_or(&key).trim_end_matches(".md").to_string();
        let by_stem: Option<String> = self
            .conn
            .query_row(
                r#"SELECT path FROM note
                   WHERE LOWER(path) = ?1 || '.md' OR LOWER(path) LIKE '%/' || ?1 || '.md'
                   ORDER BY LENGTH(path) LIMIT 1"#,
                [&stem],
                |r| r.get(0),
            )
            .ok();
        Ok(by_stem)
    }

    /// Mọi link (đã resolve) trỏ tới note này, kèm offset để rewrite.
    pub fn incoming_links(&self, note_id: i64) -> Result<Vec<(String, i64, i64, String)>> {
        let mut stmt = self.conn.prepare(
            r#"SELECT s.path, l.src_offset, l.src_len, l.kind
               FROM link l JOIN note s ON s.id = l.src_note
               WHERE l.target_note = ?1
               ORDER BY s.path, l.src_offset DESC"#,
        )?;
        let rows = stmt
            .query_map([note_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn note_id(&self, path: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT id FROM note WHERE path = ?1", [path], |r| r.get(0))
            .ok())
    }

    pub fn stats(&self) -> Result<(i64, i64, i64, i64, i64)> {
        let notes: i64 = self.conn.query_row("SELECT COUNT(*) FROM note", [], |r| r.get(0))?;
        let links: i64 = self.conn.query_row("SELECT COUNT(*) FROM link", [], |r| r.get(0))?;
        let broken: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM link WHERE target_note IS NULL AND kind IN ('wiki','md')",
            [],
            |r| r.get(0),
        )?;
        let tags: i64 =
            self.conn.query_row("SELECT COUNT(DISTINCT tag) FROM tag", [], |r| r.get(0))?;
        let chunks: i64 = self.conn.query_row("SELECT COUNT(*) FROM chunk", [], |r| r.get(0))?;
        Ok((notes, links, broken, tags, chunks))
    }
}

fn connect(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("mở db {}", db_path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

fn row_to_hit(r: &rusqlite::Row<'_>) -> rusqlite::Result<SearchHit> {
    Ok(SearchHit {
        chunk_id: r.get(0)?,
        path: r.get(1)?,
        title: r.get(2)?,
        heading_path: r.get(3)?,
        start_line: r.get(4)?,
        snippet: r.get(5)?,
    })
}

/// Bọc mỗi term trong nháy kép để tránh lỗi cú pháp FTS5 với input tự do.
fn sanitize_fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}
