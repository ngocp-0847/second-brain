//! Semantic search: embeddings (fastembed, multilingual-e5-small — hỗ trợ tiếng Việt)
//! lưu trong sqlite-vec, cùng file cache.db với vault-core.
//!
//! Embedding cache theo blake3(text) nên sửa 1 dòng trong note dài chỉ re-embed
//! đúng chunk bị đổi; đổi tên/di chuyển file không tốn lần embed nào.

use anyhow::{Context, Result};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::{params, Connection};
use std::path::Path;
use vault_core::db::SearchHit;

pub const DIM: usize = 384;
const RRF_K: f64 = 60.0;

/// Phải gọi MỘT LẦN trước khi mở bất kỳ Connection nào cần vec0.
pub fn register_vec_extension() {
    type AutoExtFn = unsafe extern "C" fn(
        *mut rusqlite::ffi::sqlite3,
        *mut *mut std::os::raw::c_char,
        *const rusqlite::ffi::sqlite3_api_routines,
    ) -> std::os::raw::c_int;
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let f: AutoExtFn = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        rusqlite::ffi::sqlite3_auto_extension(Some(f));
    });
}

pub struct Embedder {
    model: TextEmbedding,
}

impl Embedder {
    /// Lần đầu sẽ tải model ONNX (~110MB) về cache máy; các lần sau load từ đĩa.
    pub fn new() -> Result<Self> {
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::MultilingualE5Small)
                .with_cache_dir(model_cache_dir())
                .with_show_download_progress(false),
        )
        .context("khởi tạo model embedding (cần mạng ở lần đầu để tải model)")?;
        Ok(Embedder { model })
    }

    /// E5 yêu cầu prefix phân biệt passage/query.
    pub fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let prefixed: Vec<String> = texts.iter().map(|t| format!("passage: {t}")).collect();
        Ok(self.model.embed(prefixed, None)?)
    }

    pub fn embed_query(&self, q: &str) -> Result<Vec<f32>> {
        let mut v = self.model.embed(vec![format!("query: {q}")], None)?;
        Ok(v.pop().unwrap_or_default())
    }
}

/// Cache model cố định theo user, độc lập với thư mục chạy app.
fn model_cache_dir() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_CACHE_HOME"))
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("second-brain").join("models")
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// Index vector, mở connection riêng tới cùng cache.db (WAL cho phép đa connection).
pub struct SemanticIndex {
    conn: Connection,
}

impl SemanticIndex {
    pub fn open(cache_db: &Path) -> Result<Self> {
        register_vec_extension();
        let conn = Connection::open(cache_db)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(&format!(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
              chunk_id INTEGER PRIMARY KEY,
              embedding FLOAT[{DIM}]
            );
            CREATE TABLE IF NOT EXISTS embedding_cache (
              text_hash BLOB PRIMARY KEY,
              embedding BLOB NOT NULL
            ) WITHOUT ROWID;
            "#
        ))?;
        Ok(SemanticIndex { conn })
    }

    /// Vector trung bình của từng note (note_id → avg các chunk vector).
    /// Dùng cho janitor tầng 2 (phát hiện note đặt sai folder).
    pub fn note_vectors(&self) -> Result<Vec<(i64, Vec<f32>)>> {
        let rows: Vec<(i64, Vec<u8>)> = {
            let mut stmt = self.conn.prepare(
                r#"SELECT c.note_id, v.embedding FROM chunk_vec v
                   JOIN chunk c ON c.id = v.chunk_id ORDER BY c.note_id"#,
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut out: Vec<(i64, Vec<f32>)> = Vec::new();
        let mut counts: Vec<usize> = Vec::new();
        for (note_id, blob) in rows {
            let v = blob_to_vec(&blob);
            match out.last_mut() {
                Some((id, acc)) if *id == note_id => {
                    for (a, x) in acc.iter_mut().zip(v) {
                        *a += x;
                    }
                    *counts.last_mut().unwrap() += 1;
                }
                _ => {
                    out.push((note_id, v));
                    counts.push(1);
                }
            }
        }
        for ((_, acc), n) in out.iter_mut().zip(counts) {
            for a in acc.iter_mut() {
                *a /= n as f32;
            }
        }
        Ok(out)
    }

    /// Tổng số vector đang có trong index.
    pub fn vector_count(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM chunk_vec", [], |r| r.get(0))?)
    }

    /// Số chunk chưa có vector.
    pub fn pending(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM chunk WHERE id NOT IN (SELECT chunk_id FROM chunk_vec)",
            [],
            |r| r.get(0),
        )?)
    }

    /// Đồng bộ vector với bảng chunk. Chỉ gọi model cho text chưa có trong cache.
    /// `progress(done, total)` được gọi sau mỗi batch.
    pub fn sync(
        &mut self,
        embedder: &Embedder,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<usize> {
        self.conn.execute(
            "DELETE FROM chunk_vec WHERE chunk_id NOT IN (SELECT id FROM chunk)",
            [],
        )?;

        let missing: Vec<(i64, Vec<u8>, String)> = {
            let mut stmt = self.conn.prepare(
                r#"SELECT id, text_hash, text FROM chunk
                   WHERE id NOT IN (SELECT chunk_id FROM chunk_vec)"#,
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        let total = missing.len();
        let mut done = 0usize;

        for batch in missing.chunks(32) {
            // Tra cache trước, chỉ embed phần thật sự mới.
            let mut to_embed: Vec<(usize, String)> = Vec::new();
            let mut blobs: Vec<Option<Vec<u8>>> = vec![None; batch.len()];
            for (i, (_, hash, text)) in batch.iter().enumerate() {
                let cached: Option<Vec<u8>> = self
                    .conn
                    .query_row(
                        "SELECT embedding FROM embedding_cache WHERE text_hash = ?1",
                        [hash],
                        |r| r.get(0),
                    )
                    .ok();
                match cached {
                    Some(b) => blobs[i] = Some(b),
                    None => to_embed.push((i, truncate_for_model(text))),
                }
            }
            if !to_embed.is_empty() {
                let texts: Vec<String> = to_embed.iter().map(|(_, t)| t.clone()).collect();
                let embs = embedder.embed_passages(&texts)?;
                for ((i, _), emb) in to_embed.iter().zip(embs) {
                    blobs[*i] = Some(vec_to_blob(&emb));
                }
            }

            let tx = self.conn.transaction()?;
            for ((chunk_id, hash, _), blob) in batch.iter().zip(&blobs) {
                let Some(blob) = blob else { continue };
                tx.execute(
                    "INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?1, ?2)",
                    params![hash, blob],
                )?;
                tx.execute(
                    "INSERT OR REPLACE INTO chunk_vec (chunk_id, embedding) VALUES (?1, ?2)",
                    params![chunk_id, blob],
                )?;
            }
            tx.commit()?;
            done += batch.len();
            progress(done, total);
        }
        Ok(total)
    }

    /// KNN theo câu query → (chunk_id, distance).
    pub fn search(&self, embedder: &Embedder, query: &str, k: usize) -> Result<Vec<(i64, f64)>> {
        let qv = embedder.embed_query(query)?;
        self.knn(&qv, k, None)
    }

    /// Note liên quan: trung bình vector các chunk của note → KNN, loại chính nó.
    pub fn related(&self, note_id: i64, k: usize) -> Result<Vec<(i64, f64)>> {
        let blobs: Vec<Vec<u8>> = {
            let mut stmt = self.conn.prepare(
                r#"SELECT v.embedding FROM chunk_vec v
                   JOIN chunk c ON c.id = v.chunk_id WHERE c.note_id = ?1"#,
            )?;
            let rows = stmt
                .query_map([note_id], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if blobs.is_empty() {
            return Ok(Vec::new());
        }
        let mut avg = vec![0f32; DIM];
        for b in &blobs {
            for (a, x) in avg.iter_mut().zip(blob_to_vec(b)) {
                *a += x;
            }
        }
        let n = blobs.len() as f32;
        for a in &mut avg {
            *a /= n;
        }
        self.knn(&avg, k, Some(note_id))
    }

    fn knn(&self, vec: &[f32], k: usize, exclude_note: Option<i64>) -> Result<Vec<(i64, f64)>> {
        let blob = vec_to_blob(vec);
        // vec0 yêu cầu KNN đứng riêng trong subquery; lọc note ở tầng ngoài.
        let mut stmt = self.conn.prepare_cached(
            r#"SELECT v.chunk_id, v.distance
               FROM (SELECT chunk_id, distance FROM chunk_vec
                     WHERE embedding MATCH ?1 AND k = ?2) v
               JOIN chunk c ON c.id = v.chunk_id
               WHERE ?3 IS NULL OR c.note_id != ?3
               ORDER BY v.distance"#,
        )?;
        let rows = stmt
            .query_map(params![blob, (k * 2) as i64, exclude_note], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().take(k).collect())
    }
}

/// Model có giới hạn 512 token; cắt thô theo ký tự cho an toàn.
fn truncate_for_model(text: &str) -> String {
    const MAX_CHARS: usize = 1200;
    if text.chars().count() <= MAX_CHARS {
        text.to_string()
    } else {
        text.chars().take(MAX_CHARS).collect()
    }
}

/// Trộn kết quả FTS (BM25) và vector bằng Reciprocal Rank Fusion.
/// `vec_hits` là (chunk_id, distance) đã sắp theo distance tăng dần.
pub fn rrf_merge(
    fts_hits: Vec<SearchHit>,
    vec_hits: Vec<(i64, f64)>,
    hydrate: impl Fn(&[i64]) -> Result<Vec<SearchHit>>,
    limit: usize,
) -> Result<Vec<(SearchHit, f64)>> {
    use std::collections::HashMap;
    let mut scores: HashMap<i64, f64> = HashMap::new();
    let mut hits: HashMap<i64, SearchHit> = HashMap::new();

    for (rank, hit) in fts_hits.into_iter().enumerate() {
        *scores.entry(hit.chunk_id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        hits.entry(hit.chunk_id).or_insert(hit);
    }
    let need: Vec<i64> = vec_hits
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| !hits.contains_key(id))
        .collect();
    for hit in hydrate(&need)? {
        hits.insert(hit.chunk_id, hit);
    }
    for (rank, (id, _)) in vec_hits.iter().enumerate() {
        if hits.contains_key(id) {
            *scores.entry(*id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }

    let mut merged: Vec<(SearchHit, f64)> = hits
        .into_iter()
        .map(|(id, h)| (h, scores.get(&id).copied().unwrap_or(0.0)))
        .collect();
    merged.sort_by(|a, b| b.1.total_cmp(&a.1));
    merged.truncate(limit);
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip() {
        let v: Vec<f32> = (0..DIM).map(|i| i as f32 * 0.5).collect();
        assert_eq!(blob_to_vec(&vec_to_blob(&v)), v);
    }

    #[test]
    fn rrf_prefers_items_in_both_lists() {
        let mk = |id: i64| SearchHit {
            chunk_id: id,
            path: format!("n{id}.md"),
            title: format!("n{id}"),
            heading_path: String::new(),
            start_line: 1,
            snippet: String::new(),
        };
        // fts: 1,2  vec: 2,3 → 2 phải đứng đầu
        let merged = rrf_merge(
            vec![mk(1), mk(2)],
            vec![(2, 0.1), (3, 0.2)],
            |ids| Ok(ids.iter().map(|i| mk(*i)).collect()),
            10,
        )
        .unwrap();
        assert_eq!(merged[0].0.chunk_id, 2);
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn vec_index_knn_without_model() {
        // Test sqlite-vec thuần (không cần tải model): insert vector tay, query KNN.
        let tmp = std::env::temp_dir().join(format!("brain-vec-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        register_vec_extension();
        let conn = Connection::open(&tmp).unwrap();
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE t USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[{DIM}]);"
        ))
        .unwrap();
        let mut a = vec![0f32; DIM];
        a[0] = 1.0;
        let mut b = vec![0f32; DIM];
        b[1] = 1.0;
        conn.execute("INSERT INTO t (id, embedding) VALUES (1, ?1)", [vec_to_blob(&a)]).unwrap();
        conn.execute("INSERT INTO t (id, embedding) VALUES (2, ?1)", [vec_to_blob(&b)]).unwrap();
        let nearest: i64 = conn
            .query_row(
                "SELECT id FROM t WHERE embedding MATCH ?1 AND k = 1",
                [vec_to_blob(&a)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nearest, 1);
        drop(conn);
        let _ = std::fs::remove_file(&tmp);
    }
}
