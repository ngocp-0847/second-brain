//! `resources/*`: mỗi note là một resource `brain://note/{path}` (text/markdown),
//! cộng vài resource tổng hợp của vault (stats, graph, broken links) dạng JSON.

use crate::{RpcError, Server};
use serde_json::{json, Value};

const PAGE: usize = 200;

pub(crate) fn list(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let offset: usize = params["cursor"]
        .as_str()
        .map(|c| c.parse().map_err(|_| RpcError::invalid_params("cursor không hợp lệ")))
        .transpose()?
        .unwrap_or(0);

    let notes = server.vault.db.note_list()?;
    let mut resources = Vec::new();
    if offset == 0 {
        resources.push(json!({
            "uri": "brain://vault/stats", "name": "vault-stats",
            "title": "Thống kê vault", "mimeType": "application/json",
            "description": "Số note/link/tag/chunk, link gãy, gốc vault."
        }));
        resources.push(json!({
            "uri": "brain://vault/graph", "name": "vault-graph",
            "title": "Đồ thị wikilink", "mimeType": "application/json",
            "description": "nodes (path, title, degree) + edges (from, to)."
        }));
        resources.push(json!({
            "uri": "brain://vault/broken-links", "name": "broken-links",
            "title": "Wikilink gãy", "mimeType": "application/json"
        }));
    }
    for (path, title, mtime) in notes.iter().skip(offset).take(PAGE) {
        resources.push(json!({
            "uri": note_uri(path),
            "name": path,
            "title": title,
            "mimeType": "text/markdown",
            "description": format!("mtime={mtime}")
        }));
    }
    let mut r = json!({ "resources": resources });
    if offset + PAGE < notes.len() {
        r["nextCursor"] = json!((offset + PAGE).to_string());
    }
    Ok(r)
}

pub(crate) fn templates() -> Value {
    json!({
        "resourceTemplates": [{
            "uriTemplate": "brain://note/{path}",
            "name": "note",
            "title": "Note trong vault",
            "description": "Nội dung Markdown của note theo đường dẫn tương đối (vd Projects/Alpha.md).",
            "mimeType": "text/markdown"
        }]
    })
}

pub(crate) fn read(server: &mut Server, params: &Value) -> Result<Value, RpcError> {
    let uri = params["uri"].as_str().ok_or_else(|| RpcError::invalid_params("thiếu `uri`"))?;
    let (mime, text) = if let Some(enc) = uri.strip_prefix("brain://note/") {
        let rel = percent_decode(enc);
        let (_, abs) = server.abs(&rel)?;
        let text = std::fs::read_to_string(&abs)
            .map_err(|e| RpcError::invalid_params(&format!("không đọc được {rel}: {e}")))?;
        ("text/markdown", text)
    } else {
        let v = match uri {
            "brain://vault/stats" => crate::tools::vault_stats(server)?,
            "brain://vault/graph" => crate::tools::graph(server)?,
            "brain://vault/broken-links" => crate::tools::broken_links(server)?,
            _ => return Err(RpcError::invalid_params(&format!("resource không tồn tại: {uri}"))),
        };
        ("application/json", serde_json::to_string_pretty(&v).unwrap_or_default())
    };
    Ok(json!({ "contents": [{ "uri": uri, "mimeType": mime, "text": text }] }))
}

pub(crate) fn note_uri(path: &str) -> String {
    format!("brain://note/{}", percent_encode(path))
}

/// Encode đủ để URI hợp lệ; giữ `/` để path còn đọc được.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
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

    #[test]
    fn roundtrip_unicode_path() {
        let p = "Dự án/Ghi chú 1.md";
        assert_eq!(percent_decode(&percent_encode(p)), p);
        assert!(!percent_encode(p).contains(' '));
    }
}
