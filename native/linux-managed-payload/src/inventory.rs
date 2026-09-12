use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const MANIFEST_BYTES: usize = 32 * 1024 * 1024;
pub const FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub const ENTRIES: usize = 100_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Inventory {
    pub schema_version: u32,
    pub hash_algorithm: String,
    pub entries: Vec<Entry>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub mode: u32,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Approval {
    pub schema_version: u32,
    pub kind: String,
    pub inventory_sha256: String,
    /// Diagnostic operator input; this code does NOT verify package provenance
    /// or establish a cryptographic relationship to the staged payload.
    pub package_sha256: String,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn relative(value: &str, root: bool) -> bool {
    if root && value == "." {
        return true;
    }
    !value.is_empty()
        && value.len() <= 4096
        && !value
            .chars()
            .any(|c| c < ' ' || c == '\u{7f}' || c == '\\' || c == '\u{fffd}')
        && value.split('/').count() <= 64
        && value
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
pub fn parse(bytes: &[u8]) -> Result<Inventory> {
    if bytes.len() > MANIFEST_BYTES {
        return Err("inventory exceeds byte bound".into());
    }
    let value: Inventory = serde_json::from_slice(bytes)?;
    // Inspect field presence too: Option alone would accept explicit null fields
    // on directories, which is outside the Phase 16 schema.
    let fields: serde_json::Value = serde_json::from_slice(bytes)?;
    if value.schema_version != 1
        || value.hash_algorithm != "sha256"
        || value.entries.is_empty()
        || value.entries.len() > ENTRIES
    {
        return Err("unsupported inventory".into());
    }
    let mut seen = BTreeMap::new();
    let mut previous: Option<&str> = None;
    let mut total = 0u64;
    for (i, entry) in value.entries.iter().enumerate() {
        if !relative(&entry.path, i == 0)
            || (i == 0 && (entry.path != "." || entry.kind != "directory"))
            || seen.contains_key(entry.path.as_str())
            || (i > 1
                && previous
                    .is_some_and(|p| p.encode_utf16().cmp(entry.path.encode_utf16()).is_ge()))
        {
            return Err("invalid inventory path/order".into());
        }
        if entry.mode > 0o7777 {
            return Err("invalid permission mode".into());
        }
        if i > 0 {
            let parent = entry.path.rsplit_once('/').map(|v| v.0).unwrap_or(".");
            if seen.get(parent) != Some(&"directory") {
                return Err("missing directory parent".into());
            }
        }
        let count = fields["entries"][i]
            .as_object()
            .ok_or("entry must be object")?
            .len();
        match entry.kind.as_str() {
            "directory" if count == 3 => {}
            "file" if count == 5 => {
                let size = entry.size.ok_or("missing size")?;
                if size > FILE_BYTES || !entry.sha256.as_deref().is_some_and(digest) {
                    return Err("invalid file metadata".into());
                }
                total = total.checked_add(size).ok_or("total overflow")?;
                if total > TOTAL_BYTES {
                    return Err("payload too large".into());
                }
            }
            _ => return Err("invalid entry type/fields".into()),
        }
        previous = Some(&entry.path);
        seen.insert(entry.path.as_str(), entry.kind.as_str());
    }
    Ok(value)
}
pub fn approval(bytes: &[u8], inventory_bytes: &[u8]) -> Result<Approval> {
    if bytes.len() > 4096 {
        return Err("approval exceeds byte bound".into());
    }
    let value: Approval = serde_json::from_slice(bytes)?;
    if value.schema_version != 1
        || value.kind != "local-staging-only"
        || !digest(&value.package_sha256)
        || value.inventory_sha256 != hash(inventory_bytes)
    {
        return Err("invalid local-only approval or inventory digest".into());
    }
    Ok(value)
}
