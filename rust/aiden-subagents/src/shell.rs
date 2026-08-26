//! Port of `main/services/subagents/subagent-shell.ts` — the shell approval
//! broker. Authority must be foreground + shell-enabled; every command gets a
//! digest-pinned one-shot approval, and execution goes through the in-process
//! AIDSH001 runner.

use serde_json::Value;
use sha2::Digest;

use crate::approval::{PrepareSubagentApprovalV2Input, SubagentApprovalLedgerV2};
use crate::authority::{subagent_authority_digest_v2, SubagentAuthorityV2};
use crate::outbound_approval::same_subagent_authority_binding_v2;
use crate::shell_runner::{
    fields_digest, pin_subagent_shell_workspace_root, run_subagent_shell,
    SubagentShellResponseIdentity, SubagentShellResult, SubagentShellRunInput,
    SubagentShellWorkspaceRoot,
};
use crate::workspace_write::{subagent_workspace_revision_v2, WorkspaceRevisionInput};

pub const SUBAGENT_RUN_COMMAND_TOOL_NAME: &str = "run_command";
pub const SUBAGENT_SHELL_MODEL_COMMAND_CHARS: usize = 16_384;
pub const SUBAGENT_SHELL_RUNTIME_COMMAND_BYTES: usize = 32 * 1024;
pub const SUBAGENT_SHELL_TIMEOUT_MS: u64 = 120_000;
pub const SUBAGENT_SHELL_APPROVAL_WINDOW_MS: u64 = 60_000;
pub const SUBAGENT_SHELL_MODEL_RESULT_CHARS: usize = 20_000;
pub const SUBAGENT_SHELL_STREAM_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentShellToolBindingV2 {
    pub tool_name: &'static str,
}

/// `plainCommandArguments` — exactly one own data property named `command`.
pub fn plain_command_arguments(value: &Value) -> Result<String, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid shell arguments.".to_string());
    };
    if object.len() != 1 || !object.contains_key("command") {
        return Err("Invalid shell arguments.".to_string());
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid shell arguments.".to_string())?;
    let forbidden = command.chars().any(|character| {
        let point = character as u32;
        point == 0
            || point == 0x0d
            || point == 0x1b
            || (point < 0x20 && point != 0x09 && point != 0x0a)
            || (0x7f..=0x9f).contains(&point)
            || point == 0x2028
            || point == 0x2029
            || (0x202a..=0x202e).contains(&point)
            || (0x2066..=0x2069).contains(&point)
    });
    if command.trim().is_empty()
        || command.len() > SUBAGENT_SHELL_RUNTIME_COMMAND_BYTES
        || forbidden
    {
        return Err("Invalid shell command.".to_string());
    }
    Ok(command.to_string())
}

fn same_root(left: &SubagentShellWorkspaceRoot, right: &SubagentShellWorkspaceRoot) -> bool {
    left.path == right.path && left.device == right.device && left.inode == right.inode
}

/// `effectDigest` — the shell effect binding (domain-framed fields).
pub fn subagent_shell_effect_digest(input: &ShellEffectDigestInput) -> String {
    fields_digest(
        "aiden-subagent-shell-effect-v2",
        &[
            input.command,
            &input.root.path,
            &input.root.device,
            &input.root.inode,
            "/bin/zsh",
            "-f",
            "-c",
            "aiden-subagent",
            "minimal-private-0700-v1",
            "stdin=/dev/null",
            &format!("stdout={SUBAGENT_SHELL_STREAM_BYTES}"),
            &format!("stderr={SUBAGENT_SHELL_STREAM_BYTES}"),
            &format!("timeout={SUBAGENT_SHELL_TIMEOUT_MS}"),
            &input.authority.tree_root_id,
            &input.authority.run_id,
            input.child_id,
            &input.authority.chat_id,
            &input.authority.workspace_id,
            input.tool_call_id,
            &input.expires_at.to_string(),
            "rollout=phase5e-v1",
        ],
    )
}

pub struct ShellEffectDigestInput<'a> {
    pub command: &'a str,
    pub root: &'a SubagentShellWorkspaceRoot,
    pub authority: &'a SubagentAuthorityV2,
    pub child_id: &'a str,
    pub tool_call_id: &'a str,
    pub expires_at: u64,
}

/// `terminalDigest` — fixed evidence for a terminal outcome.
pub fn subagent_shell_terminal_digest(state: &str, text: &str) -> String {
    fields_digest("aiden-subagent-shell-terminal-v2", &[state, text])
}

fn sanitize_stream(value: &str) -> String {
    crate::safe_text::sanitize_subagent_text(value)
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

fn bounded_stream(label: &str, value: &str) -> String {
    let safe = sanitize_stream(value);
    let allowance = (SUBAGENT_SHELL_MODEL_RESULT_CHARS - 512) / 2;
    if safe.len() <= allowance {
        return format!(
            "{label}:\n{}",
            if safe.is_empty() { "(empty)" } else { &safe }
        );
    }
    let half = (allowance - 80) / 2;
    let head_end = floor_char_boundary(&safe, half);
    let tail_start = ceil_char_boundary(&safe, safe.len() - half);
    format!(
        "{label}:\n{}\n… output truncated …\n{}",
        &safe[..head_end],
        &safe[tail_start..]
    )
}

/// `modelResult` — the fixed model-facing shell result text.
pub fn shell_model_result(result: &SubagentShellResult) -> String {
    let mut status = vec![format!("Shell outcome: {}", result.outcome.as_str())];
    if let Some(exit_code) = result.exit_code {
        status.push(format!("Exit code: {exit_code}"));
    }
    if let Some(signal) = result.signal {
        status.push(format!("Signal: {signal}"));
    }
    status.push(format!(
        "Cleanup confirmed: {}",
        if result.cleanup_confirmed {
            "yes"
        } else {
            "no"
        }
    ));
    let text = format!(
        "{}\n\n{}\n\n{}",
        status.join("\n"),
        bounded_stream("Untrusted stdout", &result.stdout),
        bounded_stream("Untrusted stderr", &result.stderr)
    );
    text.chars()
        .take(SUBAGENT_SHELL_MODEL_RESULT_CHARS)
        .collect()
}

pub struct SubagentShellBrokerV2Input {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub child_label: String,
    pub workspace: WorkspaceRevisionInput,
    pub workspace_root: String,
    pub ledger: SubagentApprovalLedgerV2,
    pub current_authority: Box<dyn Fn(&str) -> Option<SubagentAuthorityV2> + Send + Sync>,
    pub request_approval: Box<dyn Fn(&str, &str) -> Result<bool, String> + Send + Sync>,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub allocate_id: Box<dyn Fn() -> String + Send + Sync>,
}

struct PendingShell {
    approval_id: String,
    effect_id: String,
    command: String,
    argument_digest: String,
    effect_digest: String,
    authority_digest: String,
    root: SubagentShellWorkspaceRoot,
    expires_at: u64,
}

/// One-shot shell gate. Synchronous core; execution is async through the
/// in-process runner.
pub struct SubagentShellGateV2 {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub child_label: String,
    pub workspace_root: String,
    pub ledger: SubagentApprovalLedgerV2,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub allocate_id: Box<dyn Fn() -> String + Send + Sync>,
    pending: std::collections::HashMap<String, PendingShell>,
}

impl SubagentShellGateV2 {
    pub fn new(input: SubagentShellBrokerV2Input) -> Result<Self, String> {
        if input.authority.execution != crate::authority::SubagentExecutionModeV2::Foreground
            || !input.authority.capabilities.shell
            || input.workspace.permission == "none"
        {
            return Err("Subagent shell authority is unavailable.".to_string());
        }
        if let Some(folder_path) = &input.workspace.folder_path {
            if *folder_path != input.workspace_root {
                return Err("Subagent shell authority is unavailable.".to_string());
            }
        }
        if subagent_workspace_revision_v2(&input.workspace) != input.authority.workspace_revision {
            return Err("Subagent shell authority is unavailable.".to_string());
        }
        Ok(SubagentShellGateV2 {
            authority: input.authority,
            child_id: input.child_id,
            child_label: input.child_label,
            workspace_root: input.workspace_root,
            ledger: input.ledger,
            now: input.now,
            allocate_id: input.allocate_id,
            pending: std::collections::HashMap::new(),
        })
    }

    fn live_authority(&self) -> Result<SubagentAuthorityV2, String> {
        if self.authority.expires_at <= (self.now)() || !self.authority.capabilities.shell {
            return Err("Subagent shell authority expired or was revoked.".to_string());
        }
        Ok(self.authority.clone())
    }

    /// Prepare + approve a command call. Returns the pending shell on success.
    pub fn before_tool_call(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        current_authority: &dyn Fn(&str) -> Option<SubagentAuthorityV2>,
        request_approval: &mut dyn FnMut(&str, &str) -> Result<bool, String>,
    ) -> Result<Option<String>, String> {
        if self.pending.contains_key(tool_call_id) {
            return Ok(Some("This subagent shell call is unavailable.".to_string()));
        }
        let authority = self.live_authority()?;
        let current = current_authority(&authority.run_id);
        if !same_subagent_authority_binding_v2(&authority, current.as_ref())
            || current
                .map(|current| current.expires_at <= (self.now)())
                .unwrap_or(true)
        {
            return Ok(Some(
                "Subagent shell authority expired or was revoked.".to_string(),
            ));
        }
        let command = match plain_command_arguments(args) {
            Ok(command) => command,
            Err(_) => return Ok(Some("This subagent shell call is unavailable.".to_string())),
        };
        let root = pin_subagent_shell_workspace_root(&self.workspace_root())
            .map_err(|_| "This subagent shell call could not be prepared safely.".to_string())?;
        let expires_at = authority
            .expires_at
            .min((self.now)() + SUBAGENT_SHELL_APPROVAL_WINDOW_MS);
        let argument_digest = fields_digest("aiden-subagent-shell-argument-v2", &[&command]);
        let root_digest = fields_digest(
            "aiden-subagent-shell-root-v2",
            &[&root.path, &root.device, &root.inode],
        );
        let effect_digest = subagent_shell_effect_digest(&ShellEffectDigestInput {
            command: &command,
            root: &root,
            authority: &authority,
            child_id: &self.child_id,
            tool_call_id,
            expires_at,
        });
        let authority_digest = subagent_authority_digest_v2(&authority);
        let ledger_input = PrepareSubagentApprovalV2Input {
            tree_root_id: authority.tree_root_id.clone(),
            run_id: authority.run_id.clone(),
            child_id: self.child_id.clone(),
            chat_id: authority.chat_id.clone(),
            workspace_id: authority.workspace_id.clone(),
            owner_document_id: authority.owner_document_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: SUBAGENT_RUN_COMMAND_TOOL_NAME.to_string(),
            authority_revision: authority.authority_revision,
            arguments: serde_json::json!({
                "argumentDigest": argument_digest,
                "effectDigest": effect_digest,
                "rootDigest": root_digest,
            }),
            expires_at,
        };
        let prepared = self
            .ledger
            .prepare(&ledger_input, (self.now)(), &mut self.allocate_id);
        let (approval_id, _) = match prepared {
            Ok(prepared) => prepared,
            Err(_) => {
                return Ok(Some(
                    "This subagent shell call could not be prepared safely.".to_string(),
                ))
            }
        };
        let effect_id = format!("effect-{}", (self.allocate_id)());
        let summary = format!("Run a full-host command for {}", self.child_label());
        let allowed = request_approval(&summary, &command);
        let allowed = allowed.unwrap_or_default();
        if !allowed {
            self.ledger.deny(&approval_id, &authority.owner_document_id);
            return Ok(Some("The user denied this shell call.".to_string()));
        }
        let current = current_authority(&authority.run_id);
        if !same_subagent_authority_binding_v2(&authority, current.as_ref())
            || !self.ledger.authorize(
                &approval_id,
                &authority.owner_document_id,
                &ledger_input,
                (self.now)(),
            )
        {
            self.ledger.deny(&approval_id, &authority.owner_document_id);
            return Ok(Some("This shell approval expired or changed.".to_string()));
        }
        self.pending.insert(
            tool_call_id.to_string(),
            PendingShell {
                approval_id,
                effect_id,
                command,
                argument_digest,
                effect_digest,
                authority_digest,
                root,
                expires_at,
            },
        );
        Ok(None)
    }

    /// Execute an approved command through the in-process runner.
    pub async fn execute(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        current_authority: &dyn Fn(&str) -> Option<SubagentAuthorityV2>,
    ) -> Result<String, String> {
        let prepared = self.pending.remove(tool_call_id);
        let Some(prepared) = prepared else {
            return Err("This shell call has no live one-shot approval.".to_string());
        };
        let command = match plain_command_arguments(args) {
            Ok(command) => command,
            Err(_) => {
                self.ledger
                    .deny(&prepared.approval_id, &self.authority.owner_document_id);
                return Err("The shell approval expired or changed.".to_string());
            }
        };
        let authority = current_authority(&self.authority.run_id);
        let root = pin_subagent_shell_workspace_root(&self.workspace_root()).map_err(|_| {
            self.ledger
                .deny(&prepared.approval_id, &self.authority.owner_document_id);
            "The shell approval expired or changed.".to_string()
        })?;
        let ledger_input = PrepareSubagentApprovalV2Input {
            tree_root_id: self.authority.tree_root_id.clone(),
            run_id: self.authority.run_id.clone(),
            child_id: self.child_id.clone(),
            chat_id: self.authority.chat_id.clone(),
            workspace_id: self.authority.workspace_id.clone(),
            owner_document_id: self.authority.owner_document_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: SUBAGENT_RUN_COMMAND_TOOL_NAME.to_string(),
            authority_revision: self.authority.authority_revision,
            arguments: serde_json::json!({
                "argumentDigest": prepared.argument_digest,
                "effectDigest": prepared.effect_digest,
                "rootDigest": fields_digest("aiden-subagent-shell-root-v2", &[&root.path, &root.device, &root.inode]),
            }),
            expires_at: prepared.expires_at,
        };
        if command != prepared.command
            || !same_root(&root, &prepared.root)
            || prepared.expires_at <= (self.now)()
            || !same_subagent_authority_binding_v2(&self.authority, authority.as_ref())
            || authority
                .as_ref()
                .map(|authority| {
                    subagent_authority_digest_v2(authority) != prepared.authority_digest
                })
                .unwrap_or(true)
            || !self
                .ledger
                .consume(&prepared.approval_id, &ledger_input, (self.now)())
        {
            self.ledger
                .deny(&prepared.approval_id, &self.authority.owner_document_id);
            return Err("The shell approval expired or changed.".to_string());
        }
        let nonce = crate::authority::hex(&{
            let mut hasher = sha2::Sha256::default();
            hasher.update(format!("{:?}", std::time::SystemTime::now()).as_bytes());
            hasher.update(prepared.effect_id.as_bytes());
            hasher.finalize()
        });
        let input = SubagentShellRunInput {
            command: prepared.command.clone(),
            effect_digest: prepared.effect_digest.clone(),
            nonce: nonce.clone(),
            timeout_ms: SUBAGENT_SHELL_TIMEOUT_MS,
            cancelled: false,
        };
        let frame = match run_subagent_shell(&input, &prepared.root).await {
            Ok(frame) => frame,
            Err(error) => {
                self.ledger
                    .deny(&prepared.approval_id, &self.authority.owner_document_id);
                return Err(error.0);
            }
        };
        let result = crate::shell_runner::decode_subagent_shell_response(
            &frame,
            &SubagentShellResponseIdentity {
                nonce: nonce.clone(),
                effect_digest: prepared.effect_digest.clone(),
            },
        )
        .map_err(|error| {
            self.ledger
                .deny(&prepared.approval_id, &self.authority.owner_document_id);
            error.0
        })?;
        Ok(shell_model_result(&result))
    }

    fn workspace_root(&self) -> String {
        self.workspace_root.clone()
    }

    fn child_label(&self) -> &str {
        &self.child_label
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn authority() -> SubagentAuthorityV2 {
        crate::authority::create_subagent_authority_v2(
            &serde_json::from_value(json!({
                "grantId": "grant-1",
                "treeRootId": "tree-1",
                "runId": "run-1",
                "depth": 1,
                "authorityRevision": 1,
                "generationId": "generation-1",
                "chatId": "chat-1",
                "workspaceId": "workspace-1",
                "workspaceRevision": "rev",
                "ownerDocumentId": "document-1",
                "providerFingerprint": "provider-fingerprint",
                "modelFingerprint": "model-fingerprint",
                "contextRevision": "context-revision",
                "execution": "foreground",
                "context": "fresh",
                "thinkingLevel": "high",
                "capabilities": json!({
                    "workspaceRead": true,
                    "workspaceWrite": false,
                    "shell": true,
                    "web": false,
                    "delegation": false,
                    "mcp": [],
                }),
                "budgets": json!({
                    "deadlineMs": 60_000,
                    "maxTurns": 24,
                    "maxToolCalls": 64,
                    "maxOutputChars": 120_000,
                    "maxTokens": 200_000,
                    "maxLaunches": 8,
                    "maxDepth": 2,
                    "maxActive": 4,
                    "maxQueued": 8,
                    "maxNetworkOperations": 16,
                }),
                "expiresAt": 100_000,
            }))
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn command_arguments_are_exact_and_single_field() {
        assert_eq!(
            plain_command_arguments(&json!({ "command": "echo hi" })).unwrap(),
            "echo hi"
        );
        assert!(plain_command_arguments(&json!({ "command": "x", "extra": 1 })).is_err());
        assert!(plain_command_arguments(&json!({})).is_err());
        assert!(plain_command_arguments(&json!({ "command": "bad\u{1b}" })).is_err());
        assert!(plain_command_arguments(&json!({ "command": "   " })).is_err());
    }

    #[test]
    fn shell_effect_digest_is_deterministic() {
        let root = SubagentShellWorkspaceRoot {
            path: "/tmp/workspace".to_string(),
            device: "1".to_string(),
            inode: "2".to_string(),
        };
        let authority = authority();
        let first = subagent_shell_effect_digest(&ShellEffectDigestInput {
            command: "echo hi",
            root: &root,
            authority: &authority,
            child_id: "child-1",
            tool_call_id: "call-1",
            expires_at: 5_000,
        });
        let second = subagent_shell_effect_digest(&ShellEffectDigestInput {
            command: "echo hi",
            root: &root,
            authority: &authority,
            child_id: "child-1",
            tool_call_id: "call-1",
            expires_at: 5_000,
        });
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        let different = subagent_shell_effect_digest(&ShellEffectDigestInput {
            command: "echo bye",
            root: &root,
            authority: &authority,
            child_id: "child-1",
            tool_call_id: "call-1",
            expires_at: 5_000,
        });
        assert_ne!(first, different);
    }

    #[test]
    fn model_result_is_bounded_and_marks_streams_untrusted() {
        let result = SubagentShellResult {
            outcome: crate::shell_runner::SubagentShellOutcome::Exited,
            exit_code: Some(0),
            signal: None,
            cleanup_confirmed: true,
            stdout: "hello".to_string(),
            stderr: String::new(),
        };
        let text = shell_model_result(&result);
        assert!(text.contains("Shell outcome: exited"));
        assert!(text.contains("Untrusted stdout"));
        assert!(text.len() <= SUBAGENT_SHELL_MODEL_RESULT_CHARS);
    }

    #[test]
    fn model_result_truncates_multibyte_streams_on_character_boundaries() {
        let result = SubagentShellResult {
            outcome: crate::shell_runner::SubagentShellOutcome::Exited,
            exit_code: Some(0),
            signal: None,
            cleanup_confirmed: true,
            stdout: format!("a{}z", "🦀".repeat(3_000)),
            stderr: String::new(),
        };

        let text = shell_model_result(&result);

        assert!(text.len() <= SUBAGENT_SHELL_MODEL_RESULT_CHARS);
        assert!(text.contains("… output truncated …"));
        assert!(text.contains("Untrusted stdout:\na"));
        assert!(text.contains("z\n\nUntrusted stderr:"));
    }
}
