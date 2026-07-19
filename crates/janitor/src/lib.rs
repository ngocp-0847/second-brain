//! Janitor tầng 1: lint deterministic + git snapshot + report.
//!
//! Nguyên tắc an toàn (DESIGN.md §8): snapshot trước khi chạy; mức tự trị theo rule
//! (`auto` chỉ dành cho sửa chữa không phá hủy và chắc chắn tuyệt đối, `propose`
//! chờ user duyệt trong report, `suggest` chỉ hiển thị); không bao giờ xóa thật —
//! chỉ chuyển vào .brain/trash.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use vault_core::Vault;

/// File nhỏ hơn ngưỡng này (byte) và không được sửa 30 ngày → đề xuất dọn.
const STUB_MAX_BYTES: i64 = 60;
const STUB_MIN_AGE_SECS: i64 = 30 * 24 * 3600;
/// Note lớn hơn ngưỡng này (byte) → gợi ý tách.
const HUGE_NOTE_BYTES: i64 = 100_000;
/// File sửa trong vòng 24h thì janitor không đụng vào (design §8.1.5).
const RECENT_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Apply {
    /// Sửa mọi link gãy `bad_target` → note `new_target` (đang tồn tại).
    FixLink { bad_target: String, new_target: String },
    /// Chuyển note vào .brain/trash.
    TrashNote { path: String },
    /// Chỉ thông tin, không có hành động.
    None,
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct ActionRow {
    pub id: i64,
    pub rule: String,
    pub severity: String, // auto | propose | suggest
    pub description: String,
    pub status: String, // applied | pending | dismissed | info
    #[serde(skip)]
    pub payload: Apply,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub run_id: i64,
    pub ts: i64,
    pub snapshotted: bool,
    pub applied: Vec<ActionRow>,
    pub proposals: Vec<ActionRow>,
    pub suggestions: Vec<ActionRow>,
}

pub fn ensure_schema(vault: &Vault) -> Result<()> {
    vault.db.conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS janitor_run (
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          snapshotted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS janitor_action (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES janitor_run(id) ON DELETE CASCADE,
          rule TEXT NOT NULL,
          severity TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

// ---------- git snapshot ----------

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let git_dir = root.join(".brain").join("snapshots");
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(&git_dir)
        .arg("--work-tree")
        .arg(root)
        .args(args)
        .output()
        .context("chạy git")?;
    Ok(out)
}

/// Commit toàn vault vào repo ẩn `.brain/snapshots`. Trả về false nếu không có git.
pub fn snapshot(root: &Path, label: &str) -> Result<bool> {
    if Command::new("git").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
        return Ok(false);
    }
    let git_dir = root.join(".brain").join("snapshots");
    if !git_dir.join("HEAD").exists() {
        std::fs::create_dir_all(&git_dir)?;
        git(root, &["init", "--quiet"])?;
        git(root, &["config", "user.email", "janitor@second-brain.local"])?;
        git(root, &["config", "user.name", "Second Brain Janitor"])?;
        // Không snapshot chính .brain (cache, trash, model…).
        std::fs::write(git_dir.join("info").join("exclude"), ".brain/\n")?;
    }
    git(root, &["add", "-A"])?;
    let msg = format!("janitor: {label}");
    let out = git(root, &["commit", "--quiet", "-m", &msg])?;
    // "nothing to commit" cũng tính là thành công (đã có snapshot y hệt).
    Ok(out.status.success() || String::from_utf8_lossy(&out.stdout).contains("nothing to commit")
        || String::from_utf8_lossy(&out.stderr).contains("nothing to commit"))
}

// ---------- lint rules ----------

struct Finding {
    rule: &'static str,
    severity: &'static str,
    description: String,
    payload: Apply,
}

fn lint(vault: &Vault, now: i64) -> Result<Vec<Finding>> {
    let mut out = Vec::new();
    let notes = vault.db.note_list()?;

    // Map stem (thường hóa) → path để fuzzy-fix link gãy.
    let mut stems: Vec<(String, String)> = notes
        .iter()
        .map(|(p, _)| {
            let stem = Path::new(p)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(p)
                .to_string();
            (stem, p.clone())
        })
        .collect();
    stems.sort();

    // Note sửa gần đây → không đụng (đọc mtime từ db).
    let recent: std::collections::HashSet<String> = {
        let mut stmt = vault
            .db
            .conn
            .prepare("SELECT path FROM note WHERE mtime > ?1")?;
        let rows = stmt
            .query_map([now - RECENT_SECS], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().collect()
    };

    // 1. Broken links → auto (khớp chính xác không phân biệt hoa thường, duy nhất)
    //    hoặc propose (fuzzy khoảng cách ≤ 2, duy nhất), còn lại suggest.
    let mut seen_targets = std::collections::HashSet::new();
    for b in vault.db.broken_links()? {
        if !seen_targets.insert(b.target.clone()) {
            continue; // mỗi target gãy chỉ một action, FixLink sửa mọi occurrence
        }
        // Resolver vốn đã khớp không phân biệt hoa thường, nên link gãy thật sự
        // luôn cần fuzzy match → mức propose (chờ duyệt), không bao giờ auto.
        let bad_stem = b.target.rsplit('/').next().unwrap_or(&b.target).trim_end_matches(".md");
        let fuzzy_matches: Vec<&(String, String)> = stems
            .iter()
            .filter(|(s, _)| levenshtein(&s.to_lowercase(), &bad_stem.to_lowercase()) <= 2)
            .collect();
        match fuzzy_matches.as_slice() {
            [(stem, path)] => out.push(Finding {
                rule: "broken-link",
                severity: "propose",
                description: format!("[[{}]] gãy → có thể là [[{stem}]] ({path})", b.target),
                payload: Apply::FixLink { bad_target: b.target, new_target: path.clone() },
            }),
            _ => out.push(Finding {
                rule: "broken-link",
                severity: "suggest",
                description: format!("[[{}]] gãy trong {} — không tìm được đích phù hợp", b.target, b.src_path),
                payload: Apply::None,
            }),
        }
    }

    // 2. Orphan notes.
    for (path, title) in vault.db.orphans()? {
        out.push(Finding {
            rule: "orphan",
            severity: "suggest",
            description: format!("\"{title}\" ({path}) mồ côi — chưa có link vào/ra"),
            payload: Apply::None,
        });
    }

    // 3. Stub notes cũ → propose chuyển trash.
    {
        let mut stmt = vault.db.conn.prepare(
            "SELECT path, title FROM note WHERE size < ?1 AND mtime < ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![STUB_MAX_BYTES, now - STUB_MIN_AGE_SECS], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (path, title) in rows {
            if recent.contains(&path) {
                continue;
            }
            out.push(Finding {
                rule: "stale-stub",
                severity: "propose",
                description: format!("\"{title}\" ({path}) gần như rỗng và không sửa >30 ngày → chuyển thùng rác"),
                payload: Apply::TrashNote { path },
            });
        }
    }

    // 4. Tag trùng khác hoa thường.
    {
        let mut stmt = vault.db.conn.prepare(
            r#"SELECT GROUP_CONCAT(DISTINCT tag) FROM tag
               GROUP BY LOWER(tag) HAVING COUNT(DISTINCT tag) > 1"#,
        )?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for group in rows {
            out.push(Finding {
                rule: "tag-case",
                severity: "suggest",
                description: format!("Tag trùng khác hoa thường: {group} — nên hợp nhất"),
                payload: Apply::None,
            });
        }
    }

    // 5. Note quá lớn → gợi ý tách.
    {
        let mut stmt = vault
            .db
            .conn
            .prepare("SELECT path, size FROM note WHERE size > ?1")?;
        let rows = stmt
            .query_map([HUGE_NOTE_BYTES], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (path, size) in rows {
            out.push(Finding {
                rule: "huge-note",
                severity: "suggest",
                description: format!("{path} nặng {}KB — cân nhắc tách theo heading", size / 1024),
                payload: Apply::None,
            });
        }
    }

    Ok(out)
}

// ---------- run / report / apply ----------

pub fn run(vault: &mut Vault) -> Result<Report> {
    ensure_schema(vault)?;
    vault.index()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let snapshotted = snapshot(&vault.root, "trước khi lint").unwrap_or(false);
    let findings = lint(vault, now)?;

    vault.db.conn.execute(
        "INSERT INTO janitor_run (ts, snapshotted) VALUES (?1, ?2)",
        rusqlite::params![now, snapshotted as i64],
    )?;
    let run_id = vault.db.conn.last_insert_rowid();

    let mut applied = Vec::new();
    let mut proposals = Vec::new();
    let mut suggestions = Vec::new();

    for f in findings {
        // `auto` chỉ chạy khi có snapshot để rollback — không snapshot được thì hạ xuống propose.
        let severity = if f.severity == "auto" && !snapshotted { "propose" } else { f.severity };
        let mut status = match severity {
            "auto" => "applied",
            "propose" => "pending",
            _ => "info",
        };
        let mut description = f.description.clone();

        if severity == "auto" {
            match execute(vault, &f.payload) {
                Ok(msg) => description = format!("{description} — {msg}"),
                Err(e) => {
                    status = "pending";
                    description = format!("{description} — auto thất bại ({e}), chờ duyệt");
                }
            }
        }

        vault.db.conn.execute(
            r#"INSERT INTO janitor_action (run_id, rule, severity, description, status, payload)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            rusqlite::params![
                run_id,
                f.rule,
                severity,
                description,
                status,
                serde_json::to_string(&f.payload)?
            ],
        )?;
        let row = ActionRow {
            id: vault.db.conn.last_insert_rowid(),
            rule: f.rule.into(),
            severity: severity.into(),
            description,
            status: status.into(),
            payload: f.payload,
        };
        match status {
            "applied" => applied.push(row),
            "pending" => proposals.push(row),
            _ => suggestions.push(row),
        }
    }

    if !applied.is_empty() {
        let _ = snapshot(&vault.root, "sau auto-fix");
    }

    Ok(Report { run_id, ts: now, snapshotted, applied, proposals, suggestions })
}

fn execute(vault: &mut Vault, apply: &Apply) -> Result<String> {
    match apply {
        Apply::FixLink { bad_target, new_target } => {
            let n = vault.fix_link_target(bad_target, new_target)?;
            Ok(format!("đã sửa {n} link"))
        }
        Apply::TrashNote { path } => {
            vault.trash_note(path)?;
            Ok("đã chuyển vào .brain/trash".into())
        }
        Apply::None => Ok("không có hành động".into()),
    }
}

/// Duyệt một đề xuất đang pending.
pub fn apply_action(vault: &mut Vault, action_id: i64) -> Result<String> {
    let (payload, status): (String, String) = vault.db.conn.query_row(
        "SELECT payload, status FROM janitor_action WHERE id = ?1",
        [action_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if status != "pending" {
        anyhow::bail!("action không ở trạng thái chờ duyệt");
    }
    let apply: Apply = serde_json::from_str(&payload)?;
    let _ = snapshot(&vault.root, &format!("trước khi áp dụng action {action_id}"));
    let msg = execute(vault, &apply)?;
    vault.db.conn.execute(
        "UPDATE janitor_action SET status = 'applied' WHERE id = ?1",
        [action_id],
    )?;
    Ok(msg)
}

pub fn dismiss_action(vault: &Vault, action_id: i64) -> Result<()> {
    vault.db.conn.execute(
        "UPDATE janitor_action SET status = 'dismissed' WHERE id = ?1 AND status = 'pending'",
        [action_id],
    )?;
    Ok(())
}

/// Report của lần chạy gần nhất (kèm mọi proposal còn pending từ các lần trước).
pub fn latest_report(vault: &Vault) -> Result<Option<Report>> {
    ensure_schema(vault)?;
    let run: Option<(i64, i64, i64)> = vault
        .db
        .conn
        .query_row(
            "SELECT id, ts, snapshotted FROM janitor_run ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let Some((run_id, ts, snapshotted)) = run else { return Ok(None) };

    let mut stmt = vault.db.conn.prepare(
        r#"SELECT id, rule, severity, description, status, payload FROM janitor_action
           WHERE run_id = ?1 OR status = 'pending' ORDER BY id"#,
    )?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut applied = Vec::new();
    let mut proposals = Vec::new();
    let mut suggestions = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (id, rule, severity, description, status, payload) in rows {
        if !seen.insert(id) {
            continue;
        }
        let row = ActionRow {
            id,
            rule,
            severity,
            description,
            status: status.clone(),
            payload: serde_json::from_str(&payload).unwrap_or(Apply::None),
        };
        match status.as_str() {
            "applied" => applied.push(row),
            "pending" => proposals.push(row),
            "info" => suggestions.push(row),
            _ => {}
        }
    }
    Ok(Some(Report { run_id, ts, snapshotted: snapshotted != 0, applied, proposals, suggestions }))
}

/// Lần chạy gần nhất cách đây bao lâu (giây); None nếu chưa từng chạy.
pub fn last_run_age(vault: &Vault, now: i64) -> Option<i64> {
    ensure_schema(vault).ok()?;
    vault
        .db
        .conn
        .query_row("SELECT ts FROM janitor_run ORDER BY id DESC LIMIT 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .ok()
        .map(|ts| now - ts)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levenshtein_basic() {
        assert_eq!(levenshtein("tokio", "tokio"), 0);
        assert_eq!(levenshtein("tokio", "toki"), 1);
        assert_eq!(levenshtein("rust", "rusty"), 1);
        assert_eq!(levenshtein("abc", "xyz"), 3);
    }

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn lint_finds_and_fixes() {
        let tmp = std::env::temp_dir().join(format!("brain-jan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // [[Gama]] typo (đích là Gamma.md) → propose fix.
        // [[Hoàn Toàn Khác]] không có đích gần → suggest.
        write(&tmp, "a.md", "Link [[Gama]] và [[Hoàn Toàn Khác]].\n");
        write(&tmp, "Gamma.md", "# Gamma\nnội dung đủ dài để không bị coi là stub nhé.\n");
        write(&tmp, "Lonely.md", "# Lonely\nkhông ai link tới, không link đi đâu cả nha.\n");

        let mut v = Vault::open(&tmp).unwrap();
        let report = run(&mut v).unwrap();

        // typo Gama → proposal FixLink Gamma.
        let prop = report
            .proposals
            .iter()
            .find(|p| p.rule == "broken-link")
            .expect("phải có proposal broken-link");
        // suggest cho link không cứu được + orphan.
        assert!(report.suggestions.iter().any(|s| s.rule == "broken-link"));
        assert!(report.suggestions.iter().any(|s| s.rule == "orphan"));

        apply_action(&mut v, prop.id).unwrap();
        let a = std::fs::read_to_string(tmp.join("a.md")).unwrap();
        assert!(a.contains("[[Gamma]]"), "got: {a}");

        // Sau khi áp dụng: chỉ còn 1 link gãy (cái không cứu được).
        assert_eq!(v.db.broken_links().unwrap().len(), 1);

        // latest_report đọc lại được, proposal đã thành applied.
        let latest = latest_report(&v).unwrap().unwrap();
        assert_eq!(latest.run_id, report.run_id);
        assert!(latest.proposals.iter().all(|p| p.id != prop.id));

        drop(v);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
