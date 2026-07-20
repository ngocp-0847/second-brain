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
        Ok(Self { conn })
    }

    /// Ghi nhận nội dung hiện tại trên đĩa của `path`. Nếu khác bản shadow →
    /// bản shadow được lưu thành revision (`force` bỏ qua interval gộp).
    pub fn track(&self, path: &str, disk_content: &str, force: bool) -> Result<()> {
        let ts = now();
        let shadow: Option<String> = self
            .conn
            .query_row("SELECT content FROM shadow WHERE path = ?1", [path], |r| r.get(0))
            .ok();
        match shadow {
            Some(old) if old == disk_content => return Ok(()),
            Some(old) => {
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
                        "INSERT INTO revision(path, ts, content) VALUES(?1, ?2, ?3)",
                        params![path, ts, old],
                    )?;
                    self.prune(path)?;
                }
            }
            None => {} // lần đầu thấy note — chỉ tạo shadow, chưa có gì để revision
        }
        self.conn.execute(
            "INSERT INTO shadow(path, content, ts) VALUES(?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET content = ?2, ts = ?3",
            params![path, disk_content, ts],
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
            "SELECT id, ts, LENGTH(content) FROM revision WHERE path = ?1 ORDER BY ts DESC",
        )?;
        let rows = stmt
            .query_map([path], |r| {
                Ok(RevisionMeta { id: r.get(0)?, ts: r.get(1)?, chars: r.get(2)? })
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
             (SELECT id FROM revision WHERE path = ?1 ORDER BY ts DESC LIMIT ?2)",
            params![path, KEEP_PER_NOTE],
        )?;
        Ok(())
    }
}
