use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use vault_core::{watcher, Vault};

#[derive(Parser)]
#[command(name = "brain", about = "Second Brain — vault indexer & query CLI", version)]
struct Cli {
    /// Đường dẫn vault (mặc định: thư mục hiện tại)
    #[arg(long, global = true)]
    vault: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Index (tăng dần) toàn vault vào .brain/cache.db
    Index,
    /// Search nội dung note (từ khóa, BM25)
    Search {
        query: Vec<String>,
        #[arg(short = 'n', long, default_value_t = 10)]
        limit: usize,
    },
    /// Note liên quan với NOTE (tag chung / đồng trích dẫn / trùng từ khóa)
    Related { note: String },
    /// Hỏi đáp trên vault (RAG qua Claude Code CLI / Codex CLI)
    Ask { question: Vec<String> },
    /// Chạy janitor: snapshot + lint + report (dùng cho cron/Task Scheduler hằng đêm)
    Janitor {
        /// Áp dụng luôn mọi đề xuất (mặc định chỉ đề xuất, duyệt trong app)
        #[arg(long)]
        apply_proposals: bool,
        /// Chạy thêm tầng 2: LLM sinh MOC cho folder lớn (cần agent CLI)
        #[arg(long)]
        tier2: bool,
    },
    /// Liệt kê note đang link tới NOTE (đường dẫn hoặc title)
    Backlinks { note: String },
    /// Liệt kê wikilink gãy
    Broken,
    /// Liệt kê note mồ côi (không backlink, không link đi)
    Orphans,
    /// Thống kê vault
    Stats,
    /// Theo dõi vault và re-index khi file thay đổi
    Watch,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = cli.vault.unwrap_or_else(|| std::env::current_dir().unwrap());
    let mut vault = Vault::open(&root)?;

    // Mọi lệnh query đều index trước cho tươi — index tăng dần nên gần như miễn phí.
    let stats = vault.index()?;

    match cli.cmd {
        Cmd::Index => {
            println!(
                "Indexed {} notes ({} updated, {} removed) in {} ms",
                stats.scanned, stats.updated, stats.removed, stats.duration_ms
            );
            if !vault.db.fts_enabled {
                eprintln!("warning: SQLite FTS5 không khả dụng — search sẽ dùng LIKE (chậm hơn)");
            }
        }
        Cmd::Search { query, limit } => {
            let q = query.join(" ");
            let hits = vault.db.search(&q, limit)?;
            if hits.is_empty() {
                println!("Không tìm thấy kết quả cho: {q}");
            }
            for h in hits {
                let heading = if h.heading_path.is_empty() {
                    String::new()
                } else {
                    format!("  ({})", h.heading_path)
                };
                println!("{}:{}{}", h.path, h.start_line, heading);
                println!("    {}", h.snippet.replace('\n', " "));
            }
        }
        Cmd::Related { note } => {
            let rows = vault.db.related_notes(&note.replace('\\', "/"), 8)?;
            for r in &rows {
                println!("{}  \"{}\"  [{}]", r.path, r.title, r.reason);
            }
            if rows.is_empty() {
                println!("Không tìm thấy note liên quan nào với: {note}");
            }
        }
        Cmd::Backlinks { note } => {
            let rows = vault.db.backlinks(&note)?;
            if rows.is_empty() {
                println!("Không có backlink nào tới: {note}");
            }
            for r in rows {
                println!("{}  [{}]  \"{}\"", r.src_path, r.kind, r.src_title);
            }
        }
        Cmd::Broken => {
            let rows = vault.db.broken_links()?;
            if rows.is_empty() {
                println!("Không có link gãy nào 🎉");
            }
            for r in rows {
                println!("{}  →  [[{}]]  ({})", r.src_path, r.target, r.kind);
            }
        }
        Cmd::Orphans => {
            let rows = vault.db.orphans()?;
            if rows.is_empty() {
                println!("Không có note mồ côi nào 🎉");
            }
            for (path, title) in rows {
                println!("{path}  \"{title}\"");
            }
        }
        Cmd::Stats => {
            let (notes, links, broken, tags, chunks) = vault.db.stats()?;
            println!("Vault: {}", root.display());
            println!("  notes : {notes}");
            println!("  links : {links} ({broken} broken)");
            println!("  tags  : {tags}");
            println!("  chunks: {chunks}");
        }
        Cmd::Ask { question } => {
            let q = question.join(" ");
            eprintln!("Đang hỏi…");
            let ans = qa::ask(&vault.db, &q)?;
            println!("{}", ans.text);
            println!("\n— via {} · nguồn:", ans.provider);
            let mut seen = std::collections::HashSet::new();
            for s in &ans.sources {
                if seen.insert(&s.path) {
                    println!("  {}", s.path);
                }
            }
        }
        Cmd::Janitor { apply_proposals, tier2 } => {
            let mut report = janitor::run(&mut vault)?;
            println!(
                "Janitor run #{} — snapshot: {}",
                report.run_id,
                if report.snapshotted { "✓ (git)" } else { "✗ (không có git!)" }
            );
            if tier2 {
                match qa::detect_provider() {
                    Some(provider) => {
                        eprintln!("Tầng 2: đang hỏi {}…", provider.name());
                        report.proposals.extend(janitor::append_tier2(&mut vault, provider)?);
                    }
                    None => eprintln!("(tầng 2 bỏ qua: không có agent CLI trên PATH)"),
                }
            }
            if !report.applied.is_empty() {
                println!("\nĐã tự sửa ({}):", report.applied.len());
                for a in &report.applied {
                    println!("  ✓ {}", a.description);
                }
            }
            if !report.proposals.is_empty() {
                println!("\nĐề xuất ({}):", report.proposals.len());
                for p in &report.proposals {
                    if apply_proposals {
                        match janitor::apply_action(&mut vault, p.id) {
                            Ok(msg) => println!("  ✓ {} — {msg}", p.description),
                            Err(e) => println!("  ✗ {} — lỗi: {e}", p.description),
                        }
                    } else {
                        println!("  • [{}] {}", p.id, p.description);
                    }
                }
                if !apply_proposals {
                    println!("  (duyệt trong app, hoặc chạy lại với --apply-proposals)");
                }
            }
            if !report.suggestions.is_empty() {
                println!("\nGợi ý ({}):", report.suggestions.len());
                for s in &report.suggestions {
                    println!("  · {}", s.description);
                }
            }
            if report.applied.is_empty() && report.proposals.is_empty() && report.suggestions.is_empty() {
                println!("\nVault sạch sẽ, không có gì để làm 🎉");
            }
        }
        Cmd::Watch => {
            println!(
                "Watching {} — indexed {} notes. Ctrl+C để dừng.",
                root.display(),
                stats.scanned
            );
            watcher::watch(&mut vault, |s| {
                println!("re-indexed: {} updated, {} removed ({} ms)", s.updated, s.removed, s.duration_ms);
            })?;
        }
    }
    Ok(())
}
