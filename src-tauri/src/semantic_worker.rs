//! Worker thread sở hữu Embedder + SemanticIndex (connection riêng vào cache.db).
//!
//! Giữ app nhẹ: model ONNX (~300MB RAM khi nạp) chỉ được load khi thật sự cần —
//! có chunk chưa embed, hoặc có vector để search — và tự unload sau 5 phút idle.

use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const IDLE_UNLOAD: Duration = Duration::from_secs(300);

pub enum Job {
    /// Embed các chunk chưa có vector.
    Sync,
    Query { q: String, k: usize, reply: Sender<Vec<(i64, f64)>> },
    Related { note_id: i64, k: usize, reply: Sender<Vec<(i64, f64)>> },
}

pub struct SemanticWorker {
    pub tx: Sender<Job>,
}

impl SemanticWorker {
    pub fn spawn(cache_db: PathBuf, app: AppHandle) -> Self {
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || {
            let mut index = match semantic::SemanticIndex::open(&cache_db) {
                Ok(i) => i,
                Err(e) => {
                    let _ = app.emit("semantic-status", format!("lỗi mở vector index: {e}"));
                    return;
                }
            };
            let mut embedder: Option<semantic::Embedder> = None;
            let mut model_failed = false;

            loop {
                let job = match rx.recv_timeout(IDLE_UNLOAD) {
                    Ok(j) => j,
                    Err(RecvTimeoutError::Timeout) => {
                        // Idle → trả RAM của model về hệ thống.
                        if embedder.take().is_some() {
                            let _ = app.emit("semantic-status", "");
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                };

                // Job này có cần model không? Sync không có gì mới / query khi chưa
                // từng embed → bỏ qua, khỏi tốn RAM.
                let needed = match &job {
                    Job::Sync => index.pending().map(|n| n > 0).unwrap_or(false),
                    Job::Query { .. } | Job::Related { .. } => {
                        index.pending().map(|_| true).unwrap_or(false) && index_has_vectors(&index)
                    }
                };
                if !needed || model_failed {
                    reply_empty(&job);
                    continue;
                }

                if embedder.is_none() {
                    let _ = app.emit("semantic-status", "đang nạp model embedding…");
                    match semantic::Embedder::new() {
                        Ok(e) => {
                            embedder = Some(e);
                            let _ = app.emit("semantic-status", "");
                        }
                        Err(e) => {
                            model_failed = true;
                            let _ = app.emit(
                                "semantic-status",
                                format!("semantic tắt (không nạp được model): {e:#}"),
                            );
                            reply_empty(&job);
                            continue;
                        }
                    }
                }
                let emb = embedder.as_ref().unwrap();

                match job {
                    Job::Sync => {
                        let app2 = app.clone();
                        match index.sync(emb, move |done, total| {
                            let _ = app2.emit("semantic-progress", (done, total));
                        }) {
                            Ok(_) => {
                                let _ = app.emit("semantic-status", "");
                            }
                            Err(e) => {
                                let _ = app.emit("semantic-status", format!("lỗi embedding: {e:#}"));
                            }
                        }
                    }
                    Job::Query { q, k, reply } => {
                        let _ = reply.send(index.search(emb, &q, k).unwrap_or_default());
                    }
                    Job::Related { note_id, k, reply } => {
                        let _ = reply.send(index.related(note_id, k).unwrap_or_default());
                    }
                }
            }
        });
        SemanticWorker { tx }
    }
}

fn index_has_vectors(index: &semantic::SemanticIndex) -> bool {
    index.vector_count().map(|n| n > 0).unwrap_or(false)
}

fn reply_empty(job: &Job) {
    match job {
        Job::Query { reply, .. } | Job::Related { reply, .. } => {
            let _ = reply.send(Vec::new());
        }
        Job::Sync => {}
    }
}
