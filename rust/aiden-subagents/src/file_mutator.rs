//! Port of `main/services/subagents/subagent-file-mutator-io.ts` +
//! `native/subagent-file-mutator/main.c` — the transactional workspace file
//! mutator, now **in-process** with identical semantics:
//!
//! - State machine `idle → inspected → prepared → committed/indeterminate →
//!   closed` (failures: `cancelled / conflict / indeterminate / invalid_input /
//!   io_failed`).
//! - Recovery artifacts `.aiden-subagent-file-<effectId>-<uuid>.tmp` staged
//!   with O_EXCL + 0600 in the target's parent directory, fsynced, then
//!   atomically installed; an existing recovery artifact proves the commit is
//!   indeterminate.
//! - Refuses to write if the file changed after inspection (digest-pinned
//!   `expectedRevision`), and never removes a recovery artifact it cannot
//!   verify.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use thiserror::Error;

use crate::file_mutation::{
    assert_prepared_subagent_file_mutation, assert_subagent_file_inspection,
    canonical_subagent_file_effect_id, canonical_subagent_file_relative_path, sha256_hex,
    PreparedSubagentFileMutation, SubagentFileInspection, SubagentWorkspaceRootIdentity,
};

const RECOVERY_SUFFIX: &str = ".aiden-subagent-file-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentFileMutatorFailure {
    Cancelled,
    Conflict,
    Indeterminate,
    InvalidInput,
    IoFailed,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct SubagentFileMutatorError {
    pub failure: SubagentFileMutatorFailure,
    message: String,
}

impl SubagentFileMutatorError {
    pub fn new(failure: SubagentFileMutatorFailure) -> Self {
        let message = match failure {
            SubagentFileMutatorFailure::Cancelled => {
                "The workspace file operation was cancelled.".to_string()
            }
            SubagentFileMutatorFailure::Conflict => {
                "The workspace file changed and was preserved.".to_string()
            }
            SubagentFileMutatorFailure::Indeterminate => {
                "The workspace file operation outcome is unknown. Aiden did not remove any recovery artifact it could verify."
                    .to_string()
            }
            SubagentFileMutatorFailure::InvalidInput => {
                "The workspace file operation request is invalid.".to_string()
            }
            SubagentFileMutatorFailure::IoFailed => {
                "The workspace file operation could not be completed safely.".to_string()
            }
        };
        SubagentFileMutatorError { failure, message }
    }
}

fn invalid() -> SubagentFileMutatorError {
    SubagentFileMutatorError::new(SubagentFileMutatorFailure::InvalidInput)
}

#[derive(Debug, Clone)]
pub struct SubagentFileMutationCommit {
    pub effect_id: String,
    pub effect_digest: String,
    pub postimage_sha256: String,
    pub postimage_bytes: u64,
    pub recovery_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientState {
    Idle,
    Inspected {
        inspection: SubagentFileInspection,
    },
    Prepared {
        effect: PreparedSubagentFileMutation,
    },
    Committed {
        effect: PreparedSubagentFileMutation,
        recovery_name: Option<String>,
    },
    Indeterminate {
        effect: PreparedSubagentFileMutation,
        recovery_name: Option<String>,
    },
    Closed,
}

/// In-process mutator with the identical staging/commit protocol.
pub struct SubagentFileMutatorClient {
    workspace_root: SubagentWorkspaceRootIdentity,
    state: ClientState,
    uuid: Box<dyn Fn() -> String + Send + Sync>,
}

impl SubagentFileMutatorClient {
    pub fn new(
        workspace_root: SubagentWorkspaceRootIdentity,
    ) -> Result<Self, SubagentFileMutatorError> {
        if !Path::new(&workspace_root.canonical_path).is_absolute()
            || workspace_root.canonical_path.contains('\0')
            || !workspace_root
                .device
                .bytes()
                .all(|byte| byte.is_ascii_digit())
            || !workspace_root
                .inode
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        {
            return Err(invalid());
        }
        Ok(SubagentFileMutatorClient {
            workspace_root,
            state: ClientState::Idle,
            uuid: Box::new(uuid_like),
        })
    }

    pub fn current_state(&self) -> ClientState {
        self.state.clone()
    }

    fn verify_root(&self) -> Result<(), SubagentFileMutatorError> {
        let pinned =
            crate::file_mutation::pin_subagent_workspace_root(&self.workspace_root.canonical_path)
                .map_err(|error| match error.failure {
                    crate::file_mutation::SubagentFilePreparationFailure::Conflict => {
                        SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict)
                    }
                    _ => SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed),
                })?;
        if pinned.device != self.workspace_root.device || pinned.inode != self.workspace_root.inode
        {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        Ok(())
    }

    /// `inspect <effectId> <relativePath>` — read + digest the current file.
    pub fn inspect(
        &mut self,
        effect_id_value: &str,
        relative_path_value: &str,
    ) -> Result<SubagentFileInspection, SubagentFileMutatorError> {
        if self.state != ClientState::Idle {
            return Err(invalid());
        }
        let effect_id =
            canonical_subagent_file_effect_id(effect_id_value).map_err(|_| invalid())?;
        let relative_path =
            canonical_subagent_file_relative_path(relative_path_value).map_err(|_| invalid())?;
        self.verify_root()?;
        let target = Path::new(&self.workspace_root.canonical_path).join(&relative_path);
        let target = resolve_in_root(Path::new(&self.workspace_root.canonical_path), &target)
            .ok_or_else(invalid)?;
        let inspection = match fs::read(&target) {
            Ok(bytes) => {
                if bytes.len() > crate::file_mutation::MAX_SUBAGENT_FILE_CONTENT_BYTES {
                    return Err(invalid());
                }
                let content = String::from_utf8(bytes).map_err(|_| invalid())?;
                SubagentFileInspection {
                    version: 1,
                    effect_id,
                    workspace_root: self.workspace_root.clone(),
                    relative_path,
                    expected_revision: Some(sha256_hex(content.as_bytes())),
                    current_content: Some(content),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SubagentFileInspection {
                version: 1,
                effect_id,
                workspace_root: self.workspace_root.clone(),
                relative_path,
                expected_revision: None,
                current_content: None,
            },
            Err(_) => {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ))
            }
        };
        assert_subagent_file_inspection(&inspection)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        self.state = ClientState::Inspected {
            inspection: inspection.clone(),
        };
        Ok(inspection)
    }

    /// `prepare-inspected <effectId> <expectedRevision|absent> <base64 content>`
    /// — stage the postimage in the target's parent directory and fsync.
    pub fn prepare(
        &mut self,
        effect: &PreparedSubagentFileMutation,
    ) -> Result<(), SubagentFileMutatorError> {
        let current = self.state.clone();
        let ClientState::Inspected { inspection } = current else {
            return Err(invalid());
        };
        assert_prepared_subagent_file_mutation(effect).map_err(|_| invalid())?;
        if effect.workspace_root != self.workspace_root {
            return Err(invalid());
        }
        if effect.effect_id != inspection.effect_id
            || effect.relative_path != inspection.relative_path
            || effect.expected_revision != inspection.expected_revision
        {
            return Err(invalid());
        }
        self.verify_root()?;
        let target = Path::new(&self.workspace_root.canonical_path).join(&effect.relative_path);
        let target = resolve_in_root(Path::new(&self.workspace_root.canonical_path), &target)
            .ok_or_else(invalid)?;
        // Refuse if the file changed since inspection.
        let current_digest = match fs::read(&target) {
            Ok(bytes) => Some(sha256_hex(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ))
            }
        };
        match (&effect.expected_revision, &current_digest) {
            (None, None) => {}
            (Some(expected), Some(current)) if expected == current => {}
            _ => {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Conflict,
                ))
            }
        }
        self.stage_and_verify(effect, &target)?;
        self.state = ClientState::Prepared {
            effect: effect.clone(),
        };
        Ok(())
    }

    /// Stage the postimage beside the target (create-new, 0600, fsync).
    fn stage_and_verify(
        &mut self,
        effect: &PreparedSubagentFileMutation,
        target: &Path,
    ) -> Result<(), SubagentFileMutatorError> {
        let parent = target.parent().ok_or_else(invalid)?;
        let staged = parent.join(format!(
            "{RECOVERY_SUFFIX}{}-{}.tmp",
            effect.effect_id,
            (self.uuid)()
        ));
        let write = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&staged)?;
            file.write_all(effect.postimage.content.as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        match write {
            Ok(()) => {}
            Err(_) => {
                let _ = fs::remove_file(&staged);
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ));
            }
        }
        // Verify the staged bytes match the postimage digest exactly.
        let staged_bytes = fs::read(&staged)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        if sha256_hex(&staged_bytes) != effect.postimage.sha256
            || staged_bytes.len() as u64 != effect.postimage.bytes
        {
            let _ = fs::remove_file(&staged);
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::IoFailed,
            ));
        }
        Ok(())
    }

    /// `commit <effectId>` — re-verify the target digest, then atomically
    /// install the staged postimage. A crash between install and ack is
    /// represented by the recovery artifact name in the commit result.
    pub fn commit(
        &mut self,
        effect_id: &str,
    ) -> Result<SubagentFileMutationCommit, SubagentFileMutatorError> {
        let current = self.state.clone();
        let ClientState::Prepared { effect } = current else {
            return Err(invalid());
        };
        if effect.effect_id != effect_id {
            return Err(invalid());
        }
        self.verify_root()?;
        let target = Path::new(&self.workspace_root.canonical_path).join(&effect.relative_path);
        let target = resolve_in_root(Path::new(&self.workspace_root.canonical_path), &target)
            .ok_or_else(invalid)?;
        let current_digest = match fs::read(&target) {
            Ok(bytes) => Some(sha256_hex(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ))
            }
        };
        match (&effect.expected_revision, &current_digest) {
            (None, None) => {}
            (Some(expected), Some(current)) if expected == current => {}
            _ => {
                self.state = ClientState::Idle;
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Conflict,
                ));
            }
        }
        // The staged file is already fsynced from prepare; install it.
        let parent = target.parent().ok_or_else(invalid)?;
        let recovery_name = self
            .find_recovery_artifact(parent, &effect.effect_id)
            .ok_or_else(|| {
                self.state = ClientState::Indeterminate {
                    effect: effect.clone(),
                    recovery_name: None,
                };
                SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate)
            })?;
        let staged = parent.join(&recovery_name);
        // Re-verify staged content before install.
        let staged_bytes = match fs::read(&staged) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.state = ClientState::Indeterminate {
                    effect: effect.clone(),
                    recovery_name: None,
                };
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
        };
        if sha256_hex(&staged_bytes) != effect.postimage.sha256
            || staged_bytes.len() as u64 != effect.postimage.bytes
        {
            self.state = ClientState::Indeterminate {
                effect: effect.clone(),
                recovery_name: None,
            };
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Indeterminate,
            ));
        }
        if fs::rename(&staged, &target).is_err() {
            self.state = ClientState::Indeterminate {
                effect: effect.clone(),
                recovery_name: None,
            };
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Indeterminate,
            ));
        }
        sync_path(parent)?;
        // A new file gets a `none` recovery name (nothing to preserve); an
        // existing file keeps its recovery artifact until finalize confirms.
        let recovery_name = if effect.expected_revision.is_none() {
            None
        } else {
            Some(recovery_name)
        };
        self.state = ClientState::Committed {
            effect: effect.clone(),
            recovery_name: recovery_name.clone(),
        };
        Ok(SubagentFileMutationCommit {
            effect_id: effect.effect_id.clone(),
            effect_digest: effect.effect_digest.clone(),
            postimage_sha256: effect.postimage.sha256.clone(),
            postimage_bytes: effect.postimage.bytes,
            recovery_name,
        })
    }

    /// Locate the unique staged artifact for an effect (create-new semantics).
    fn find_recovery_artifact(&self, parent: &Path, effect_id: &str) -> Option<String> {
        let entries = fs::read_dir(parent).ok()?;
        let mut found = None;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&format!("{RECOVERY_SUFFIX}{effect_id}-")) && name.ends_with(".tmp")
            {
                if found.is_some() {
                    return None;
                }
                found = Some(name);
            }
        }
        found
    }

    /// `finalize <effectId>` — remove the recovery artifact after commit.
    pub fn finalize(&mut self, effect_id: &str) -> Result<(), SubagentFileMutatorError> {
        let current = self.state.clone();
        let (effect, recovery_name) = match current {
            ClientState::Committed {
                effect,
                recovery_name,
            } => (effect, recovery_name),
            _ => return Err(invalid()),
        };
        if effect.effect_id != effect_id {
            return Err(invalid());
        }
        if let Some(recovery_name) = recovery_name {
            let parent = Path::new(&self.workspace_root.canonical_path)
                .join(&effect.relative_path)
                .parent()
                .expect("path has parent")
                .to_path_buf();
            let recovery = parent.join(&recovery_name);
            match fs::remove_file(&recovery) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Indeterminate,
                    ))
                }
            }
        }
        self.state = ClientState::Idle;
        Ok(())
    }

    /// `preserve <effectId>` — leave the recovery artifact as the durable
    /// evidence of an indeterminate outcome.
    pub fn preserve(&mut self, effect_id: &str) -> Result<(), SubagentFileMutatorError> {
        let current = self.state.clone();
        match current {
            ClientState::Committed { effect, .. } | ClientState::Indeterminate { effect, .. } => {
                if effect.effect_id != effect_id {
                    return Err(invalid());
                }
                self.state = ClientState::Idle;
                Ok(())
            }
            _ => Err(invalid()),
        }
    }

    /// `cancel <effectId>` — remove the staged artifact for a prepared mutation.
    pub fn cancel(&mut self, effect_id: &str) -> Result<(), SubagentFileMutatorError> {
        let current = self.state.clone();
        let effect = match current {
            ClientState::Inspected { inspection } => {
                if inspection.effect_id != effect_id {
                    return Err(invalid());
                }
                None
            }
            ClientState::Prepared { effect } => {
                if effect.effect_id != effect_id {
                    return Err(invalid());
                }
                Some(effect)
            }
            _ => return Err(invalid()),
        };
        if let Some(effect) = effect {
            let parent = Path::new(&self.workspace_root.canonical_path)
                .join(&effect.relative_path)
                .parent()
                .expect("path has parent")
                .to_path_buf();
            if let Some(recovery_name) = self.find_recovery_artifact(&parent, &effect.effect_id) {
                let _ = fs::remove_file(parent.join(recovery_name));
            }
        }
        self.state = ClientState::Idle;
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), SubagentFileMutatorError> {
        if self.state == ClientState::Closed {
            return Ok(());
        }
        match self.state.clone() {
            ClientState::Inspected { inspection } => {
                let _ = self.cancel(&inspection.effect_id);
            }
            ClientState::Prepared { effect } => {
                let _ = self.cancel(&effect.effect_id);
            }
            ClientState::Committed { .. } | ClientState::Indeterminate { .. } => {
                // Preserve evidence on close.
            }
            _ => {}
        }
        self.state = ClientState::Closed;
        Ok(())
    }
}

fn sync_path(target: &Path) -> Result<(), SubagentFileMutatorError> {
    fs::File::open(target)
        .and_then(|handle| handle.sync_all())
        .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))
}

/// Resolve a child path inside the root; refuse traversal.
fn resolve_in_root(root: &Path, target: &Path) -> Option<PathBuf> {
    let canonical_root = fs::canonicalize(root).ok()?;
    let parent = target.parent()?;
    let canonical_parent = fs::canonicalize(parent).ok()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return None;
    }
    Some(canonical_parent.join(target.file_name()?))
}

fn uuid_like() -> String {
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

pub fn create_subagent_file_mutator_client(
    workspace_root: SubagentWorkspaceRootIdentity,
) -> Result<SubagentFileMutatorClient, SubagentFileMutatorError> {
    SubagentFileMutatorClient::new(workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_mutation::{PrepareSubagentFileWriteInput, SubagentFileMutationPreparer};

    fn workspace() -> (tempfile::TempDir, SubagentWorkspaceRootIdentity) {
        let directory = tempfile::tempdir().unwrap();
        let root =
            crate::file_mutation::pin_subagent_workspace_root(directory.path().to_str().unwrap())
                .unwrap();
        (directory, root)
    }

    #[test]
    fn write_commit_lifecycle_is_atomic_and_digest_pinned() {
        let (_directory, root) = workspace();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        assert_eq!(inspection.expected_revision, None);
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "hello\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let commit = client.commit("effect-1").unwrap();
        assert!(commit.recovery_name.is_none());
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&root.canonical_path).join("file.txt"))
                .unwrap(),
            "hello\n"
        );
        client.close().unwrap();
    }

    #[test]
    fn commit_refuses_when_the_file_changed_after_inspection() {
        let (directory, root) = workspace();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "hello\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        // An external writer changes the target between inspection and commit.
        std::fs::write(
            std::path::Path::new(&root.canonical_path).join("file.txt"),
            "changed by someone else\n",
        )
        .unwrap();
        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
        assert!(client.current_state() == ClientState::Idle);
        let _ = directory;
    }

    #[test]
    fn edit_replaces_exactly_one_occurrence() {
        let (directory, root) = workspace();
        std::fs::write(
            std::path::Path::new(&root.canonical_path).join("file.txt"),
            "a\nb\na\n",
        )
        .unwrap();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        assert!(inspection.expected_revision.is_some());
        let effect = preparer
            .prepare_edit(&crate::file_mutation::PrepareSubagentFileEditInput {
                inspection,
                old_string: "b".to_string(),
                new_string: "B".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let commit = client.commit("effect-1").unwrap();
        assert!(commit.recovery_name.is_some());
        // finalize removes the recovery artifact.
        client.finalize("effect-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&root.canonical_path).join("file.txt"))
                .unwrap(),
            "a\nB\na\n"
        );
        let _ = directory;
    }

    #[test]
    fn cancel_removes_the_staged_artifact() {
        let (directory, root) = workspace();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "hello\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        client.cancel("effect-1").unwrap();
        assert!(client.current_state() == ClientState::Idle);
        // No file was created.
        assert!(!std::path::Path::new(&root.canonical_path)
            .join("file.txt")
            .exists());
        let _ = directory;
    }

    #[test]
    fn state_machine_guards_every_transition() {
        let (directory, root) = workspace();
        let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
        // commit before inspect fails.
        assert!(client.commit("effect-1").is_err());
        client.inspect("effect-1", "file.txt").unwrap();
        // commit while inspected fails.
        assert!(client.commit("effect-1").is_err());
        let _ = directory;
    }
}
