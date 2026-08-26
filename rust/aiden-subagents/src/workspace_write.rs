//! Port of `main/services/subagents/subagent-workspace-write.ts` — the
//! workspace-write approval broker: parse arguments, digest-pin, prepare via
//! the file mutator, and one-shot approve → commit.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::approval::{PrepareSubagentApprovalV2Input, SubagentApprovalLedgerV2};
use crate::authority::{subagent_authority_digest_v2, SubagentAuthorityV2};
use crate::file_mutation::{
    canonical_subagent_file_relative_path, pin_subagent_workspace_root, SubagentFileInspection,
    SubagentFileMutationPreparer, SubagentWorkspaceRootIdentity,
};
use crate::file_mutator::create_subagent_file_mutator_client;
use crate::outbound_approval::same_subagent_authority_binding_v2;

pub const SUBAGENT_WRITE_FILE_TOOL_NAME: &str = "write_file";
pub const SUBAGENT_EDIT_FILE_TOOL_NAME: &str = "edit_file";
pub const SUBAGENT_WORKSPACE_WRITE_APPROVAL_WINDOW_MS: u64 = 60_000;
pub const SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT: usize = 260;
pub const SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT: usize = 40;
pub const SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT: usize = 40;
pub const SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT: usize = 40;
pub const SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT: usize = 8_000;
pub const SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentWorkspaceWriteToolBindingV2 {
    pub tool_name: &'static str,
    pub operation: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentWorkspaceWriteApprovalDetails {
    pub kind: String,
    pub operation: String,
    pub child_label: String,
    pub path: String,
    pub workspace_label: String,
    pub worktree_label: Option<String>,
    pub is_managed_worktree: bool,
    pub pre_digest_prefix: Option<String>,
    pub post_digest_prefix: String,
    pub before_bytes: usize,
    pub after_bytes: u64,
    pub diff_preview: String,
    pub diff_truncated: bool,
    pub command_will_run: bool,
    pub refuse_if_changed: bool,
}

/// `subagentWorkspaceRevisionV2` — the workspace's exact revision binding.
pub fn subagent_workspace_revision_v2(workspace: &WorkspaceRevisionInput) -> String {
    let managed_worktree = workspace.managed_worktree.as_ref().map(|worktree| {
        serde_json::json!({
            "repositoryPath": worktree.repository_path,
            "worktreePath": worktree.worktree_path,
            "branch": worktree.branch,
            "worktreeGitDir": worktree.worktree_git_dir,
            "ownershipToken": worktree.ownership_token,
            "worktreeDevice": worktree.worktree_device,
            "worktreeInode": worktree.worktree_inode,
            "createdFromHead": worktree.created_from_head,
        })
    });
    let value = serde_json::json!({
        "id": workspace.id,
        "folderPath": workspace.folder_path,
        "permission": workspace.permission,
        "managedWorktree": managed_worktree,
        "updatedAt": workspace.updated_at,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(&value).expect("json"));
    crate::authority::hex(&hasher.finalize())
}

#[derive(Debug, Clone)]
pub struct ManagedWorktreeInput {
    pub repository_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub worktree_git_dir: Option<String>,
    pub ownership_token: Option<String>,
    pub worktree_device: Option<String>,
    pub worktree_inode: Option<String>,
    pub created_from_head: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRevisionInput {
    pub id: String,
    pub folder_path: Option<String>,
    pub permission: String,
    pub managed_worktree: Option<ManagedWorktreeInput>,
    pub updated_at: u64,
}

fn digest_fields(fields: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        let bytes = field.as_bytes();
        hasher.update((bytes.len() as u32).to_be_bytes());
        hasher.update(bytes);
    }
    crate::authority::hex(&hasher.finalize())
}

fn argument_digest(tool_name: &str, args: &Value) -> String {
    if tool_name == SUBAGENT_WRITE_FILE_TOOL_NAME {
        digest_fields(&[
            tool_name,
            args.get("path").and_then(Value::as_str).unwrap_or(""),
            args.get("content").and_then(Value::as_str).unwrap_or(""),
        ])
    } else {
        digest_fields(&[
            tool_name,
            args.get("path").and_then(Value::as_str).unwrap_or(""),
            args.get("old_string").and_then(Value::as_str).unwrap_or(""),
            args.get("new_string").and_then(Value::as_str).unwrap_or(""),
        ])
    }
}

fn unsafe_approval_code_point(point: u32) -> bool {
    point <= 0x1f
        || (0x7f..=0x9f).contains(&point)
        || point == 0x061c
        || point == 0x200e
        || point == 0x200f
        || (0x2028..=0x202e).contains(&point)
        || (0x2066..=0x2069).contains(&point)
}

fn escaped_code_point(point: u32) -> String {
    format!("\\u{{{:04x}}}", point)
}

fn escaped_preview_line(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            let point = character as u32;
            if unsafe_approval_code_point(point) && point != 0x09 {
                escaped_code_point(point)
            } else {
                character.to_string()
            }
        })
        .collect()
}

fn approval_display_label(value: &str, limit: usize, fallback: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let first_visible = characters
        .iter()
        .position(|character| !character.is_whitespace());
    let Some(first_visible) = first_visible else {
        return fallback.to_string();
    };
    let mut last_visible = characters.len();
    for index in (0..characters.len()).rev() {
        if !characters[index].is_whitespace() {
            last_visible = index;
            break;
        }
    }
    let tokens: Vec<String> = characters
        .iter()
        .enumerate()
        .map(|(index, character)| {
            let point = *character as u32;
            let boundary_whitespace =
                character.is_whitespace() && (index < first_visible || index > last_visible);
            if unsafe_approval_code_point(point) || boundary_whitespace {
                escaped_code_point(point)
            } else {
                character.to_string()
            }
        })
        .collect();
    let full: String = tokens.iter().map(|token| token.as_str()).collect();
    if full.len() <= limit {
        return full;
    }
    let marker = "…";
    let mut result = String::new();
    for token in &tokens {
        if result.len() + token.len() + marker.len() > limit {
            break;
        }
        result.push_str(token);
    }
    if result.is_empty() {
        fallback.to_string()
    } else {
        format!("{result}{marker}")
    }
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn diff_preview(before: &str, after: &str) -> (String, bool) {
    let mut lines = vec!["--- current".to_string(), "+++ proposed".to_string()];
    for line in before.split(['\r', '\n']) {
        lines.push(format!("-{}", escaped_preview_line(line)));
    }
    for line in after.split(['\r', '\n']) {
        lines.push(format!("+{}", escaped_preview_line(line)));
    }
    let full = lines.join("\n");
    if full.len() <= SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT {
        return (full, false);
    }
    let marker = "\n… preview truncated …\n";
    let available = SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT - marker.len();
    let head = available / 2;
    let tail = available - head;
    let head_end = floor_char_boundary(&full, head);
    let tail_start = ceil_char_boundary(&full, full.len() - tail);
    (
        format!("{}{marker}{}", &full[..head_end], &full[tail_start..]),
        true,
    )
}

fn approval_details(input: &ApprovalDetailsInput) -> SubagentWorkspaceWriteApprovalDetails {
    let (preview, truncated) = diff_preview(input.before, &input.effect.postimage.content);
    let operation = if input.effect.operation == "edit" {
        "edit"
    } else if input.effect.expected_revision.is_none() {
        "create"
    } else {
        "replace"
    };
    SubagentWorkspaceWriteApprovalDetails {
        kind: "subagent-workspace-write".to_string(),
        operation: operation.to_string(),
        child_label: approval_display_label(
            input.child_label,
            SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT,
            "Subagent",
        ),
        path: input.effect.relative_path.clone(),
        workspace_label: approval_display_label(
            input.workspace_label,
            SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT,
            "Workspace",
        ),
        worktree_label: input.worktree_branch.as_ref().map(|branch| {
            approval_display_label(
                branch,
                SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT,
                "Managed worktree",
            )
        }),
        is_managed_worktree: input.worktree_branch.is_some(),
        pre_digest_prefix: input
            .effect
            .expected_revision
            .as_ref()
            .map(|revision| revision[..SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH].to_string()),
        post_digest_prefix: input.effect.postimage.sha256
            [..SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH]
            .to_string(),
        before_bytes: input.before.len(),
        after_bytes: input.effect.postimage.bytes,
        diff_preview: preview,
        diff_truncated: truncated,
        command_will_run: false,
        refuse_if_changed: true,
    }
}

struct ApprovalDetailsInput<'a> {
    child_label: &'a str,
    workspace_label: &'a str,
    worktree_branch: Option<&'a str>,
    effect: &'a crate::file_mutation::PreparedSubagentFileMutation,
    before: &'a str,
}

pub struct SubagentWorkspaceWriteApprovalBrokerV2Input {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub child_label: String,
    pub workspace: WorkspaceRevisionInput,
    pub workspace_root: String,
    pub bindings: Vec<SubagentWorkspaceWriteToolBindingV2>,
    pub ledger: SubagentApprovalLedgerV2,
    pub current_authority: Box<dyn Fn(&str) -> Option<SubagentAuthorityV2> + Send + Sync>,
    pub request_approval: Box<
        dyn Fn(&str, &SubagentWorkspaceWriteApprovalDetails) -> Result<bool, String> + Send + Sync,
    >,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
}

/// Pure prepare-side helper: resolve the ledger input for a pending mutation.
#[allow(clippy::too_many_arguments)]
pub fn workspace_write_ledger_input(
    authority: &SubagentAuthorityV2,
    child_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    argument_digest: &str,
    effect_digest: &str,
    authority_digest: &str,
    expires_at: u64,
) -> PrepareSubagentApprovalV2Input {
    PrepareSubagentApprovalV2Input {
        tree_root_id: authority.tree_root_id.clone(),
        run_id: authority.run_id.clone(),
        child_id: child_id.to_string(),
        chat_id: authority.chat_id.clone(),
        workspace_id: authority.workspace_id.clone(),
        owner_document_id: authority.owner_document_id.clone(),
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        authority_revision: authority.authority_revision,
        arguments: serde_json::json!({
            "originalArgumentDigest": argument_digest,
            "effectDigest": effect_digest,
            "workspaceRevision": authority.workspace_revision,
            "authorityDigest": authority_digest,
        }),
        expires_at,
    }
}

/// The workspace-write one-shot approval machine (synchronous core; the broker
/// lifecycle with the mutator client is layered by the host).
pub struct SubagentWorkspaceWriteApprovalCoreV2 {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub ledger: SubagentApprovalLedgerV2,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl SubagentWorkspaceWriteApprovalCoreV2 {
    pub fn new(
        authority: SubagentAuthorityV2,
        child_id: String,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        SubagentWorkspaceWriteApprovalCoreV2 {
            authority,
            child_id,
            ledger: SubagentApprovalLedgerV2::new(),
            now,
        }
    }

    pub fn live_authority(&self) -> Result<SubagentAuthorityV2, String> {
        if self.authority.execution != crate::authority::SubagentExecutionModeV2::Foreground
            || !self.authority.capabilities.workspace_write
        {
            return Err("Subagent workspace-write authority is unavailable.".to_string());
        }
        Ok(self.authority.clone())
    }
}

/// Inspect + prepare a mutation against the pinned root.
pub fn inspect_and_prepare(
    root: &SubagentWorkspaceRootIdentity,
    tool_name: &str,
    args: &Value,
) -> Result<
    (
        SubagentFileInspection,
        crate::file_mutation::PreparedSubagentFileMutation,
    ),
    String,
> {
    let relative_path = canonical_subagent_file_relative_path(
        args.get("path").and_then(Value::as_str).unwrap_or(""),
    )
    .map_err(|_| "The requested workspace operation could not be completed safely.".to_string())?;
    let mut client = create_subagent_file_mutator_client(root.clone()).map_err(|_| {
        "The requested workspace operation could not be completed safely.".to_string()
    })?;
    let mut preparer = SubagentFileMutationPreparer::default();
    let effect_id = preparer.create_effect_id().map_err(|_| {
        "The requested workspace operation could not be completed safely.".to_string()
    })?;
    let inspection = client.inspect(&effect_id, &relative_path).map_err(|_| {
        "The requested workspace operation could not be completed safely.".to_string()
    })?;
    let effect = if tool_name == SUBAGENT_WRITE_FILE_TOOL_NAME {
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        preparer
            .prepare_write(&crate::file_mutation::PrepareSubagentFileWriteInput {
                inspection: inspection.clone(),
                content,
            })
            .map_err(|_| {
                "The requested workspace operation could not be completed safely.".to_string()
            })?
    } else {
        preparer
            .prepare_edit(&crate::file_mutation::PrepareSubagentFileEditInput {
                inspection: inspection.clone(),
                old_string: args
                    .get("old_string")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                new_string: args
                    .get("new_string")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .map_err(|_| {
                "The requested workspace operation could not be completed safely.".to_string()
            })?
    };
    client.prepare(&effect).map_err(|_| {
        "The requested workspace operation could not be completed safely.".to_string()
    })?;
    Ok((inspection, effect))
}

/// Pin + prepare + render the approval details (pure host-independent path).
pub fn prepare_workspace_write_approval(
    authority: &SubagentAuthorityV2,
    child_id: &str,
    child_label: &str,
    workspace_root: &str,
    tool_name: &str,
    args: &Value,
    now: u64,
) -> Result<
    (
        SubagentWorkspaceWriteApprovalDetails,
        crate::file_mutation::PreparedSubagentFileMutation,
        String,
        u64,
    ),
    String,
> {
    if authority.execution != crate::authority::SubagentExecutionModeV2::Foreground
        || !authority.capabilities.workspace_write
    {
        return Err("Subagent workspace-write authority is unavailable.".to_string());
    }
    let root = pin_subagent_workspace_root(workspace_root).map_err(|_| {
        "The requested workspace operation could not be completed safely.".to_string()
    })?;
    let (inspection, effect) = inspect_and_prepare(&root, tool_name, args)?;
    let expires_at = authority
        .expires_at
        .min(now + SUBAGENT_WORKSPACE_WRITE_APPROVAL_WINDOW_MS);
    let details = approval_details(&ApprovalDetailsInput {
        child_label,
        workspace_label: "Workspace",
        worktree_branch: None,
        effect: &effect,
        before: inspection.current_content.as_deref().unwrap_or(""),
    });
    let argument_digest = argument_digest(tool_name, args);
    let authority_digest = subagent_authority_digest_v2(authority);
    let ledger_input = serde_json::json!({
        "treeRootId": authority.tree_root_id,
        "runId": authority.run_id,
        "childId": child_id,
        "chatId": authority.chat_id,
        "workspaceId": authority.workspace_id,
        "ownerDocumentId": authority.owner_document_id,
        "toolCallId": "",
        "toolName": tool_name,
        "authorityRevision": authority.authority_revision,
        "arguments": {
            "originalArgumentDigest": argument_digest,
            "effectDigest": effect.effect_digest,
            "workspaceRevision": authority.workspace_revision,
            "authorityDigest": authority_digest,
        },
        "expiresAt": expires_at,
    });
    Ok((details, effect, ledger_input.to_string(), expires_at))
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_workspace_write_approval_details(
    authority: &SubagentAuthorityV2,
    _child_id: &str,
    child_label: &str,
    tool_name: &str,
    args: &Value,
    effect: &crate::file_mutation::PreparedSubagentFileMutation,
    before: &str,
    workspace_label: &str,
    worktree_branch: Option<&str>,
) -> Result<(SubagentWorkspaceWriteApprovalDetails, String, String, u64), String> {
    if !same_subagent_authority_binding_v2(authority, Some(authority)) {
        return Err("Subagent workspace-write authority is unavailable.".to_string());
    }
    let expires_at = authority.expires_at;
    let details = approval_details(&ApprovalDetailsInput {
        child_label,
        workspace_label,
        worktree_branch,
        effect,
        before,
    });
    let argument_digest = argument_digest(tool_name, args);
    let authority_digest = subagent_authority_digest_v2(authority);
    Ok((details, argument_digest, authority_digest, expires_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_revision_binds_exact_facts() {
        let workspace = WorkspaceRevisionInput {
            id: "workspace-1".into(),
            folder_path: Some("/tmp/workspace".into()),
            permission: "full".into(),
            managed_worktree: None,
            updated_at: 100,
        };
        let revision = subagent_workspace_revision_v2(&workspace);
        assert_eq!(revision.len(), 64);
        let mut changed = workspace.clone();
        changed.updated_at = 101;
        assert_ne!(subagent_workspace_revision_v2(&changed), revision);
    }

    #[test]
    fn diff_preview_escapes_control_points() {
        let (preview, truncated) = diff_preview("line1\nline2", "line1\nline\u{1b}2");
        assert!(!preview.contains('\u{1b}'));
        assert!(!truncated);
        let long_before = "x".repeat(10_000);
        let (_, truncated) = diff_preview(&long_before, "");
        assert!(truncated);
    }

    #[test]
    fn diff_preview_truncates_on_multibyte_boundaries() {
        let before = format!("a{}", "🦀".repeat(3_000));

        let (preview, truncated) = diff_preview(&before, "");

        assert!(truncated);
        assert!(preview.len() <= SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT);
        assert!(preview.contains("… preview truncated …"));
        assert!(preview.starts_with("--- current"));
        assert!(preview.ends_with("\n+"));
    }

    #[test]
    fn approval_display_labels_escape_hidden_text() {
        assert_eq!(approval_display_label("hello", 10, "fallback"), "hello");
        // Boundary whitespace is escaped so hidden characters cannot be
        // rendered; with a 40-char limit the escaped form truncates.
        assert_eq!(
            approval_display_label("   hello   ", 40, "fallback"),
            "\\u{0020}\\u{0020}\\u{0020}hello\\u{0020}…"
        );
        // A larger limit keeps the full escaped form.
        assert_eq!(
            approval_display_label("   hello   ", 80, "fallback"),
            "\\u{0020}\\u{0020}\\u{0020}hello\\u{0020}\\u{0020}\\u{0020}"
        );
        let escaped = approval_display_label("bad\u{200e}text", 40, "fallback");
        assert_eq!(escaped, "bad\\u{200e}text");
        assert_eq!(approval_display_label("", 40, "fallback"), "fallback");
    }
}
