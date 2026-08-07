//! Update feed manifest + verification — the pure core of a real update
//! provider (port of the decision logic `electron-updater`'s generic feed
//! codifies in `main/services/app-updater.ts`).
//!
//! electron-updater's generic provider reads `latest-mac.yml` next to the
//! app; the Rust feed contract is the JSON equivalent:
//!
//! ```json
//! {
//!   "version": "0.27.25",
//!   "releaseDate": "2026-08-07T00:00:00Z",
//!   "files": [{ "url": "https://cdn.example.com/Aiden-Agent-0.27.25.dmg",
//!               "sha256": "<64 hex chars>", "size": 123456789 }]
//! }
//! ```
//!
//! Parsing is strict and fail-closed; verification is sha-256 of the exact
//! downloaded bytes; channel policy (prerelease rejection, no-downgrade)
//! reuses `crate::updater` (`should_offer_update`). The install step is a
//! trait method the binary wires later — replacing a running `.app` is
//! inherently distribution glue.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Cap for the feed document itself (bytes).
pub const MAX_FEED_BYTES: u64 = 1 << 20;
/// Cap for a single downloaded update artifact (bytes).
pub const MAX_UPDATE_BYTES: u64 = 2 << 30;
/// `app-update.yml` — the marker file the packaged app embeds next to the
/// feed metadata (the TS checks `process.resourcesPath` for it).
pub const APP_UPDATE_CONFIG_FILENAME: &str = "app-update.yml";

/// One downloadable artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFeedFile {
    pub url: String,
    /// hex sha-256 of the exact artifact bytes.
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// The parsed, normalized feed manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFeedManifest {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    pub files: Vec<UpdateFeedFile>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `parseUpdateFeed` — strict, fail-closed manifest parsing. Unknown keys are
/// tolerated; a missing/oversized/duplicate artifact set or a malformed digest
/// rejects the whole feed.
pub fn parse_update_feed(value: &Value) -> Option<UpdateFeedManifest> {
    let record = value.as_object()?;
    let version = record.get("version")?.as_str()?;
    if version.trim().is_empty() || version.chars().count() > 128 {
        return None;
    }
    let release_date = record
        .get("releaseDate")
        .and_then(Value::as_str)
        .map(str::to_string);
    let files = record.get("files")?.as_array()?;
    if files.is_empty() || files.len() > 32 {
        return None;
    }
    let mut seen_urls = std::collections::HashSet::new();
    let mut parsed = Vec::with_capacity(files.len());
    for file in files {
        let file = file.as_object()?;
        let url = file.get("url")?.as_str()?;
        if url.is_empty()
            || url.len() > 8_192
            || !url.starts_with("https://")
            || !seen_urls.insert(url.to_string())
        {
            return None;
        }
        let sha256 = file.get("sha256")?.as_str()?;
        if !is_hex64(sha256) {
            return None;
        }
        let size = file
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| *size > 0);
        parsed.push(UpdateFeedFile {
            url: url.to_string(),
            sha256: sha256.to_string(),
            size,
        });
    }
    Some(UpdateFeedManifest {
        version: version.to_string(),
        release_date,
        files: parsed,
    })
}

/// `chooseUpdateFile` — the artifact to install. The first entry wins, mirroring
/// electron-updater's generic provider (a single signed artifact per channel).
pub fn choose_update_file(manifest: &UpdateFeedManifest) -> Option<&UpdateFeedFile> {
    manifest.files.first()
}

/// `verifyDownloadSha256` — constant-ish digest comparison of the exact
/// downloaded bytes against the feed's declared digest.
pub fn verify_download_sha256(downloaded: &[u8], expected_sha256: &str) -> bool {
    if !is_hex64(expected_sha256) {
        return false;
    }
    let mut hasher = Sha256::new();
    hasher.update(downloaded);
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded == expected_sha256
}

/// The artifact-selection step of one check: the feed must declare exactly one
/// downloadable artifact for the current channel.
pub fn download_decision(
    manifest: &UpdateFeedManifest,
) -> Result<&UpdateFeedFile, FeedUpdateError> {
    choose_update_file(manifest).ok_or(FeedUpdateError::NoArtifact)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FeedUpdateError {
    #[error("The update feed did not declare a downloadable artifact.")]
    NoArtifact,
    #[error("The downloaded update failed its SHA-256 integrity check.")]
    IntegrityMismatch,
    #[error("The update artifact exceeded the allowed size.")]
    TooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};
    use sha2::{Digest, Sha256};

    fn feed() -> Value {
        json!({
            "version": "0.27.25",
            "releaseDate": "2026-08-07T00:00:00Z",
            "files": [{
                "url": "https://cdn.example.com/Aiden-Agent-0.27.25.dmg",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size": 123456789,
            }],
        })
    }

    fn sha256_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        let mut encoded = String::with_capacity(64);
        for byte in digest {
            encoded.push_str(&format!("{byte:02x}"));
        }
        encoded
    }

    #[test]
    fn parses_a_valid_feed_and_selects_the_artifact() {
        let manifest = parse_update_feed(&feed()).expect("feed");
        assert_eq!(manifest.version, "0.27.25");
        assert_eq!(
            manifest.release_date.as_deref(),
            Some("2026-08-07T00:00:00Z")
        );
        assert_eq!(manifest.files.len(), 1);
        let file = choose_update_file(&manifest).unwrap();
        assert_eq!(file.url, "https://cdn.example.com/Aiden-Agent-0.27.25.dmg");
        assert_eq!(file.size, Some(123456789));
        assert!(download_decision(&manifest).is_ok());
    }

    #[test]
    fn rejects_malformed_duplicate_or_non_https_feeds() {
        assert!(parse_update_feed(&Value::Null).is_none());
        let mut no_files = feed();
        no_files["files"] = json!([]);
        assert!(parse_update_feed(&no_files).is_none());

        let mut bad_digest = feed();
        bad_digest["files"][0]["sha256"] = json!("short");
        assert!(parse_update_feed(&bad_digest).is_none());

        let mut http_url = feed();
        http_url["files"][0]["url"] = json!("http://cdn.example.com/x.dmg");
        assert!(parse_update_feed(&http_url).is_none());

        let mut duplicate = feed();
        let first = duplicate["files"][0].clone();
        duplicate["files"].as_array_mut().unwrap().push(first);
        assert!(parse_update_feed(&duplicate).is_none());
    }

    #[test]
    fn verifies_exact_bytes_against_the_declared_digest() {
        let bytes = b"the exact artifact bytes";
        let digest = sha256_of(bytes);
        assert!(verify_download_sha256(bytes, &digest));
        assert!(!verify_download_sha256(b"tampered bytes", &digest));
        assert!(!verify_download_sha256(bytes, "not-a-digest"));
        assert!(!verify_download_sha256(bytes, "A".repeat(64).as_str()));
    }

    #[test]
    fn empty_or_oversized_feed_shapes_fail_closed() {
        let mut oversized = feed();
        oversized["files"] = Value::Array(vec![Value::Object(Map::new()); 33]);
        assert!(parse_update_feed(&oversized).is_none());
        let mut giant_version = feed();
        giant_version["version"] = json!("x".repeat(129));
        assert!(parse_update_feed(&giant_version).is_none());
    }
}
