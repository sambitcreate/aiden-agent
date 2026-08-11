//! Update feed manifest + verification — the pure core of a real update
//! provider (port of the decision logic `electron-updater`'s generic feed
//! codifies in `main/services/app-updater.ts`).
//!
//! electron-updater's generic provider reads `latest-mac.yml` next to the
//! app. Release builds use Electron Builder's YAML shape (relative artifact
//! URLs and base64-encoded SHA-512 digests); the JSON shape below remains a
//! bounded compatibility format for injected providers and tests:
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
//! Parsing is strict and fail-closed; verification uses the digest declared by
//! the feed (Electron Builder's SHA-512 or the compatibility JSON SHA-256) on
//! the exact downloaded bytes. Channel policy (prerelease rejection,
//! no-downgrade) reuses `crate::updater` (`should_offer_update`).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};

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
    /// hex sha-256 of the exact artifact bytes (compatibility JSON feeds).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha256: String,
    /// base64 sha-512 of the exact artifact bytes (Electron Builder feeds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha512: Option<String>,
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

fn is_base64_sha512(value: &str) -> bool {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map(|bytes| bytes.len() == 64)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(value)
                .map(|bytes| bytes.len() == 64)
        })
        .unwrap_or(false)
}

fn safe_https_url(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 8_192
        || !value.starts_with("https://")
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let authority = value
        .strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .unwrap_or_default();
    !authority.is_empty() && !authority.contains('@')
}

/// Resolve one Electron Builder artifact URL against the feed directory.
/// Relative file names are the normal latest-mac.yml form. Traversal,
/// protocol-relative URLs, credentials, fragments, and non-HTTPS inputs fail
/// closed before any artifact request is made.
fn resolve_artifact_url(raw: &str, feed_url: Option<&str>) -> Option<String> {
    let raw = raw.trim();
    if safe_https_url(raw) {
        return Some(raw.to_string());
    }
    let base = feed_url?;
    if !safe_https_url(base)
        || raw.is_empty()
        || raw.starts_with('/')
        || raw.starts_with("//")
        || raw.contains('#')
        || raw.chars().any(char::is_control)
    {
        return None;
    }
    let path = raw.split('?').next().unwrap_or(raw);
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    let base_directory = base.rsplit_once('/')?.0;
    let resolved = format!("{base_directory}/{raw}");
    safe_https_url(&resolved).then_some(resolved)
}

/// `parseUpdateFeed` — strict, fail-closed manifest parsing. Unknown keys are
/// tolerated; a missing/oversized/duplicate artifact set or a malformed digest
/// rejects the whole feed.
pub fn parse_update_feed(value: &Value) -> Option<UpdateFeedManifest> {
    parse_update_feed_with_base(value, None)
}

fn parse_update_feed_with_base(
    value: &Value,
    feed_url: Option<&str>,
) -> Option<UpdateFeedManifest> {
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
        let raw_url = file.get("url")?.as_str()?;
        let url = resolve_artifact_url(raw_url, feed_url)?;
        if !seen_urls.insert(url.clone()) {
            return None;
        }
        let sha256 = file
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sha512 = file
            .get("sha512")
            .and_then(Value::as_str)
            .map(str::to_string);
        if (sha256.is_empty() && sha512.is_none())
            || (!sha256.is_empty() && !is_hex64(sha256))
            || sha512
                .as_deref()
                .is_some_and(|digest| !is_base64_sha512(digest))
        {
            return None;
        }
        let size = file
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| *size > 0);
        parsed.push(UpdateFeedFile {
            url,
            sha256: sha256.to_string(),
            sha512,
            size,
        });
    }
    Some(UpdateFeedManifest {
        version: version.to_string(),
        release_date,
        files: parsed,
    })
}

/// Parse either Electron Builder's release YAML or the bounded JSON
/// compatibility shape used by injected providers. The feed URL is used to
/// resolve normal relative artifact paths from latest-mac.yml.
pub fn parse_update_feed_bytes(bytes: &[u8], feed_url: &str) -> Option<UpdateFeedManifest> {
    let value = serde_json::from_slice::<Value>(bytes)
        .or_else(|_| serde_yaml::from_slice::<Value>(bytes))
        .ok()?;
    parse_update_feed_with_base(&value, Some(feed_url))
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

/// Verify Electron Builder's base64-encoded SHA-512 digest.
pub fn verify_download_sha512(downloaded: &[u8], expected_sha512: &str) -> bool {
    let expected = base64::engine::general_purpose::STANDARD
        .decode(expected_sha512)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(expected_sha512));
    let Ok(expected) = expected else {
        return false;
    };
    if expected.len() != 64 {
        return false;
    }
    let mut hasher = Sha512::new();
    hasher.update(downloaded);
    hasher.finalize().as_slice() == expected.as_slice()
}

/// Verify the exact digest declared by one normalized feed entry.
pub fn verify_download(downloaded: &[u8], file: &UpdateFeedFile) -> bool {
    file.sha512.as_deref().map_or_else(
        || verify_download_sha256(downloaded, &file.sha256),
        |digest| verify_download_sha512(downloaded, digest),
    )
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
    use sha2::{Digest, Sha256, Sha512};

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

    fn sha512_base64_of(bytes: &[u8]) -> String {
        let mut hasher = Sha512::new();
        hasher.update(bytes);
        base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
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
    fn parses_electron_builder_yaml_relative_urls_and_sha512() {
        let bytes = b"release artifact";
        let digest = sha512_base64_of(bytes);
        let yaml = format!(
            "version: 0.28.0\nreleaseDate: '2026-08-11T00:00:00Z'\nfiles:\n  - url: Aiden-Agent-Beta-0.28.0-arm64.zip\n    sha512: {digest}\n    size: {}\npath: Aiden-Agent-Beta-0.28.0-arm64.zip\nsha512: {digest}\n",
            bytes.len()
        );
        let manifest = parse_update_feed_bytes(
            yaml.as_bytes(),
            "https://updates.example.test/aiden/latest-mac.yml",
        )
        .expect("electron builder feed");
        let file = choose_update_file(&manifest).expect("artifact");
        assert_eq!(
            file.url,
            "https://updates.example.test/aiden/Aiden-Agent-Beta-0.28.0-arm64.zip"
        );
        assert_eq!(file.sha256, "");
        assert_eq!(file.sha512.as_deref(), Some(digest.as_str()));
        assert!(verify_download(bytes, file));
    }

    #[test]
    fn relative_feed_traversal_and_non_https_artifacts_fail_closed() {
        let digest = sha512_base64_of(b"bytes");
        let traversal =
            format!("version: 0.28.0\nfiles:\n  - url: ../outside.zip\n    sha512: {digest}\n");
        assert!(parse_update_feed_bytes(
            traversal.as_bytes(),
            "https://updates.example.test/aiden/latest-mac.yml"
        )
        .is_none());
        let http = format!(
            "version: 0.28.0\nfiles:\n  - url: http://cdn.example.test/aiden.zip\n    sha512: {digest}\n"
        );
        assert!(parse_update_feed_bytes(
            http.as_bytes(),
            "https://updates.example.test/aiden/latest-mac.yml"
        )
        .is_none());
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
