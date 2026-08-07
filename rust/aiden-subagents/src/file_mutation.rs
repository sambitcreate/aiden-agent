//! Port of `main/services/subagents/subagent-file-mutation-core.ts` — the
//! pure preparation layer for transactional workspace file mutations: root
//! pinning, relative-path canonicalization, and the digest-pinned prepared
//! mutation records that cross into the mutator.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_SUBAGENT_FILE_CONTENT_BYTES: usize = 200_000;
pub const MAX_SUBAGENT_FILE_PATH_BYTES: usize = 4_096;
pub const MAX_SUBAGENT_FILE_PATH_COMPONENTS: usize = 64;
pub const MAX_SUBAGENT_FILE_COMPONENT_BYTES: usize = 255;
pub const MAX_SUBAGENT_FILE_LINES: usize = 50_000;

const RESERVED_COMPONENT_PREFIX: &str = ".aiden-subagent-file-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorkspaceRootIdentity {
    pub canonical_path: String,
    pub device: String,
    pub inode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFilePostimage {
    pub content: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSubagentFileMutation {
    pub version: u8,
    pub effect_id: String,
    pub effect_digest: String,
    pub operation: String,
    pub workspace_root: SubagentWorkspaceRootIdentity,
    pub relative_path: String,
    pub expected_revision: Option<String>,
    pub postimage: SubagentFilePostimage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFileInspection {
    pub version: u8,
    pub effect_id: String,
    pub workspace_root: SubagentWorkspaceRootIdentity,
    pub relative_path: String,
    pub expected_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_content: Option<String>,
}

/// `SubagentFileExpectedRevision` — `None` == "absent".
pub type SubagentFileExpectedRevision = Option<String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentFilePreparationFailure {
    Conflict,
    InvalidInput,
    Cancelled,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct SubagentFilePreparationError {
    pub failure: SubagentFilePreparationFailure,
    message: String,
}

impl SubagentFilePreparationError {
    pub fn new(failure: SubagentFilePreparationFailure) -> Self {
        let message = match failure {
            SubagentFilePreparationFailure::Conflict => {
                "The workspace file changed and was preserved.".to_string()
            }
            SubagentFilePreparationFailure::Cancelled => {
                "The workspace file operation was cancelled.".to_string()
            }
            SubagentFilePreparationFailure::InvalidInput => {
                "The workspace file operation request is invalid.".to_string()
            }
        };
        SubagentFilePreparationError { failure, message }
    }
}

fn invalid() -> SubagentFilePreparationError {
    SubagentFilePreparationError::new(SubagentFilePreparationFailure::InvalidInput)
}

fn conflict() -> SubagentFilePreparationError {
    SubagentFilePreparationError::new(SubagentFilePreparationFailure::Conflict)
}

fn is_exact_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_effect_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Pin the canonical workspace path to an exact decimal device/inode pair
/// (`pinSubagentWorkspaceRoot`).
pub fn pin_subagent_workspace_root(
    root: &str,
) -> Result<SubagentWorkspaceRootIdentity, SubagentFilePreparationError> {
    if root.is_empty()
        || !std::path::Path::new(root).is_absolute()
        || root.contains('\0')
        || root.len() > MAX_SUBAGENT_FILE_PATH_BYTES
    {
        return Err(invalid());
    }
    let canonical = std::fs::canonicalize(root).map_err(|_| conflict())?;
    let canonical_path = canonical.to_string_lossy().into_owned();
    let first = std::fs::metadata(&canonical).map_err(|_| conflict())?;
    let verified = std::fs::canonicalize(root).map_err(|_| conflict())?;
    let second = std::fs::metadata(&verified).map_err(|_| conflict())?;
    if canonical_path != verified.to_string_lossy()
        || !first.is_dir()
        || !second.is_dir()
        || file_identity(&first) != file_identity(&second)
    {
        return Err(conflict());
    }
    let (device, inode) = file_identity(&first);
    Ok(SubagentWorkspaceRootIdentity {
        canonical_path,
        device: device.to_string(),
        inode: inode.to_string(),
    })
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn file_identity(_metadata: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

fn has_forbidden_control(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f || (0x7f..=0x9f).contains(&code) || code == 0x2028 || code == 0x2029
    })
}

/// `canonicalSubagentFileRelativePath` — NFC-clean, `..`-free, no backslashes,
/// no reserved `.aiden-subagent-file-*` components.
pub fn canonical_subagent_file_relative_path(
    value: &str,
) -> Result<String, SubagentFilePreparationError> {
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.len() > MAX_SUBAGENT_FILE_PATH_BYTES
        || value.starts_with('/')
        || has_forbidden_control(value)
    {
        return Err(invalid());
    }
    let components: Vec<&str> = value.split('/').collect();
    if components.is_empty()
        || components.len() > MAX_SUBAGENT_FILE_PATH_COMPONENTS
        || components.iter().any(|component| {
            component.is_empty()
                || *component == "."
                || *component == ".."
                || component.starts_with(RESERVED_COMPONENT_PREFIX)
                || component.len() > MAX_SUBAGENT_FILE_COMPONENT_BYTES
        })
    {
        return Err(invalid());
    }
    Ok(value.to_string())
}

fn exact_sha256(value: &str) -> Result<String, SubagentFilePreparationError> {
    if !is_exact_fingerprint(value) {
        return Err(invalid());
    }
    Ok(value.to_string())
}

fn expected_revision(
    value: &SubagentFileExpectedRevision,
) -> Result<SubagentFileExpectedRevision, SubagentFilePreparationError> {
    match value {
        None => Ok(None),
        Some(value) => exact_sha256(value).map(Some),
    }
}

pub fn canonical_subagent_file_effect_id(
    value: &str,
) -> Result<String, SubagentFilePreparationError> {
    if !is_effect_id(value) {
        return Err(invalid());
    }
    Ok(value.to_string())
}

fn bounded_text(value: &str) -> Result<String, SubagentFilePreparationError> {
    if value.contains('\0') {
        return Err(invalid());
    }
    if value.len() > MAX_SUBAGENT_FILE_CONTENT_BYTES
        || value.split('\n').count() > MAX_SUBAGENT_FILE_LINES
    {
        return Err(invalid());
    }
    Ok(value.to_string())
}

fn safe_root_identity(
    value: &SubagentWorkspaceRootIdentity,
) -> Result<SubagentWorkspaceRootIdentity, SubagentFilePreparationError> {
    if value.canonical_path.is_empty()
        || !std::path::Path::new(&value.canonical_path).is_absolute()
        || value.canonical_path.contains('\0')
        || value.canonical_path.len() > MAX_SUBAGENT_FILE_PATH_BYTES
        || !value.device.bytes().all(|byte| byte.is_ascii_digit())
        || !value.inode.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid());
    }
    Ok(value.clone())
}

fn update_digest_field(hasher: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    let length = (bytes.len() as u32).to_be_bytes();
    hasher.update(length);
    hasher.update(bytes);
}

fn effect_digest(input: &EffectDigestInput) -> String {
    let mut hasher = Sha256::new();
    for field in [
        "aiden-subagent-file-effect-v1",
        input.effect_id,
        input.operation,
        &input.workspace_root.canonical_path,
        &input.workspace_root.device,
        &input.workspace_root.inode,
        input.relative_path,
        input.expected_revision.as_deref().unwrap_or("absent"),
        input.postimage_sha256,
        &input.postimage_bytes.to_string(),
        input.content,
    ] {
        update_digest_field(&mut hasher, field);
    }
    crate::authority::hex(&hasher.finalize())
}

struct EffectDigestInput<'a> {
    effect_id: &'a str,
    operation: &'a str,
    workspace_root: &'a SubagentWorkspaceRootIdentity,
    relative_path: &'a str,
    expected_revision: &'a SubagentFileExpectedRevision,
    content: &'a str,
    postimage_sha256: &'a str,
    postimage_bytes: u64,
}

/// Recompute every immutable binding before it crosses into the mutator
/// (`assertPreparedSubagentFileMutation`).
pub fn assert_prepared_subagent_file_mutation(
    value: &PreparedSubagentFileMutation,
) -> Result<(), SubagentFilePreparationError> {
    if value.version != 1
        || !is_effect_id(&value.effect_id)
        || !is_exact_fingerprint(&value.effect_digest)
        || (value.operation != "write" && value.operation != "edit")
    {
        return Err(invalid());
    }
    let workspace_root = safe_root_identity(&value.workspace_root)?;
    let relative_path = canonical_subagent_file_relative_path(&value.relative_path)?;
    let revision = expected_revision(&value.expected_revision)?;
    if value.operation == "edit" && revision.is_none() {
        return Err(invalid());
    }
    let content = bounded_text(&value.postimage.content)?;
    let sha256 = sha256_hex(content.as_bytes());
    if value.postimage.sha256 != sha256
        || value.postimage.bytes != content.len() as u64
        || value.effect_digest
            != effect_digest(&EffectDigestInput {
                effect_id: &value.effect_id,
                operation: &value.operation,
                workspace_root: &workspace_root,
                relative_path: &relative_path,
                expected_revision: &revision,
                content: &content,
                postimage_sha256: &sha256,
                postimage_bytes: content.len() as u64,
            })
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn assert_subagent_file_inspection(
    value: &SubagentFileInspection,
) -> Result<(), SubagentFilePreparationError> {
    if value.version != 1 || canonical_subagent_file_effect_id(&value.effect_id)? != value.effect_id
    {
        return Err(invalid());
    }
    safe_root_identity(&value.workspace_root)?;
    canonical_subagent_file_relative_path(&value.relative_path)?;
    let revision = expected_revision(&value.expected_revision)?;
    if revision.is_none() {
        if value.current_content.is_some() {
            return Err(invalid());
        }
        return Ok(());
    }
    let Some(current) = &value.current_content else {
        return Err(invalid());
    };
    let current = bounded_text(current)?;
    if sha256_hex(current.as_bytes()) != revision.as_deref().expect("checked") {
        return Err(invalid());
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    crate::authority::hex(&hasher.finalize())
}

#[derive(Debug, Clone)]
pub struct PrepareSubagentFileWriteInput {
    pub inspection: SubagentFileInspection,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct PrepareSubagentFileEditInput {
    pub inspection: SubagentFileInspection,
    pub old_string: String,
    pub new_string: String,
}

/// Deterministic effect-id allocation for tests.
pub struct SubagentFileMutationPreparer {
    allocate_effect_id: Box<dyn Fn() -> String + Send + Sync>,
}

impl Default for SubagentFileMutationPreparer {
    fn default() -> Self {
        SubagentFileMutationPreparer {
            allocate_effect_id: Box::new(|| format!("effect-{}", uuid_like())),
        }
    }
}

impl SubagentFileMutationPreparer {
    pub fn new(allocate_effect_id: Box<dyn Fn() -> String + Send + Sync>) -> Self {
        SubagentFileMutationPreparer { allocate_effect_id }
    }

    pub fn create_effect_id(&mut self) -> Result<String, SubagentFilePreparationError> {
        canonical_subagent_file_effect_id(&(self.allocate_effect_id)())
    }

    pub fn prepare_write(
        &mut self,
        input: &PrepareSubagentFileWriteInput,
    ) -> Result<PreparedSubagentFileMutation, SubagentFilePreparationError> {
        self.prepare("write", &input.inspection, &input.content)
    }

    pub fn prepare_edit(
        &mut self,
        input: &PrepareSubagentFileEditInput,
    ) -> Result<PreparedSubagentFileMutation, SubagentFilePreparationError> {
        assert_subagent_file_inspection(&input.inspection)?;
        if input.inspection.expected_revision.is_none()
            || input.inspection.current_content.is_none()
        {
            return Err(conflict());
        }
        let current = bounded_text(
            input
                .inspection
                .current_content
                .as_deref()
                .expect("checked"),
        )?;
        let old_value = bounded_text(&input.old_string)?;
        let new_value = bounded_text(&input.new_string)?;
        if old_value.is_empty() {
            return Err(invalid());
        }
        let first = current.find(&old_value);
        let Some(first) = first else {
            return Err(conflict());
        };
        if current[first + old_value.len()..].contains(&old_value) {
            return Err(conflict());
        }
        let mut content = String::with_capacity(current.len());
        content.push_str(&current[..first]);
        content.push_str(&new_value);
        content.push_str(&current[first + old_value.len()..]);
        self.prepare("edit", &input.inspection, &content)
    }

    fn prepare(
        &mut self,
        operation: &str,
        inspection: &SubagentFileInspection,
        content: &str,
    ) -> Result<PreparedSubagentFileMutation, SubagentFilePreparationError> {
        assert_subagent_file_inspection(inspection)?;
        let effect_id = canonical_subagent_file_effect_id(&inspection.effect_id)?;
        let workspace_root = safe_root_identity(&inspection.workspace_root)?;
        let relative_path = canonical_subagent_file_relative_path(&inspection.relative_path)?;
        let revision = expected_revision(&inspection.expected_revision)?;
        let content = bounded_text(content)?;
        let sha256 = sha256_hex(content.as_bytes());
        Ok(PreparedSubagentFileMutation {
            version: 1,
            effect_id: effect_id.clone(),
            effect_digest: effect_digest(&EffectDigestInput {
                effect_id: &effect_id,
                operation,
                workspace_root: &workspace_root,
                relative_path: &relative_path,
                expected_revision: &revision,
                content: &content,
                postimage_sha256: &sha256,
                postimage_bytes: content.len() as u64,
            }),
            operation: operation.to_string(),
            workspace_root,
            relative_path,
            expected_revision: revision,
            postimage: SubagentFilePostimage {
                content: content.clone(),
                sha256,
                bytes: content.len() as u64,
            },
        })
    }
}

fn uuid_like() -> String {
    // v4-shaped uuid used only as a nonce suffix.
    let mut bytes = [0u8; 16];
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    for chunk in bytes.chunks_mut(8) {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        let value = (z ^ (z >> 31)).to_le_bytes();
        chunk.copy_from_slice(&value[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(36);
    let mut byte_index = 0usize;
    let mut output_index = 0usize;
    while byte_index < 16 {
        if matches!(output_index, 8 | 13 | 18 | 23) {
            output.push('-');
            output_index += 1;
        }
        output.push(HEX[(bytes[byte_index] >> 4) as usize] as char);
        output.push(HEX[(bytes[byte_index] & 0x0f) as usize] as char);
        byte_index += 1;
        output_index += 2;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> SubagentWorkspaceRootIdentity {
        SubagentWorkspaceRootIdentity {
            canonical_path: "/tmp/workspace".to_string(),
            device: "16777220".to_string(),
            inode: "12345".to_string(),
        }
    }

    fn make_inspection(expected: Option<&str>, current: Option<&str>) -> SubagentFileInspection {
        SubagentFileInspection {
            version: 1,
            effect_id: "effect-1".to_string(),
            workspace_root: root(),
            relative_path: "src/main.rs".to_string(),
            expected_revision: expected.map(str::to_string),
            current_content: current.map(str::to_string),
        }
    }

    #[test]
    fn path_canonicalization_rejects_traversal_and_reserved_components() {
        assert_eq!(
            canonical_subagent_file_relative_path("src/main.rs").unwrap(),
            "src/main.rs"
        );
        assert!(canonical_subagent_file_relative_path("../escape").is_err());
        assert!(canonical_subagent_file_relative_path("a/../../b").is_err());
        assert!(canonical_subagent_file_relative_path("/absolute").is_err());
        assert!(canonical_subagent_file_relative_path("back\\slash").is_err());
        assert!(canonical_subagent_file_relative_path(".aiden-subagent-file-x.tmp").is_err());
        assert!(canonical_subagent_file_relative_path("").is_err());
    }

    #[test]
    fn write_preparation_recomputes_the_effect_digest() {
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let prepared = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection: make_inspection(None, None),
                content: "fn main() {}".to_string(),
            })
            .unwrap();
        assert_eq!(prepared.operation, "write");
        assert_eq!(prepared.effect_digest.len(), 64);
        assert!(assert_prepared_subagent_file_mutation(&prepared).is_ok());
        // Tampering with content breaks the digest.
        let mut tampered = prepared.clone();
        tampered.postimage.content = "fn main() { changed }".to_string();
        assert!(assert_prepared_subagent_file_mutation(&tampered).is_err());
    }

    #[test]
    fn edit_requires_exactly_one_occurrence() {
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let content = "a\nb\na\n".to_string();
        let sha = sha256_hex(content.as_bytes());
        let inspection = make_inspection(Some(&sha), Some(&content));
        // Two occurrences -> conflict.
        assert!(preparer
            .prepare_edit(&PrepareSubagentFileEditInput {
                inspection: inspection.clone(),
                old_string: "a".to_string(),
                new_string: "x".to_string(),
            })
            .is_err());
        // One occurrence -> ok.
        let edited = preparer
            .prepare_edit(&PrepareSubagentFileEditInput {
                inspection,
                old_string: "b".to_string(),
                new_string: "B".to_string(),
            })
            .unwrap();
        assert_eq!(edited.postimage.content, "a\nB\na\n");
        // Edit on an absent file -> conflict.
        assert!(preparer
            .prepare_edit(&PrepareSubagentFileEditInput {
                inspection: make_inspection(None, None),
                old_string: "a".to_string(),
                new_string: "x".to_string(),
            })
            .is_err());
    }

    #[test]
    fn inspection_digest_must_match_current_content() {
        let content = "abc".to_string();
        let wrong_sha = sha256_hex(b"different");
        assert!(assert_subagent_file_inspection(&make_inspection(
            Some(&wrong_sha),
            Some(&content)
        ))
        .is_err());
        let right_sha = sha256_hex(content.as_bytes());
        assert!(assert_subagent_file_inspection(&make_inspection(
            Some(&right_sha),
            Some(&content)
        ))
        .is_ok());
        // Absent inspection cannot carry content.
        assert!(assert_subagent_file_inspection(&make_inspection(None, Some("abc"))).is_err());
    }
}
