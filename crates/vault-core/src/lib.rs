//! vault-core: mô hình vault Markdown kiểu Obsidian.
//!
//! Vault = thư mục chứa file `.md`; mọi index/cache nằm trong `.brain/` và
//! tái tạo được hoàn toàn từ file gốc.

pub mod db;
pub mod parser;
pub mod proc;
pub mod vault;
pub mod watcher;

pub use parser::{Chunk, LinkKind, ParsedNote, RawLink};
pub use vault::{IndexStats, Vault};
