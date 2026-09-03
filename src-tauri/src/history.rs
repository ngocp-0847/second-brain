//! Revision history cho note (kiểu File Recovery của Obsidian).
//!
//! Mô hình "shadow copy": `.brain/history.db` giữ bản nội dung cuối cùng app biết
//! của mỗi note. Khi nội dung trên đĩa khác shadow → bản shadow (tức bản TRƯỚC
//! thay đổi) được đẩy vào bảng revision. Nhờ vậy bắt được mọi nguồn thay đổi:
//! user gõ trong app, agent AI sửa file, hay tool ngoài — không cần biết ai ghi.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

/// Hai lần save trong app cách nhau dưới ngưỡng này thì gộp làm một revision
/// (giống snapshot interval của Obsidian) — thay đổi từ bên ngoài luôn force.
const SAVE_INTERVAL_SECS: i64 = 120;
/// Giữ tối đa từng này revision mỗi note, cũ nhất bị cắt.
const KEEP_PER_NOTE: i64 = 50;

pub struct History {
    conn: Connection,
}

#[derive(serde::Serialize)]
pub struct RevisionMeta {
    pub id: i64,
    pub ts: i64,
    pub chars: i64,
    /// Ai ghi ra bản này: NULL = bạn / tool ngoài không rõ, "claude" = Claude Code (qua hook).
    pub source: Option<String>,
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for n in names {
        if n? == col {
            return Ok(true);
        }
    }
    Ok(false)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl History {
    pub fn open(brain_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(brain_dir)?;
        let conn = Connection::open(brain_dir.join("history.db"))?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS shadow(
                path TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                ts INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS revision(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                ts INTEGER NOT NULL,
                content TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS revision_path ON revision(path, ts DESC);
            "#,
        )?;
        // Migration: cột `source` (ai ghi ra bản nội dung này — NULL = bạn/không rõ,
        // "claude" = hook Claude Code báo). DB cũ chưa có cột → thêm.
        for table in ["shadow", "revision"] {
            if !has_column(&conn, table, "source")? {
                conn.execute(&format!("ALTER TABLE {table} ADD COLUMN source TEXT"), [])?;
            }
        }
        Ok(Self { conn })
    }

    /// Ghi nhận nội dung hiện tại trên đĩa của `path`. Nếu khác bản shadow →
    /// bản shadow được lưu thành revision (`force` bỏ qua interval gộp).
    /// `source` = ai tạo ra nội dung mới này; bản cũ mang theo source của chính nó.
    pub fn track(
        &self,
        path: &str,
        disk_content: &str,
        force: bool,
        source: Option<&str>,
    ) -> Result<()> {
        let ts = now();
        let shadow: Option<(String, Option<String>)> = self
            .conn
            .query_row("SELECT content, source FROM shadow WHERE path = ?1", [path], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok();
        match shadow {
            Some((old, _)) if old == disk_content => {
                // Watcher thường thấy file trước hook của Claude: nội dung đã khớp,
                // chỉ còn thiếu nhãn nguồn → gắn bổ sung.
                if let Some(src) = source {
                    self.conn.execute(
                        "UPDATE shadow SET source = ?2 WHERE path = ?1",
                        params![path, src],
                    )?;
                }
                return Ok(());
            }
            Some((old, old_src)) => {
                let last_rev: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT MAX(ts) FROM revision WHERE path = ?1",
                        [path],
                        |r| r.get(0),
                    )
                    .ok()
                    .flatten();
                let due = force || last_rev.map_or(true, |t| ts - t >= SAVE_INTERVAL_SECS);
                if due {
                    self.conn.execute(
                        "INSERT INTO revision(path, ts, content, source) VALUES(?1, ?2, ?3, ?4)",
                        params![path, ts, old, old_src],
                    )?;
                    self.prune(path)?;
                }
            }
            None => {} // lần đầu thấy note — chỉ tạo shadow, chưa có gì để revision
        }
        self.conn.execute(
            "INSERT INTO shadow(path, content, ts, source) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET content = ?2, ts = ?3, source = ?4",
            params![path, disk_content, ts, source],
        )?;
        Ok(())
    }

    /// Note đổi path → mang shadow + revision theo để lịch sử không đứt.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.conn
            .execute("UPDATE OR REPLACE shadow SET path = ?2 WHERE path = ?1", [from, to])?;
        self.conn.execute("UPDATE revision SET path = ?2 WHERE path = ?1", [from, to])?;
        Ok(())
    }

    pub fn list(&self, path: &str) -> Result<Vec<RevisionMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts, LENGTH(content), source FROM revision WHERE path = ?1 ORDER BY ts DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([path], |r| {
                Ok(RevisionMeta { id: r.get(0)?, ts: r.get(1)?, chars: r.get(2)?, source: r.get(3)? })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get(&self, id: i64) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT content FROM revision WHERE id = ?1", [id], |r| r.get(0))?)
    }

    fn prune(&self, path: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM revision WHERE path = ?1 AND id NOT IN
             (SELECT id FROM revision WHERE path = ?1 ORDER BY ts DESC, id DESC LIMIT ?2)",
            params![path, KEEP_PER_NOTE],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "sb-history-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn revision_carries_author_of_that_version() {
        let h = History::open(&tmp()).unwrap();
        // Bạn ghi bản 1 → chỉ tạo shadow.
        h.track("a.md", "v1 by user", true, None).unwrap();
        assert!(h.list("a.md").unwrap().is_empty());
        // Claude ghi bản 2 → bản 1 (của bạn) vào revision, không nhãn.
        h.track("a.md", "v2 by claude", true, Some("claude")).unwrap();
        let revs = h.list("a.md").unwrap();
        assert_eq!(revs.len(), 1);
        assert_eq!(revs[0].source, None);
        assert_eq!(h.get(revs[0].id).unwrap(), "v1 by user");
        // Bạn ghi bản 3 → bản 2 vào revision, mang nhãn "claude".
        h.track("a.md", "v3 by user", true, None).unwrap();
        let revs = h.list("a.md").unwrap();
        assert_eq!(revs.len(), 2);
        assert_eq!(revs[0].source.as_deref(), Some("claude"));
        assert_eq!(h.get(revs[0].id).unwrap(), "v2 by claude");
    }

    #[test]
    fn late_hook_labels_shadow_without_new_revision() {
        // Watcher thấy file trước (không nhãn), hook Claude tới sau với nội dung y hệt.
        let h = History::open(&tmp()).unwrap();
        h.track("b.md", "old", true, None).unwrap();
        h.track("b.md", "new by claude", true, None).unwrap();
        h.track("b.md", "new by claude", true, Some("claude")).unwrap();
        assert_eq!(h.list("b.md").unwrap().len(), 1, "nội dung khớp → không thêm revision");
        h.track("b.md", "newer", true, None).unwrap();
        let revs = h.list("b.md").unwrap();
        assert_eq!(revs[0].source.as_deref(), Some("claude"));
    }

    #[test]
    fn opens_legacy_db_without_source_column() {
        let dir = tmp();
        {
            let conn = Connection::open(dir.join("history.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE shadow(path TEXT PRIMARY KEY, content TEXT NOT NULL, ts INTEGER NOT NULL);
                 CREATE TABLE revision(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
                                       ts INTEGER NOT NULL, content TEXT NOT NULL);
                 INSERT INTO shadow VALUES('c.md', 'x', 1);
                 INSERT INTO revision(path, ts, content) VALUES('c.md', 1, 'w');",
            )
            .unwrap();
        }
        let h = History::open(&dir).unwrap();
        let revs = h.list("c.md").unwrap();
        assert_eq!(revs.len(), 1);
        assert_eq!(revs[0].source, None);
        h.track("c.md", "y", true, Some("claude")).unwrap();
        assert_eq!(h.list("c.md").unwrap().len(), 2);
    }
}
