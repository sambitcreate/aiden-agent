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

use std::ffi::{CString, OsStr, OsString};
use std::fs::File;
use std::io;
use std::path::{Component, Path};

#[cfg(unix)]
use std::os::fd::{AsRawFd as _, FromRawFd as _};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(unix)]
use std::os::unix::fs::{FileExt as _, MetadataExt as _};

use thiserror::Error;

use crate::file_mutation::{
    assert_prepared_subagent_file_mutation, assert_subagent_file_inspection,
    canonical_subagent_file_effect_id, canonical_subagent_file_relative_path, sha256_hex,
    PreparedSubagentFileMutation, SubagentFileInspection, SubagentWorkspaceRootIdentity,
};

const RECOVERY_SUFFIX: &str = ".aiden-subagent-file-";
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_PATH_COMPONENT_BYTES: usize = 255;
const MAX_PROVENANCE_BYTES: usize = 256;
const PROVENANCE_XATTR: &[u8] = b"com.apple.provenance\0";

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
    root: File,
    retained: Option<RetainedTarget>,
    staged: Option<StagedArtifact>,
    state: ClientState,
    uuid: Box<dyn Fn() -> String + Send + Sync>,
    #[cfg(test)]
    before_install: Option<Box<dyn FnMut() -> io::Result<()> + Send>>,
    #[cfg(test)]
    after_exchange: Option<Box<dyn FnMut() -> io::Result<()> + Send>>,
    #[cfg(test)]
    after_stage_write: Option<Box<dyn FnMut(&File, &OsStr, &File) -> io::Result<()> + Send>>,
}

struct RetainedTarget {
    parent: File,
    parent_identity: DirectoryIdentity,
    leaf: OsString,
    expected: Option<File>,
    expected_identity: Option<FileIdentity>,
    expected_provenance: Option<Vec<u8>>,
}

struct StagedArtifact {
    name: OsString,
    file: File,
    identity: FileIdentity,
    provenance: Option<Vec<u8>>,
}

struct StageGuard<'a> {
    parent: &'a File,
    name: OsString,
    file: Option<File>,
    initial_identity: FileIdentity,
}

impl StageGuard<'_> {
    fn file(&self) -> Result<&File, SubagentFileMutatorError> {
        self.file
            .as_ref()
            .ok_or_else(|| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))
    }

    fn file_mut(&mut self) -> Result<&mut File, SubagentFileMutatorError> {
        self.file
            .as_mut()
            .ok_or_else(|| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))
    }

    fn disarm(
        mut self,
        identity: FileIdentity,
        provenance: Option<Vec<u8>>,
    ) -> Result<StagedArtifact, SubagentFileMutatorError> {
        let file = self
            .file
            .take()
            .ok_or_else(|| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        Ok(StagedArtifact {
            name: self.name.clone(),
            file,
            identity,
            provenance,
        })
    }
}

impl Drop for StageGuard<'_> {
    fn drop(&mut self) {
        if self.file.is_some() {
            let _ = unlink_named_if_identity(self.parent, &self.name, &self.initial_identity);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    links: u64,
    uid: u32,
    gid: u32,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    #[cfg(target_os = "macos")]
    flags: u32,
    #[cfg(target_os = "macos")]
    birth_seconds: i64,
    #[cfg(target_os = "macos")]
    birth_nanoseconds: i64,
}

impl Drop for SubagentFileMutatorClient {
    fn drop(&mut self) {
        // Future cancellation and channel loss may unwind the host broker
        // before its explicit cleanup path runs. Closing here removes only an
        // uncommitted staged artifact; committed/indeterminate evidence is
        // deliberately preserved by `close`.
        let _ = self.close();
    }
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
        let root = open_root_no_follow(Path::new(&workspace_root.canonical_path))
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let root_identity = directory_identity(&root)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        if root_identity.device.to_string() != workspace_root.device
            || root_identity.inode.to_string() != workspace_root.inode
        {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        Ok(SubagentFileMutatorClient {
            workspace_root,
            root,
            retained: None,
            staged: None,
            state: ClientState::Idle,
            uuid: Box::new(uuid_like),
            #[cfg(test)]
            before_install: None,
            #[cfg(test)]
            after_exchange: None,
            #[cfg(test)]
            after_stage_write: None,
        })
    }

    pub fn current_state(&self) -> ClientState {
        self.state.clone()
    }

    #[cfg(test)]
    fn set_before_install(&mut self, hook: impl FnMut() -> io::Result<()> + Send + 'static) {
        self.before_install = Some(Box::new(hook));
    }

    #[cfg(test)]
    fn set_after_exchange(&mut self, hook: impl FnMut() -> io::Result<()> + Send + 'static) {
        self.after_exchange = Some(Box::new(hook));
    }

    #[cfg(test)]
    fn set_after_stage_write(
        &mut self,
        hook: impl FnMut(&File, &OsStr, &File) -> io::Result<()> + Send + 'static,
    ) {
        self.after_stage_write = Some(Box::new(hook));
    }

    fn verify_root(&self) -> Result<(), SubagentFileMutatorError> {
        let current = open_root_no_follow(Path::new(&self.workspace_root.canonical_path))
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict))?;
        let retained = directory_identity(&self.root)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict))?;
        let current = directory_identity(&current)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict))?;
        if retained != current
            || retained.device.to_string() != self.workspace_root.device
            || retained.inode.to_string() != self.workspace_root.inode
        {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        Ok(())
    }

    fn revalidate_parent(&self, relative_path: &str) -> Result<(), SubagentFileMutatorError> {
        self.verify_root()?;
        let retained = self.retained.as_ref().ok_or_else(invalid)?;
        let (current, leaf) = open_parent_no_follow(&self.root, relative_path)?;
        let current_identity = directory_identity(&current)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        if leaf != retained.leaf || current_identity != retained.parent_identity {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        Ok(())
    }

    fn revalidate_expected(
        &self,
        expected_digest: Option<&str>,
    ) -> Result<(), SubagentFileMutatorError> {
        let retained = self.retained.as_ref().ok_or_else(invalid)?;
        match (
            &retained.expected,
            &retained.expected_identity,
            expected_digest,
        ) {
            (None, None, None) => match open_child_no_follow(&retained.parent, &retained.leaf) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                _ => Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Conflict,
                )),
            },
            (Some(expected), Some(expected_identity), Some(expected_digest)) => {
                let (retained_bytes, retained_identity) = read_verified_descriptor(expected)?;
                let current =
                    open_child_no_follow(&retained.parent, &retained.leaf).map_err(|_| {
                        SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict)
                    })?;
                let (_, current_identity) = read_verified_descriptor(&current)?;
                if &retained_identity != expected_identity
                    || current_identity != *expected_identity
                    || sha256_hex(&retained_bytes) != expected_digest
                    || supported_provenance(expected, &retained_identity)?
                        != retained.expected_provenance
                {
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Conflict,
                    ));
                }
                Ok(())
            }
            _ => Err(invalid()),
        }
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
        let (parent, leaf) = open_parent_no_follow(&self.root, &relative_path)?;
        let parent_identity = directory_identity(&parent)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let expected = match open_child_no_follow(&parent, &leaf) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Conflict,
                ))
            }
        };
        let (inspection, expected_identity, expected_provenance) = match expected.as_ref() {
            Some(file) => {
                let (bytes, identity) = read_verified_descriptor(file)?;
                let provenance = supported_provenance(file, &identity)?;
                let content = String::from_utf8(bytes).map_err(|_| invalid())?;
                let inspection = SubagentFileInspection {
                    version: 1,
                    effect_id: effect_id.clone(),
                    workspace_root: self.workspace_root.clone(),
                    relative_path: relative_path.clone(),
                    expected_revision: Some(sha256_hex(content.as_bytes())),
                    current_content: Some(content),
                };
                (inspection, Some(identity), provenance)
            }
            None => (
                SubagentFileInspection {
                    version: 1,
                    effect_id,
                    workspace_root: self.workspace_root.clone(),
                    relative_path,
                    expected_revision: None,
                    current_content: None,
                },
                None,
                None,
            ),
        };
        assert_subagent_file_inspection(&inspection)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        self.retained = Some(RetainedTarget {
            parent,
            parent_identity,
            leaf,
            expected,
            expected_identity,
            expected_provenance,
        });
        self.state = ClientState::Inspected {
            inspection: inspection.clone(),
        };
        Ok(inspection)
    }

    /// Validate and retain the prepared postimage without writing it into the
    /// workspace. The descriptor-relative recovery artifact is created only by
    /// `commit`, after the attended approval has been granted.
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
        self.revalidate_parent(&effect.relative_path)?;
        self.revalidate_expected(effect.expected_revision.as_deref())?;
        self.state = ClientState::Prepared {
            effect: effect.clone(),
        };
        Ok(())
    }

    /// Stage the postimage beside the target (create-new, 0600, fsync).
    fn stage_and_verify(
        &mut self,
        effect: &PreparedSubagentFileMutation,
    ) -> Result<StagedArtifact, SubagentFileMutatorError> {
        let retained = self.retained.as_ref().ok_or_else(invalid)?;
        let staged_name = OsString::from(format!(
            "{RECOVERY_SUFFIX}{}-{}.tmp",
            effect.effect_id,
            (self.uuid)()
        ));
        let file = create_child_exclusive(&retained.parent, &staged_name)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let initial_identity = file_identity(&file)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let mut guard = StageGuard {
            parent: &retained.parent,
            name: staged_name,
            file: Some(file),
            initial_identity,
        };
        {
            use std::io::Write as _;
            guard
                .file_mut()?
                .write_all(effect.postimage.content.as_bytes())
                .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        }
        let mode = retained
            .expected_identity
            .as_ref()
            .map_or(0o644, |identity| identity.mode & 0o7777);
        set_descriptor_mode(guard.file()?, mode)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        if retained.expected.is_some() {
            copy_supported_provenance(retained.expected_provenance.as_deref(), guard.file()?)
                .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        }
        guard
            .file()?
            .sync_all()
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        #[cfg(test)]
        if let Some(after_stage_write) = self.after_stage_write.as_deref_mut() {
            after_stage_write(guard.parent, &guard.name, guard.file()?)
                .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        }
        let (staged_bytes, identity) = read_verified_descriptor(guard.file()?)?;
        let provenance = supported_provenance(guard.file()?, &identity)?;
        if sha256_hex(&staged_bytes) != effect.postimage.sha256
            || staged_bytes.len() as u64 != effect.postimage.bytes
            || (retained.expected.is_some() && retained.expected_provenance != provenance)
            || retained
                .expected_identity
                .as_ref()
                .is_some_and(|expected| !same_preserved_metadata(expected, &identity))
        {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::IoFailed,
            ));
        }
        guard.disarm(identity, provenance)
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
        self.revalidate_parent(&effect.relative_path)?;
        if let Err(error) = self.revalidate_expected(effect.expected_revision.as_deref()) {
            let _ = self.discard_prepared_artifact();
            return Err(error);
        }
        let staged = match self.stage_and_verify(&effect) {
            Ok(staged) => staged,
            Err(error) => {
                self.clear_io();
                self.state = ClientState::Idle;
                return Err(error);
            }
        };
        self.staged = Some(staged);
        let retained = self.retained.as_ref().ok_or_else(invalid)?;
        let staged = self.staged.as_ref().ok_or_else(invalid)?;
        let parent = retained
            .parent
            .try_clone()
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let leaf = retained.leaf.clone();
        let expected = retained
            .expected
            .as_ref()
            .map(File::try_clone)
            .transpose()
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let expected_identity = retained.expected_identity.clone();
        let expected_provenance = retained.expected_provenance.clone();
        let staged_name = staged.name.clone();
        let staged_file = staged
            .file
            .try_clone()
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        let staged_identity = staged.identity.clone();
        let staged_provenance = staged.provenance.clone();

        let (_, named_stage_identity, named_stage_provenance) =
            verify_named_file(&parent, &staged_name, &effect.postimage.sha256)?;
        if named_stage_identity != staged_identity || named_stage_provenance != staged_provenance {
            self.mark_indeterminate(&effect, Some(staged_name));
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Indeterminate,
            ));
        }
        #[cfg(test)]
        if let Some(before_install) = self.before_install.as_deref_mut() {
            if before_install().is_err() {
                let _ = self.discard_prepared_artifact();
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ));
            }
        }

        let recovery_name = if effect.expected_revision.is_none() {
            match atomic_install_new(&parent, &staged_name, &leaf) {
                Ok(()) => {}
                Err(error) => {
                    let _ = self.discard_prepared_artifact();
                    return Err(SubagentFileMutatorError::new(
                        if error.raw_os_error() == Some(libc::EEXIST) {
                            SubagentFileMutatorFailure::Conflict
                        } else {
                            SubagentFileMutatorFailure::IoFailed
                        },
                    ));
                }
            }
            let installed = verify_named_file(&parent, &leaf, &effect.postimage.sha256);
            let parent_live = self.revalidate_parent(&effect.relative_path).is_ok();
            let installed_valid = installed.as_ref().is_ok_and(|(_, identity, provenance)| {
                same_renamed_identity(&staged_identity, identity)
                    && provenance == &staged_provenance
            });
            if !installed_valid || !parent_live {
                let removed = installed_valid
                    && unlink_named_if_identity(&parent, &leaf, &staged_identity).is_ok()
                    && parent.sync_all().is_ok();
                if removed {
                    self.clear_io();
                    self.state = ClientState::Idle;
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Conflict,
                    ));
                }
                self.mark_indeterminate(&effect, None);
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
            if parent.sync_all().is_err() {
                self.mark_indeterminate(&effect, None);
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
            None
        } else {
            if atomic_exchange(&parent, &staged_name, &leaf).is_err() {
                let _ = self.discard_prepared_artifact();
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::IoFailed,
                ));
            }
            let displaced_entry = entry_identity_at(&parent, &staged_name).ok();
            #[cfg(test)]
            let after_exchange_ok = self
                .after_exchange
                .as_deref_mut()
                .is_none_or(|after_exchange| after_exchange().is_ok());
            #[cfg(not(test))]
            let after_exchange_ok = true;
            let installed = verify_named_file(&parent, &leaf, &effect.postimage.sha256);
            let displaced = effect
                .expected_revision
                .as_deref()
                .and_then(|digest| verify_named_file(&parent, &staged_name, digest).ok());
            let parent_live = self.revalidate_parent(&effect.relative_path).is_ok();
            let installed_valid = installed.as_ref().is_ok_and(|(_, identity, provenance)| {
                same_renamed_identity(&staged_identity, identity)
                    && provenance == &staged_provenance
            });
            let displaced_valid = displaced.as_ref().is_some_and(|(_, identity, provenance)| {
                expected_identity.as_ref().is_some_and(|expected_identity| {
                    same_renamed_identity(expected_identity, identity)
                }) && provenance == &expected_provenance
            });
            if !after_exchange_ok || !installed_valid || !displaced_valid || !parent_live {
                let rolled_back = displaced_entry.as_ref().is_some_and(|displaced_entry| {
                    rollback_exchange(
                        &parent,
                        &staged_name,
                        &leaf,
                        &staged_identity,
                        displaced_entry,
                    )
                });
                if rolled_back {
                    self.clear_io();
                    self.state = ClientState::Idle;
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Conflict,
                    ));
                }
                self.mark_indeterminate(&effect, Some(staged_name));
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
            if expected
                .as_ref()
                .zip(expected_identity.as_ref())
                .is_none_or(|(file, identity)| {
                    read_verified_descriptor(file)
                        .ok()
                        .is_none_or(|(_, current)| !same_renamed_identity(identity, &current))
                })
                || parent.sync_all().is_err()
            {
                self.mark_indeterminate(&effect, Some(staged_name));
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
            Some(staged_name.to_string_lossy().into_owned())
        };
        drop(staged_file);
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

    fn mark_indeterminate(
        &mut self,
        effect: &PreparedSubagentFileMutation,
        recovery_name: Option<OsString>,
    ) {
        self.state = ClientState::Indeterminate {
            effect: effect.clone(),
            recovery_name: recovery_name.map(|name| name.to_string_lossy().into_owned()),
        };
    }

    fn clear_io(&mut self) {
        self.staged = None;
        self.retained = None;
    }

    fn discard_prepared_artifact(&mut self) -> Result<(), SubagentFileMutatorError> {
        let result = match (self.retained.as_ref(), self.staged.as_ref()) {
            (Some(retained), Some(staged)) => {
                unlink_named_if_identity(&retained.parent, &staged.name, &staged.identity)
            }
            _ => Ok(()),
        };
        self.clear_io();
        self.state = ClientState::Idle;
        result.map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate))
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
            self.revalidate_parent(&effect.relative_path)?;
            let retained = self.retained.as_ref().ok_or_else(invalid)?;
            let expected_identity = retained.expected_identity.as_ref().ok_or_else(invalid)?;
            let expected_digest = effect.expected_revision.as_deref().ok_or_else(invalid)?;
            let (_, recovery_identity, provenance) = verify_named_file(
                &retained.parent,
                OsStr::new(&recovery_name),
                expected_digest,
            )?;
            let expected_file = retained.expected.as_ref().ok_or_else(invalid)?;
            let (expected_bytes, current_expected) = read_verified_descriptor(expected_file)?;
            if !same_renamed_identity(expected_identity, &recovery_identity)
                || !same_renamed_identity(expected_identity, &current_expected)
                || sha256_hex(&expected_bytes) != expected_digest
                || provenance != retained.expected_provenance
            {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Conflict,
                ));
            }
            unlink_named_if_identity(
                &retained.parent,
                OsStr::new(&recovery_name),
                &recovery_identity,
            )
            .map_err(|_| {
                SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate)
            })?;
            retained.parent.sync_all().map_err(|_| {
                SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate)
            })?;
        } else {
            self.revalidate_parent(&effect.relative_path)?;
            let retained = self.retained.as_ref().ok_or_else(invalid)?;
            let staged = self.staged.as_ref().ok_or_else(invalid)?;
            let (_, installed, provenance) =
                verify_named_file(&retained.parent, &retained.leaf, &effect.postimage.sha256)?;
            if !same_renamed_identity(&staged.identity, &installed)
                || provenance != staged.provenance
            {
                return Err(SubagentFileMutatorError::new(
                    SubagentFileMutatorFailure::Indeterminate,
                ));
            }
            retained.parent.sync_all().map_err(|_| {
                SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate)
            })?;
        }
        self.clear_io();
        self.state = ClientState::Idle;
        Ok(())
    }

    /// `preserve <effectId>` — leave the recovery artifact as the durable
    /// evidence of an indeterminate outcome.
    pub fn preserve(&mut self, effect_id: &str) -> Result<(), SubagentFileMutatorError> {
        let current = self.state.clone();
        match current {
            ClientState::Committed {
                effect,
                recovery_name,
            }
            | ClientState::Indeterminate {
                effect,
                recovery_name,
            } => {
                if effect.effect_id != effect_id {
                    return Err(invalid());
                }
                let Some(recovery_name) = recovery_name else {
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Indeterminate,
                    ));
                };
                let retained = self.retained.as_ref().ok_or_else(invalid)?;
                let expected_identity = retained.expected_identity.as_ref().ok_or_else(invalid)?;
                let expected_digest = effect.expected_revision.as_deref().ok_or_else(invalid)?;
                let (_, recovery_identity, provenance) = verify_named_file(
                    &retained.parent,
                    OsStr::new(&recovery_name),
                    expected_digest,
                )?;
                if !same_renamed_identity(expected_identity, &recovery_identity)
                    || provenance != retained.expected_provenance
                {
                    return Err(SubagentFileMutatorError::new(
                        SubagentFileMutatorFailure::Conflict,
                    ));
                }
                retained.parent.sync_all().map_err(|_| {
                    SubagentFileMutatorError::new(SubagentFileMutatorFailure::Indeterminate)
                })?;
                self.clear_io();
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
        if effect.is_some() {
            self.discard_prepared_artifact()?;
        } else {
            self.clear_io();
            self.state = ClientState::Idle;
        }
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
        self.clear_io();
        self.state = ClientState::Closed;
        Ok(())
    }
}

#[cfg(unix)]
fn open_root_no_follow(path: &Path) -> io::Result<File> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "root contains null"))?;
    // SAFETY: `path` is a live terminated C string and the returned descriptor
    // becomes uniquely owned by File on success.
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    owned_descriptor(descriptor)
}

#[cfg(not(unix))]
fn open_root_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "descriptor-relative workspace mutation is unavailable",
    ))
}

#[cfg(unix)]
fn open_parent_no_follow(
    root: &File,
    relative_path: &str,
) -> Result<(File, OsString), SubagentFileMutatorError> {
    let path = Path::new(relative_path);
    if path.is_absolute() || relative_path.contains('\0') {
        return Err(invalid());
    }
    let components = path.components().collect::<Vec<_>>();
    if components.is_empty() || components.len() > MAX_PATH_COMPONENTS {
        return Err(invalid());
    }
    let mut names = Vec::with_capacity(components.len());
    for component in components {
        let Component::Normal(name) = component else {
            return Err(invalid());
        };
        if name.as_bytes().is_empty()
            || name.as_bytes().len() > MAX_PATH_COMPONENT_BYTES
            || name.as_bytes().starts_with(RECOVERY_SUFFIX.as_bytes())
        {
            return Err(invalid());
        }
        names.push(name.to_os_string());
    }
    let leaf = names.pop().ok_or_else(invalid)?;
    let mut current = duplicate_descriptor(root)
        .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
    for name in names {
        current = open_directory_at(&current, &name).map_err(|error| {
            SubagentFileMutatorError::new(
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ELOOP | libc::ENOTDIR | libc::ENOENT)
                ) {
                    SubagentFileMutatorFailure::Conflict
                } else {
                    SubagentFileMutatorFailure::IoFailed
                },
            )
        })?;
    }
    Ok((current, leaf))
}

#[cfg(not(unix))]
fn open_parent_no_follow(
    _root: &File,
    _relative_path: &str,
) -> Result<(File, OsString), SubagentFileMutatorError> {
    Err(SubagentFileMutatorError::new(
        SubagentFileMutatorFailure::IoFailed,
    ))
}

#[cfg(unix)]
fn duplicate_descriptor(file: &File) -> io::Result<File> {
    let descriptor = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    owned_descriptor(descriptor)
}

#[cfg(unix)]
fn open_directory_at(parent: &File, name: &OsStr) -> io::Result<File> {
    openat_owned(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
}

#[cfg(unix)]
fn open_child_no_follow(parent: &File, name: &OsStr) -> io::Result<File> {
    let file = openat_owned(
        parent,
        name,
        libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace target is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn create_child_exclusive(parent: &File, name: &OsStr) -> io::Result<File> {
    openat_owned(
        parent,
        name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
}

#[cfg(unix)]
fn openat_owned(parent: &File, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    // SAFETY: the parent descriptor and terminated name remain valid for the
    // call; ownership of a successful descriptor transfers into File.
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
    owned_descriptor(descriptor)
}

#[cfg(unix)]
fn owned_descriptor(descriptor: i32) -> io::Result<File> {
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: a successful open/dup returned a uniquely owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn unlink_child(parent: &File, name: &OsStr) -> io::Result<()> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    // SAFETY: descriptor/name are valid and flags=0 requests file unlink.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn set_descriptor_mode(file: &File, mode: u32) -> io::Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn directory_identity(file: &File) -> io::Result<DirectoryIdentity> {
    let metadata = file.metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace parent is not a directory",
        ));
    }
    Ok(DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
fn directory_identity(_file: &File) -> io::Result<DirectoryIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "descriptor identity is unavailable",
    ))
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let metadata = file.metadata()?;
    #[cfg(target_os = "macos")]
    use std::os::macos::fs::MetadataExt as _;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        links: metadata.nlink(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        size: metadata.size(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
        #[cfg(target_os = "macos")]
        flags: metadata.st_flags(),
        #[cfg(target_os = "macos")]
        birth_seconds: metadata.st_birthtime(),
        #[cfg(target_os = "macos")]
        birth_nanoseconds: metadata.st_birthtime_nsec(),
    })
}

#[cfg(target_os = "macos")]
fn entry_identity_at(parent: &File, name: &OsStr) -> io::Result<FileIdentity> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    let mut identity = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the retained parent descriptor and terminated component name are
    // valid, and `identity` points to writable storage for one `stat` value.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            identity.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful `fstatat` initialized the entire structure.
    let identity = unsafe { identity.assume_init() };
    Ok(FileIdentity {
        device: identity.st_dev as u64,
        inode: identity.st_ino,
        mode: u32::from(identity.st_mode),
        links: u64::from(identity.st_nlink),
        uid: identity.st_uid,
        gid: identity.st_gid,
        size: identity.st_size as u64,
        modified_seconds: identity.st_mtime,
        modified_nanoseconds: identity.st_mtime_nsec,
        changed_seconds: identity.st_ctime,
        changed_nanoseconds: identity.st_ctime_nsec,
        flags: identity.st_flags,
        birth_seconds: identity.st_birthtime,
        birth_nanoseconds: identity.st_birthtime_nsec,
    })
}

#[cfg(target_os = "linux")]
fn entry_identity_at(parent: &File, name: &OsStr) -> io::Result<FileIdentity> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    let mut identity = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: see the macOS implementation above.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            identity.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful `fstatat` initialized the entire structure.
    let identity = unsafe { identity.assume_init() };
    Ok(FileIdentity {
        device: identity.st_dev,
        inode: identity.st_ino,
        mode: identity.st_mode,
        links: identity.st_nlink,
        uid: identity.st_uid,
        gid: identity.st_gid,
        size: identity.st_size as u64,
        modified_seconds: identity.st_mtime,
        modified_nanoseconds: identity.st_mtime_nsec,
        changed_seconds: identity.st_ctime,
        changed_nanoseconds: identity.st_ctime_nsec,
    })
}

fn exclusive_regular(identity: &FileIdentity) -> bool {
    identity.mode & u32::from(libc::S_IFMT) == u32::from(libc::S_IFREG) && identity.links == 1
}

fn same_file_object(left: &FileIdentity, right: &FileIdentity) -> bool {
    exclusive_regular(left)
        && exclusive_regular(right)
        && left.device == right.device
        && left.inode == right.inode
}

fn same_preserved_metadata(left: &FileIdentity, right: &FileIdentity) -> bool {
    left.mode == right.mode && left.uid == right.uid && left.gid == right.gid && {
        #[cfg(target_os = "macos")]
        {
            left.flags == right.flags
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }
}

fn same_renamed_identity(left: &FileIdentity, right: &FileIdentity) -> bool {
    same_file_object(left, right)
        && left.mode == right.mode
        && left.uid == right.uid
        && left.gid == right.gid
        && left.size == right.size
        && left.modified_seconds == right.modified_seconds
        && left.modified_nanoseconds == right.modified_nanoseconds
        && {
            #[cfg(target_os = "macos")]
            {
                left.flags == right.flags
                    && left.birth_seconds == right.birth_seconds
                    && left.birth_nanoseconds == right.birth_nanoseconds
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        }
}

fn same_renamed_entry(left: &FileIdentity, right: &FileIdentity) -> bool {
    left.device == right.device
        && left.inode == right.inode
        && left.mode == right.mode
        && left.links == right.links
        && left.uid == right.uid
        && left.gid == right.gid
        && left.size == right.size
        && left.modified_seconds == right.modified_seconds
        && left.modified_nanoseconds == right.modified_nanoseconds
        && {
            #[cfg(target_os = "macos")]
            {
                left.flags == right.flags
                    && left.birth_seconds == right.birth_seconds
                    && left.birth_nanoseconds == right.birth_nanoseconds
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        }
}

fn verify_named_file(
    parent: &File,
    name: &OsStr,
    expected_digest: &str,
) -> Result<(File, FileIdentity, Option<Vec<u8>>), SubagentFileMutatorError> {
    let file = open_child_no_follow(parent, name)
        .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::Conflict))?;
    let (bytes, identity) = read_verified_descriptor(&file)?;
    let provenance = supported_provenance(&file, &identity)?;
    if sha256_hex(&bytes) != expected_digest {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::Conflict,
        ));
    }
    Ok((file, identity, provenance))
}

fn unlink_named_if_identity(
    parent: &File,
    name: &OsStr,
    expected: &FileIdentity,
) -> io::Result<()> {
    let named = open_child_no_follow(parent, name)?;
    let identity = file_identity(&named)?;
    if !same_file_object(expected, &identity) {
        return Err(io::Error::other("workspace file identity changed"));
    }
    unlink_child(parent, name)
}

#[cfg(target_os = "macos")]
fn atomic_exchange(parent: &File, staged: &OsStr, destination: &OsStr) -> io::Result<()> {
    use std::os::raw::{c_char, c_int};
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: u32,
        ) -> c_int;
    }
    const RENAME_SWAP: u32 = 0x0000_0002;
    renameatx(parent, staged, destination, RENAME_SWAP, renameatx_np)
}

#[cfg(target_os = "macos")]
fn atomic_install_new(parent: &File, staged: &OsStr, destination: &OsStr) -> io::Result<()> {
    use std::os::raw::{c_char, c_int};
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: u32,
        ) -> c_int;
    }
    const RENAME_EXCL: u32 = 0x0000_0004;
    renameatx(parent, staged, destination, RENAME_EXCL, renameatx_np)
}

#[cfg(target_os = "macos")]
fn renameatx(
    parent: &File,
    source: &OsStr,
    destination: &OsStr,
    flags: u32,
    operation: unsafe extern "C" fn(i32, *const i8, i32, *const i8, u32) -> i32,
) -> io::Result<()> {
    let source = CString::new(source.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source contains null"))?;
    let destination = CString::new(destination.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination contains null"))?;
    let descriptor = parent.as_raw_fd();
    // SAFETY: both C strings and the retained parent descriptor remain valid
    // for the atomic rename operation.
    if unsafe {
        operation(
            descriptor,
            source.as_ptr(),
            descriptor,
            destination.as_ptr(),
            flags,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn atomic_exchange(parent: &File, staged: &OsStr, destination: &OsStr) -> io::Result<()> {
    renameat2(parent, staged, destination, libc::RENAME_EXCHANGE)
}

#[cfg(target_os = "linux")]
fn atomic_install_new(parent: &File, staged: &OsStr, destination: &OsStr) -> io::Result<()> {
    renameat2(parent, staged, destination, libc::RENAME_NOREPLACE)
}

#[cfg(target_os = "linux")]
fn renameat2(parent: &File, source: &OsStr, destination: &OsStr, flags: u32) -> io::Result<()> {
    let source = CString::new(source.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source contains null"))?;
    let destination = CString::new(destination.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination contains null"))?;
    let descriptor = parent.as_raw_fd();
    if unsafe {
        libc::renameat2(
            descriptor,
            source.as_ptr(),
            descriptor,
            destination.as_ptr(),
            flags,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_exchange(_parent: &File, _staged: &OsStr, _destination: &OsStr) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic exchange is unavailable",
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_install_new(_parent: &File, _staged: &OsStr, _destination: &OsStr) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace install is unavailable",
    ))
}

fn rollback_exchange(
    parent: &File,
    staged: &OsStr,
    destination: &OsStr,
    staged_identity: &FileIdentity,
    displaced_entry: &FileIdentity,
) -> bool {
    if atomic_exchange(parent, staged, destination).is_err() {
        return false;
    }
    let restored = entry_identity_at(parent, destination).ok();
    let staged_after = entry_identity_at(parent, staged).ok();
    if restored
        .as_ref()
        .is_none_or(|identity| !same_renamed_entry(displaced_entry, identity))
        || staged_after
            .as_ref()
            .is_none_or(|identity| !same_file_object(staged_identity, identity))
        || unlink_named_if_identity(parent, staged, staged_identity).is_err()
    {
        return false;
    }
    parent.sync_all().is_ok()
}

#[cfg(unix)]
fn read_verified_descriptor(
    file: &File,
) -> Result<(Vec<u8>, FileIdentity), SubagentFileMutatorError> {
    let before = file_identity(file)
        .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
    if !exclusive_regular(&before)
        || before.size > crate::file_mutation::MAX_SUBAGENT_FILE_CONTENT_BYTES as u64
    {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::Conflict,
        ));
    }
    let mut bytes = vec![0; before.size as usize];
    let mut offset = 0usize;
    while offset < bytes.len() {
        let count = file
            .read_at(&mut bytes[offset..], offset as u64)
            .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
        if count == 0 {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        offset += count;
    }
    let after = file_identity(file)
        .map_err(|_| SubagentFileMutatorError::new(SubagentFileMutatorFailure::IoFailed))?;
    if before != after {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::Conflict,
        ));
    }
    Ok((bytes, after))
}

#[cfg(not(unix))]
fn read_verified_descriptor(
    _file: &File,
) -> Result<(Vec<u8>, FileIdentity), SubagentFileMutatorError> {
    Err(SubagentFileMutatorError::new(
        SubagentFileMutatorFailure::IoFailed,
    ))
}

#[cfg(target_os = "macos")]
fn supported_provenance(
    file: &File,
    identity: &FileIdentity,
) -> Result<Option<Vec<u8>>, SubagentFileMutatorError> {
    if identity.flags != 0 || !exclusive_regular(identity) {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::Conflict,
        ));
    }
    let descriptor = file.as_raw_fd();
    // SAFETY: all calls use the live descriptor and either null buffers for
    // sizing or correctly sized owned buffers.
    let names_length = unsafe { libc::flistxattr(descriptor, std::ptr::null_mut(), 0, 0) };
    if !(0..=4096).contains(&names_length) {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::IoFailed,
        ));
    }
    let provenance = if names_length == 0 {
        None
    } else {
        let mut names = vec![0u8; names_length as usize];
        let read =
            unsafe { libc::flistxattr(descriptor, names.as_mut_ptr().cast(), names.len(), 0) };
        if read != names_length || names.as_slice() != PROVENANCE_XATTR {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        let length = unsafe {
            libc::fgetxattr(
                descriptor,
                PROVENANCE_XATTR.as_ptr().cast(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        if length < 0 || length as usize > MAX_PROVENANCE_BYTES {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::Conflict,
            ));
        }
        let mut value = vec![0; length as usize];
        let read = unsafe {
            libc::fgetxattr(
                descriptor,
                PROVENANCE_XATTR.as_ptr().cast(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if read != length {
            return Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::IoFailed,
            ));
        }
        Some(value)
    };
    if descriptor_has_extended_acl(descriptor)? {
        return Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::Conflict,
        ));
    }
    Ok(provenance)
}

#[cfg(target_os = "macos")]
fn descriptor_has_extended_acl(descriptor: i32) -> Result<bool, SubagentFileMutatorError> {
    use std::os::raw::{c_int, c_void};
    unsafe extern "C" {
        fn acl_get_fd_np(fd: c_int, acl_type: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_free(object: *mut c_void) -> c_int;
        fn __error() -> *mut c_int;
    }
    const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: c_int = 0;
    // SAFETY: the descriptor is live and the returned ACL is released once.
    let acl = unsafe { acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(false)
        } else {
            Err(SubagentFileMutatorError::new(
                SubagentFileMutatorFailure::IoFailed,
            ))
        };
    }
    let mut entry = std::ptr::null_mut();
    unsafe { *__error() = 0 };
    let result = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) };
    let error = io::Error::last_os_error();
    let _ = unsafe { acl_free(acl) };
    if result == 0 {
        Ok(true)
    } else if error.raw_os_error() == Some(libc::EINVAL) {
        Ok(false)
    } else {
        Err(SubagentFileMutatorError::new(
            SubagentFileMutatorFailure::IoFailed,
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn supported_provenance(
    _file: &File,
    _identity: &FileIdentity,
) -> Result<Option<Vec<u8>>, SubagentFileMutatorError> {
    // Other platforms require an audited ACL/xattr implementation before
    // privileged child writes may be enabled.
    Err(SubagentFileMutatorError::new(
        SubagentFileMutatorFailure::IoFailed,
    ))
}

#[cfg(target_os = "macos")]
fn copy_supported_provenance(value: Option<&[u8]>, destination: &File) -> io::Result<()> {
    let descriptor = destination.as_raw_fd();
    if let Some(value) = value {
        let result = unsafe {
            libc::fsetxattr(
                descriptor,
                PROVENANCE_XATTR.as_ptr().cast(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        return if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }
    let identity = file_identity(destination)?;
    let current = supported_provenance(destination, &identity)
        .map_err(|_| io::Error::other("staged metadata could not be verified"))?;
    if current.is_none() {
        return Ok(());
    }
    let result = unsafe { libc::fremovexattr(descriptor, PROVENANCE_XATTR.as_ptr().cast(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_supported_provenance(_value: Option<&[u8]>, _destination: &File) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "workspace metadata preservation is unavailable",
    ))
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
    use std::sync::Arc;

    fn workspace() -> (tempfile::TempDir, SubagentWorkspaceRootIdentity) {
        let directory = tempfile::tempdir().unwrap();
        let root =
            crate::file_mutation::pin_subagent_workspace_root(directory.path().to_str().unwrap())
                .unwrap();
        (directory, root)
    }

    fn recovery_names(root: &Path) -> Vec<OsString> {
        std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| name.as_bytes().starts_with(RECOVERY_SUFFIX.as_bytes()))
            .collect()
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
    fn prepare_and_cancel_never_write_an_unapproved_recovery_artifact() {
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
        assert!(recovery_names(Path::new(&root.canonical_path)).is_empty());
        client.cancel("effect-1").unwrap();
        assert!(client.current_state() == ClientState::Idle);
        assert!(recovery_names(Path::new(&root.canonical_path)).is_empty());
        // No file was created.
        assert!(!std::path::Path::new(&root.canonical_path)
            .join("file.txt")
            .exists());
        let _ = directory;
    }

    #[cfg(unix)]
    #[test]
    fn symlink_hardlink_and_non_regular_targets_fail_closed_without_disclosure() {
        use std::os::unix::fs::symlink;

        let (directory, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("private.txt");
        std::fs::write(&outside_file, "outside secret\n").unwrap();
        symlink(&outside_file, directory.path().join("symlink.txt")).unwrap();
        std::fs::write(directory.path().join("linked.txt"), "linked\n").unwrap();
        std::fs::hard_link(
            directory.path().join("linked.txt"),
            directory.path().join("linked-copy.txt"),
        )
        .unwrap();
        std::fs::create_dir(directory.path().join("directory.txt")).unwrap();

        for path in ["symlink.txt", "linked.txt", "directory.txt"] {
            let mut client = SubagentFileMutatorClient::new(root.clone()).unwrap();
            let error = client.inspect("effect-1", path).unwrap_err();
            assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
            assert!(!error.to_string().contains("outside secret"));
            assert!(!error.to_string().contains(outside.path().to_str().unwrap()));
        }
        assert_eq!(
            std::fs::read_to_string(outside_file).unwrap(),
            "outside secret\n"
        );
    }

    #[test]
    fn target_change_between_final_validation_and_install_is_restored_exactly() {
        let (directory, root) = workspace();
        let target = Arc::new(directory.path().join("file.txt"));
        std::fs::write(target.as_ref(), "original\n").unwrap();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let hook_target = Arc::clone(&target);
        client.set_before_install(move || std::fs::write(hook_target.as_ref(), "external\n"));

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
        assert_eq!(
            std::fs::read_to_string(target.as_ref()).unwrap(),
            "external\n"
        );
        assert!(recovery_names(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_swap_cannot_redirect_a_retained_parent_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let (directory, root) = workspace();
        let nested = directory.path().join("nested");
        let moved = directory.path().join("retained-parent");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("file.txt"), "original\n").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("file.txt"), "outside\n").unwrap();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "nested/file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let nested_hook = nested.clone();
        let moved_hook = moved.clone();
        let outside_hook = outside.path().to_path_buf();
        client.set_before_install(move || {
            std::fs::rename(&nested_hook, &moved_hook)?;
            symlink(&outside_hook, &nested_hook)
        });

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
        assert_eq!(
            std::fs::read_to_string(moved.join("file.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("file.txt")).unwrap(),
            "outside\n"
        );
        assert!(recovery_names(&moved).is_empty());
    }

    #[test]
    fn mutation_after_exchange_is_indeterminate_and_preserves_recovery_evidence() {
        let (directory, root) = workspace();
        let target = directory.path().join("file.txt");
        std::fs::write(&target, "original\n").unwrap();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let parent = directory.path().to_path_buf();
        client.set_after_exchange(move || {
            let recovery = recovery_names(&parent).pop().ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "missing recovery artifact")
            })?;
            std::fs::write(parent.join(recovery), "mutated after exchange\n")
        });

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Indeterminate);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "mutated after exchange\n"
        );
        let recovery = recovery_names(directory.path());
        assert_eq!(recovery.len(), 1);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&recovery[0])).unwrap(),
            "postimage\n"
        );
    }

    #[test]
    fn replaced_stage_name_is_never_deleted_as_if_it_were_owned() {
        let (directory, root) = workspace();
        let target = directory.path().join("file.txt");
        std::fs::write(&target, "original\n").unwrap();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        let parent = directory.path().to_path_buf();
        client.set_before_install(move || {
            let recovery = recovery_names(&parent).pop().ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "missing recovery artifact")
            })?;
            std::fs::remove_file(parent.join(&recovery))?;
            std::fs::write(parent.join(recovery), "replacement\n")
        });

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Indeterminate);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original\n");
        let recovery = recovery_names(directory.path());
        assert_eq!(recovery.len(), 1);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&recovery[0])).unwrap(),
            "replacement\n"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn post_create_provenance_failure_unlinks_only_the_exact_owned_stage() {
        let (directory, root) = workspace();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        client.set_after_stage_write(|_, _, file| {
            const UNKNOWN_XATTR: &[u8] = b"com.aiden.hostile-test\0";
            let value = b"unexpected";
            let result = unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    UNKNOWN_XATTR.as_ptr().cast(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
        assert!(recovery_names(directory.path()).is_empty());
        assert!(!directory.path().join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn post_create_hardlink_mutation_preserves_the_hostile_stage_name() {
        let (directory, root) = workspace();
        let mut preparer = SubagentFileMutationPreparer::new(Box::new(|| "effect-1".to_string()));
        let mut client = SubagentFileMutatorClient::new(root).unwrap();
        let inspection = client.inspect("effect-1", "file.txt").unwrap();
        let effect = preparer
            .prepare_write(&PrepareSubagentFileWriteInput {
                inspection,
                content: "postimage\n".to_string(),
            })
            .unwrap();
        client.prepare(&effect).unwrap();
        client.set_after_stage_write(|parent, name, _| {
            let name = CString::new(name.as_bytes()).unwrap();
            let hostile = CString::new("hostile-link").unwrap();
            let result = unsafe {
                libc::linkat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    parent.as_raw_fd(),
                    hostile.as_ptr(),
                    0,
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });

        let error = client.commit("effect-1").unwrap_err();
        assert_eq!(error.failure, SubagentFileMutatorFailure::Conflict);
        let recovery = recovery_names(directory.path());
        assert_eq!(recovery.len(), 1);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&recovery[0])).unwrap(),
            "postimage\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("hostile-link")).unwrap(),
            "postimage\n"
        );
        assert!(!directory.path().join("file.txt").exists());
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
