//! Port of `main/services/subagents/subagent-foreground-persistence-v2.ts` —
//! the bridge from the bounded renderer projector into canonical native V2
//! persistence. The private immutable authority is created once per run and is
//! never included in the returned renderer projection.

use serde_json::Value;
use sha2::Digest;

use crate::approval::SubagentApprovalLedgerV2;
use crate::authority::{
    create_subagent_authority_v2, resolve_subagent_capabilities_v2,
    subagent_capabilities_are_subset_v2, CreateSubagentAuthorityV2Input,
    ResolveSubagentCapabilitiesV2Input, SubagentAuthorityV2, SubagentCapabilitySetV2,
    SubagentExecutionModeV2, SubagentRolloutPolicyV2,
};
use crate::contracts::{
    default_root_capabilities, SubagentRequestedCapabilities, MAX_SUBAGENT_LAUNCHES_PER_GENERATION,
    MAX_SUBAGENT_SUMMARY_CHARS,
};
use crate::event_projector::SubagentRunIdentity;
use crate::network_budget::SubagentNetworkBudgetV2;
use crate::request_capabilities::resolve_requested_subagent_capabilities_v2;
use crate::run_store_dispatcher::SubagentRunStoreSelection;
use crate::run_store_v2::{
    MutableSubagentPrivateRunManifestV2, NativeSubagentPrivateRunManifestV2,
};
use crate::workspace_write::{subagent_workspace_revision_v2, WorkspaceRevisionInput};

pub const MAX_SUBAGENT_CHILD_TURNS: u64 = 24;
pub const MAX_SUBAGENT_CHILD_TOOL_CALLS: u64 = 64;
pub const MAX_SUBAGENT_CHILD_OUTPUT_CHARS: usize = 120_000;

fn fingerprint(value: &Value) -> String {
    let mut hasher = sha2::Sha256::default();
    hasher.update(serde_json::to_string(value).expect("json").as_bytes());
    crate::authority::hex(&hasher.finalize())
}

pub struct ForegroundSubagentPersistenceV2Input {
    pub selection: SubagentRunStoreSelection,
    pub generation_id: String,
    pub chat_id: String,
    pub workspace: WorkspaceRevisionInput,
    pub permission: String,
    pub provider_deployment: &'static str,
    pub provider_fingerprint: String,
    pub model_fingerprint: String,
    pub context_window: Option<u64>,
    pub thinking_level: String,
    pub owner_document_id: String,
    pub web_enabled: bool,
    pub write_enabled: bool,
    pub shell_enabled: bool,
    pub shell_binary: Option<String>,
    pub delegation_enabled: bool,
    pub mcp_mutations_enabled: bool,
    pub mcp_inventory: Vec<crate::authority::SubagentMcpScopeV2>,
    pub request_approval_available: bool,
    pub workspace_revalidate_available: bool,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub allocate_uuid: Box<dyn Fn() -> String + Send + Sync>,
}

/// The per-generation persistence coordinator. Holds authorities, the
/// approval ledger, and the network budget; exposes the exact prepare seam.
pub struct ForegroundSubagentPersistenceV2 {
    input: ForegroundSubagentPersistenceV2Input,
    authorities: std::collections::HashMap<String, SubagentAuthorityV2>,
    pub approvals: SubagentApprovalLedgerV2,
    revoked_runs: std::collections::HashSet<String>,
    network_budgets: SubagentNetworkBudgetV2,
}

impl ForegroundSubagentPersistenceV2 {
    pub fn new(input: ForegroundSubagentPersistenceV2Input) -> Self {
        ForegroundSubagentPersistenceV2 {
            input,
            authorities: std::collections::HashMap::new(),
            approvals: SubagentApprovalLedgerV2::new(),
            revoked_runs: std::collections::HashSet::new(),
            network_budgets: SubagentNetworkBudgetV2::new(),
        }
    }

    fn workspace_binding(&self) -> String {
        subagent_workspace_revision_v2(&self.input.workspace)
    }

    fn revoke_authority(&mut self, run_id: &str) {
        self.revoked_runs.insert(run_id.to_string());
        if let Some(authority) = self.authorities.get(run_id) {
            self.network_budgets.release(authority);
        }
    }

    /// Main-owned authority preflight called before projector or child
    /// construction (`prepareAuthority`).
    pub fn prepare_authority(
        &mut self,
        identity: &SubagentRunIdentity,
        context_mode: &str,
        context_revision: &str,
        deadline_ms: u64,
        requested_capabilities: &SubagentRequestedCapabilities,
        parent_authority: Option<&SubagentAuthorityV2>,
    ) -> Result<SubagentAuthorityV2, String> {
        if let Some(existing) = self.authorities.get(&identity.run_id) {
            return Ok(existing.clone());
        }
        let issued_at = (self.input.now)();
        if let Some(parent) = parent_authority {
            let current_parent = self.authorities.get(&parent.run_id);
            let valid = current_parent.is_some()
                && !self.revoked_runs.contains(&parent.run_id)
                && serde_json::to_value(current_parent.expect("checked")).expect("json")
                    == serde_json::to_value(parent).expect("json")
                && parent.depth == 1
                && parent.execution == SubagentExecutionModeV2::Foreground
                && parent.capabilities.delegation
                && parent.expires_at > issued_at;
            if !valid {
                return Err(
                    "Nested subagent parent authority is stale, revoked, or ineligible."
                        .to_string(),
                );
            }
        }
        let available_mcp_inventory: Vec<crate::authority::SubagentMcpScopeV2> = self
            .input
            .mcp_inventory
            .iter()
            .filter_map(|scope| {
                let tools: Vec<crate::authority::SubagentMcpToolScopeV2> = scope
                    .tools
                    .iter()
                    .filter(|tool| {
                        tool.effect() == crate::authority::SubagentMcpEffectV2::Read
                            || self.input.mcp_mutations_enabled
                    })
                    .cloned()
                    .collect();
                if tools.is_empty() {
                    None
                } else {
                    Some(crate::authority::SubagentMcpScopeV2 {
                        server_id: scope.server_id.clone(),
                        connection_fingerprint: scope.connection_fingerprint.clone(),
                        tools,
                    })
                }
            })
            .collect();
        let exact_requested = resolve_requested_subagent_capabilities_v2(
            requested_capabilities,
            &available_mcp_inventory,
        )?;
        if let Some(parent) = parent_authority {
            if !subagent_capabilities_are_subset_v2(&exact_requested, &parent.capabilities) {
                return Err(
                    "A nested subagent request cannot widen its parent capability ceiling."
                        .to_string(),
                );
            }
        }
        let write_available = self.input.write_enabled
            && (self.input.permission == "ask" || self.input.permission == "full")
            && self.input.request_approval_available
            && self.input.workspace_revalidate_available;
        let shell_available = self.input.shell_enabled
            && self
                .input
                .shell_binary
                .as_ref()
                .map(|binary| !binary.is_empty())
                .unwrap_or(false)
            && self.input.permission != "none"
            && self.input.request_approval_available
            && self.input.workspace_revalidate_available;
        let read_only = crate::authority::SubagentCapabilitySetV2 {
            workspace_read: true,
            workspace_write: false,
            shell: false,
            web: false,
            delegation: false,
            mcp: Vec::new(),
        };
        let available_capabilities = SubagentCapabilitySetV2 {
            workspace_write: write_available,
            shell: shell_available,
            web: self.input.web_enabled,
            delegation: self.input.delegation_enabled,
            ..read_only
        };
        let capabilities = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: exact_requested.clone(),
            root: parent_authority
                .map(|parent| parent.capabilities.clone())
                .unwrap_or_else(|| available_capabilities.clone()),
            parent: parent_authority
                .map(|parent| parent.capabilities.clone())
                .unwrap_or_else(|| available_capabilities.clone()),
            role: available_capabilities.clone(),
            rollout: SubagentRolloutPolicyV2 {
                background: false,
                fork: context_mode == "fork",
                workspace_write: write_available,
                shell: shell_available,
                web: self.input.web_enabled,
                mcp: !available_mcp_inventory.is_empty(),
                delegation: parent_authority.is_none() && self.input.delegation_enabled,
            },
            user_grant: available_capabilities,
            workspace_permission: self.input.permission.clone(),
            workspace_egress_approval: if self.input.request_approval_available {
                "per_call".to_string()
            } else {
                "unavailable".to_string()
            },
        })?;
        let tree_root_id = parent_authority
            .map(|parent| parent.tree_root_id.clone())
            .unwrap_or_else(|| {
                format!(
                    "tree-{}",
                    &fingerprint(&Value::String(self.input.generation_id.clone()))[..32]
                )
            });
        let input = CreateSubagentAuthorityV2Input {
            grant_id: format!("grant-{}", (self.input.allocate_uuid)()),
            tree_root_id,
            run_id: identity.run_id.clone(),
            parent_run_id: parent_authority.map(|parent| parent.run_id.clone()),
            depth: if parent_authority.is_some() { 2 } else { 1 },
            authority_revision: 1,
            generation_id: parent_authority
                .map(|parent| parent.generation_id.clone())
                .unwrap_or_else(|| self.input.generation_id.clone()),
            chat_id: parent_authority
                .map(|parent| parent.chat_id.clone())
                .unwrap_or_else(|| self.input.chat_id.clone()),
            workspace_id: parent_authority
                .map(|parent| parent.workspace_id.clone())
                .unwrap_or_else(|| self.input.workspace.id.clone()),
            workspace_revision: parent_authority
                .map(|parent| parent.workspace_revision.clone())
                .unwrap_or_else(|| self.workspace_binding()),
            owner_document_id: parent_authority
                .map(|parent| parent.owner_document_id.clone())
                .unwrap_or_else(|| self.input.owner_document_id.clone()),
            provider_fingerprint: parent_authority
                .map(|parent| parent.provider_fingerprint.clone())
                .unwrap_or_else(|| self.input.provider_fingerprint.clone()),
            model_fingerprint: parent_authority
                .map(|parent| parent.model_fingerprint.clone())
                .unwrap_or_else(|| self.input.model_fingerprint.clone()),
            context_revision: context_revision.to_string(),
            execution: parent_authority
                .map(|parent| parent.execution)
                .unwrap_or(SubagentExecutionModeV2::Foreground),
            context: if context_mode == "fork" {
                crate::authority::SubagentContextModeV2::Fork
            } else {
                crate::authority::SubagentContextModeV2::Fresh
            },
            thinking_level: parent_authority
                .map(|parent| parent.thinking_level.clone())
                .unwrap_or_else(|| self.input.thinking_level.clone()),
            capabilities,
            budgets: crate::authority::SubagentBudgetV2 {
                deadline_ms,
                max_turns: MAX_SUBAGENT_CHILD_TURNS,
                max_tool_calls: MAX_SUBAGENT_CHILD_TOOL_CALLS,
                max_output_chars: MAX_SUBAGENT_SUMMARY_CHARS.max(MAX_SUBAGENT_CHILD_OUTPUT_CHARS)
                    as u64,
                max_tokens: self
                    .input
                    .context_window
                    .unwrap_or(1_000_000)
                    .clamp(1, 10_000_000),
                max_launches: parent_authority
                    .map(|parent| parent.budgets.max_launches)
                    .unwrap_or(MAX_SUBAGENT_LAUNCHES_PER_GENERATION as u64),
                max_depth: 2,
                max_active: if self.input.provider_deployment == "local" {
                    1
                } else {
                    2
                },
                max_queued: 8,
                max_network_operations: 1,
            },
            expires_at: parent_authority
                .map(|parent| parent.expires_at)
                .unwrap_or(u64::MAX)
                .min(issued_at.saturating_add(deadline_ms)),
        };
        let authority = create_subagent_authority_v2(&input)?;
        self.authorities
            .insert(identity.run_id.clone(), authority.clone());
        Ok(authority)
    }

    /// `manifestFor` — the exact native private manifest.
    pub fn manifest_for(
        &self,
        canonical: &crate::run_store_v2::SubagentRunSnapshotV2,
    ) -> Result<MutableSubagentPrivateRunManifestV2, String> {
        let authority = self
            .authorities
            .get(&canonical.run_id)
            .filter(|authority| authority.authority_revision == canonical.authority_revision)
            .ok_or_else(|| {
                "Foreground subagent authority was not resolved before launch.".to_string()
            })?;
        Ok(MutableSubagentPrivateRunManifestV2::Native(
            NativeSubagentPrivateRunManifestV2 {
                version: 2,
                provenance: "v2_native".to_string(),
                run_id: canonical.run_id.clone(),
                generation_id: canonical.generation_id.clone(),
                child_id: canonical.child_id.clone(),
                chat_id: canonical.chat_id.clone(),
                workspace_id: canonical.workspace_id.clone(),
                task: canonical.task_preview.clone(),
                reusable_authority: false,
                authority: authority.clone(),
            },
        ))
    }

    /// `canonicalSnapshot` — lift a V1 projector snapshot into canonical V2.
    pub fn canonical_snapshot(
        &self,
        snapshot: &aiden_core::subagent_runs::SubagentRunSnapshotV1,
    ) -> Result<crate::run_store_v2::SubagentRunSnapshotV2, String> {
        let authority = self.authorities.get(&snapshot.run_id).ok_or_else(|| {
            "Foreground subagent authority was not resolved before launch.".to_string()
        })?;
        let value = serde_json::to_value(snapshot).expect("json");
        let mut object = value.as_object().cloned().expect("object");
        object.insert("version".to_string(), Value::from(2));
        if let Some(parent_run_id) = &authority.parent_run_id {
            object.insert(
                "parentRunId".to_string(),
                Value::String(parent_run_id.clone()),
            );
        }
        object.insert("depth".to_string(), Value::from(authority.depth));
        object.insert(
            "execution".to_string(),
            Value::String(authority.execution.as_str().to_string()),
        );
        object.insert(
            "context".to_string(),
            Value::String(authority.context.as_str().to_string()),
        );
        object.insert(
            "authorityRevision".to_string(),
            Value::from(authority.authority_revision),
        );
        aiden_core::subagent_runs::parse_subagent_run_snapshot_v2(&Value::Object(object))
            .ok_or_else(|| {
                "Foreground subagent snapshot could not enter canonical V2 storage.".to_string()
            })
    }

    pub fn current_authority(&self, run_id: &str) -> Option<SubagentAuthorityV2> {
        if self.revoked_runs.contains(run_id) {
            return None;
        }
        self.authorities.get(run_id).cloned()
    }

    pub fn consume_network_operation(
        &mut self,
        authority: &SubagentAuthorityV2,
    ) -> Result<(), String> {
        self.network_budgets.consume(authority)
    }

    pub fn abort_preparation(&mut self, run_id: &str) {
        self.revoke_authority(run_id);
        self.approvals.cancel_run(run_id);
        self.authorities.remove(run_id);
    }

    pub fn revoke_run(&mut self, run_id: &str) {
        self.revoke_authority(run_id);
        self.approvals.cancel_run(run_id);
    }
}

/// V1-rollback admission: only the legacy read-only ceiling is allowed.
pub fn requested_capabilities_available_during_v1_rollback(
    requested: &SubagentRequestedCapabilities,
) -> bool {
    requested.workspace_read
        && !requested.workspace_write
        && requested.shell != Some(true)
        && requested.delegate != Some(true)
        && !requested.web
        && requested.mcp.is_empty()
        && requested
            .mcp_mutations
            .as_ref()
            .map(|mutations| mutations.is_empty())
            .unwrap_or(true)
}

pub fn default_requested_capabilities() -> SubagentRequestedCapabilities {
    default_root_capabilities()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> WorkspaceRevisionInput {
        WorkspaceRevisionInput {
            id: "workspace-1".into(),
            folder_path: Some("/tmp/workspace".into()),
            permission: "full".into(),
            managed_worktree: None,
            updated_at: 100,
        }
    }

    fn persistence() -> ForegroundSubagentPersistenceV2 {
        ForegroundSubagentPersistenceV2::new(ForegroundSubagentPersistenceV2Input {
            selection: SubagentRunStoreSelection::V2,
            generation_id: "generation-1".into(),
            chat_id: "chat-1".into(),
            workspace: workspace(),
            permission: "full".into(),
            provider_deployment: "hosted",
            provider_fingerprint: "provider-fingerprint".into(),
            model_fingerprint: "model-fingerprint".into(),
            context_window: Some(200_000),
            thinking_level: "high".into(),
            owner_document_id: "document-1".into(),
            web_enabled: true,
            write_enabled: true,
            shell_enabled: false,
            shell_binary: None,
            delegation_enabled: false,
            mcp_mutations_enabled: false,
            mcp_inventory: Vec::new(),
            request_approval_available: true,
            workspace_revalidate_available: true,
            now: Box::new(|| 1_000),
            allocate_uuid: Box::new(|| "nonce-1".to_string()),
        })
    }

    fn identity() -> SubagentRunIdentity {
        SubagentRunIdentity {
            run_id: "run-1".into(),
            group_id: "group-1".into(),
            child_id: "child-1".into(),
        }
    }

    #[test]
    fn authority_preparation_is_exact_and_immutable() {
        let mut persistence = persistence();
        let mut requested = default_requested_capabilities();
        requested.workspace_write = true;
        requested.web = true;
        let authority = persistence
            .prepare_authority(
                &identity(),
                "fresh",
                "context-revision",
                60_000,
                &requested,
                None,
            )
            .unwrap();
        assert_eq!(authority.depth, 1);
        assert_eq!(authority.authority_revision, 1);
        assert!(authority.capabilities.workspace_write);
        assert!(authority.capabilities.web);
        assert!(!authority.capabilities.shell);
        // Re-preparation returns the same authority.
        let again = persistence
            .prepare_authority(
                &identity(),
                "fresh",
                "context-revision",
                60_000,
                &requested,
                None,
            )
            .unwrap();
        assert_eq!(authority.digest(), again.digest());
        // Revocation fences every downstream read.
        persistence.revoke_run("run-1");
        assert!(persistence.current_authority("run-1").is_none());
    }

    #[test]
    fn v1_rollback_admission_is_restrictive() {
        assert!(requested_capabilities_available_during_v1_rollback(
            &default_requested_capabilities()
        ));
        let mut widened = default_requested_capabilities();
        widened.web = true;
        assert!(!requested_capabilities_available_during_v1_rollback(
            &widened
        ));
    }
}
