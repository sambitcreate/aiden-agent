//! Port of `main/services/subagents/subagent-run-store-dispatcher.ts` — the
//! explicit V1/V2 persistence selection. V2 never falls back to V1 after
//! activation, and rollback selection never opens or mutates V2. The only
//! dual-store mutation is privacy deletion, where the rollback-readable V1
//! marker is installed first and cleared last.

use aiden_core::subagent_runs::{
    adapt_subagent_run_snapshot_v2_to_v1, parse_subagent_run_snapshot,
    parse_subagent_run_snapshot_v2, SubagentRunSnapshot,
};
use serde_json::Value;

use crate::run_store::{RunStoreError, SubagentRunStore};
use crate::run_store_v2::{MutableSubagentPrivateRunManifestV2, SubagentRunStoreV2};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRunStoreSelection {
    V1,
    V2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRunProjection {
    Native,
    V1,
}

pub struct SubagentRunStoreDispatcherOptions {
    pub selection: SubagentRunStoreSelection,
    pub projection: SubagentRunProjection,
    /// V2: runs prepare/commit or verifies an existing committed migration.
    pub prepare_v2: Option<Box<dyn Fn() -> Result<(), RunStoreError> + Send + Sync>>,
    /// V2: fresh-reads V1 and advances V2's source checkpoint.
    pub checkpoint_v1_mutation: Option<Box<dyn Fn() -> Result<(), RunStoreError> + Send + Sync>>,
    pub v1: SubagentRunStore,
    pub v2: Option<std::sync::Arc<SubagentRunStoreV2>>,
}

fn project_v2(
    snapshot: &aiden_core::subagent_runs::SubagentRunSnapshotV2,
    projection: SubagentRunProjection,
) -> Result<SubagentRunSnapshot, RunStoreError> {
    if projection == SubagentRunProjection::Native {
        return Ok(SubagentRunSnapshot::V2(snapshot.clone()));
    }
    let projected = adapt_subagent_run_snapshot_v2_to_v1(snapshot).ok_or_else(|| {
        RunStoreError::message("Subagent V2 history could not be projected safely.")
    })?;
    Ok(SubagentRunSnapshot::V1(projected))
}

pub struct SubagentRunStoreDispatcher {
    options: SubagentRunStoreDispatcherOptions,
    initialized: bool,
}

impl SubagentRunStoreDispatcher {
    pub fn create(options: SubagentRunStoreDispatcherOptions) -> Self {
        SubagentRunStoreDispatcher {
            options,
            initialized: false,
        }
    }

    pub fn selection(&self) -> SubagentRunStoreSelection {
        self.options.selection
    }

    fn require_initialized(&self) -> Result<(), RunStoreError> {
        if !self.initialized {
            return Err(RunStoreError::message(
                "Subagent run-store dispatcher is not initialized.",
            ));
        }
        Ok(())
    }

    fn v2(&self) -> Result<&SubagentRunStoreV2, RunStoreError> {
        self.options
            .v2
            .as_deref()
            .ok_or_else(|| RunStoreError::message("Subagent V2 persistence is unavailable."))
    }

    pub fn reserve_run(&self, run_id: &str) -> Result<(), RunStoreError> {
        self.require_initialized()?;
        if self.options.selection == SubagentRunStoreSelection::V2 {
            self.v2()?.reserve_run(run_id)?;
        }
        Ok(())
    }

    pub fn release_run_reservation(&self, run_id: &str) {
        if self.options.selection == SubagentRunStoreSelection::V2 {
            if let Ok(v2) = self.v2() {
                v2.release_run_reservation(run_id);
            }
        }
    }

    pub fn initialize(&mut self) -> Result<(), RunStoreError> {
        if self.initialized {
            return Ok(());
        }
        match self.options.selection {
            SubagentRunStoreSelection::V1 => {
                self.options.v1.initialize()?;
            }
            SubagentRunStoreSelection::V2 => {
                // Do not initialize V1 here: ordinary V1 startup reconciliation
                // is a write and would invalidate the migration source
                // checkpoint.
                let prepare = self.options.prepare_v2.as_ref().ok_or_else(|| {
                    RunStoreError::message(
                        "V2 persistence requires migration preparation and V1 checkpoint coordination.",
                    )
                })?;
                prepare()?;
                self.v2()?.initialize()?;
            }
        }
        self.initialized = true;
        Ok(())
    }

    pub fn upsert(
        &self,
        value: &Value,
        manifest: Option<&MutableSubagentPrivateRunManifestV2>,
    ) -> Result<SubagentRunSnapshot, RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => {
                let parsed = parse_subagent_run_snapshot(value)
                    .ok_or_else(|| RunStoreError::message("Invalid subagent snapshot."))?;
                let v1 = match parsed {
                    SubagentRunSnapshot::V1(snapshot) => snapshot,
                    SubagentRunSnapshot::V2(snapshot) => {
                        adapt_subagent_run_snapshot_v2_to_v1(&snapshot).ok_or_else(|| {
                            RunStoreError::message(
                            "Subagent V2 snapshot cannot be represented by V1 rollback storage.",
                        )
                        })?
                    }
                };
                let stored = self
                    .options
                    .v1
                    .upsert(&serde_json::to_value(&v1).expect("json"))?;
                Ok(SubagentRunSnapshot::V1(stored))
            }
            SubagentRunStoreSelection::V2 => {
                let _snapshot = parse_subagent_run_snapshot_v2(value).ok_or_else(|| {
                    RunStoreError::message(
                        "V2 persistence requires an exact snapshot and private manifest.",
                    )
                })?;
                let manifest = manifest.ok_or_else(|| {
                    RunStoreError::message(
                        "V2 persistence requires an exact snapshot and private manifest.",
                    )
                })?;
                let manifest_value = serde_json::to_value(manifest).expect("json");
                let stored = self.v2()?.upsert(value, &manifest_value)?;
                project_v2(&stored, self.options.projection)
            }
        }
    }

    pub fn get(&self, run_id: &str) -> Result<Option<SubagentRunSnapshot>, RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self
                .options
                .v1
                .get(run_id)
                .map(|snapshot| snapshot.map(SubagentRunSnapshot::V1)),
            SubagentRunStoreSelection::V2 => {
                let snapshot = self.v2()?.get(run_id)?;
                match snapshot {
                    Some(snapshot) => project_v2(&snapshot, self.options.projection).map(Some),
                    None => Ok(None),
                }
            }
        }
    }

    pub fn list_by_chat(&self, chat_id: &str) -> Result<Vec<SubagentRunSnapshot>, RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => Ok(self
                .options
                .v1
                .list_by_chat(chat_id)?
                .into_iter()
                .map(SubagentRunSnapshot::V1)
                .collect()),
            SubagentRunStoreSelection::V2 => self
                .v2()?
                .list_by_chat(chat_id)?
                .iter()
                .map(|snapshot| project_v2(snapshot, self.options.projection))
                .collect(),
        }
    }

    pub fn prepare_effect(
        &self,
        value: &Value,
    ) -> Result<crate::effect::DurableSubagentEffectV2, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Err(RunStoreError::message(
                "Durable subagent effects require V2 persistence.",
            ));
        }
        self.v2()?.prepare_effect(value)
    }

    pub fn authorize_effect(
        &self,
        value: &Value,
    ) -> Result<crate::effect::DurableSubagentEffectV2, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Err(RunStoreError::message(
                "Durable subagent effects require V2 persistence.",
            ));
        }
        self.v2()?.authorize_effect(value)
    }

    pub fn mark_effect_dispatch_started(
        &self,
        value: &Value,
    ) -> Result<crate::effect::DurableSubagentEffectV2, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Err(RunStoreError::message(
                "Durable subagent effects require V2 persistence.",
            ));
        }
        self.v2()?.mark_effect_dispatch_started(value)
    }

    pub fn cancel_effect_before_dispatch(
        &self,
        value: &Value,
    ) -> Result<crate::effect::DurableSubagentEffectV2, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Err(RunStoreError::message(
                "Durable subagent effects require V2 persistence.",
            ));
        }
        self.v2()?.cancel_effect_before_dispatch(value)
    }

    pub fn finish_effect(
        &self,
        value: &Value,
    ) -> Result<crate::effect::DurableSubagentEffectV2, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Err(RunStoreError::message(
                "Durable subagent effects require V2 persistence.",
            ));
        }
        self.v2()?.finish_effect(value)
    }

    pub fn get_effect(
        &self,
        value: &Value,
    ) -> Result<Option<crate::effect::DurableSubagentEffectV2>, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Ok(None);
        }
        self.v2()?.get_effect(value)
    }

    pub fn list_effects_by_chat(
        &self,
        chat_id: &str,
    ) -> Result<Vec<crate::effect::DurableSubagentEffectV2>, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Ok(Vec::new());
        }
        self.v2()?.list_effects_by_chat(chat_id)
    }

    pub fn list_effect_activity_for_run(
        &self,
        run_id: &str,
        chat_id: &str,
    ) -> Result<Vec<aiden_core::subagent_runs::SubagentEffectActivityV1>, RunStoreError> {
        self.require_initialized()?;
        if self.options.selection != SubagentRunStoreSelection::V2 {
            return Ok(Vec::new());
        }
        self.v2()?.list_effect_activity_for_run(run_id, chat_id)
    }

    /// V2 privacy deletion: V1 marker wins first, V2 cleared last, and only
    /// then the shared checkpoint advances.
    pub fn delete_chat(&self, chat_id: &str) -> Result<(), RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self.options.v1.delete_chat(chat_id),
            SubagentRunStoreSelection::V2 => {
                self.v2()?.preflight_chat_deletion(chat_id)?;
                self.options.v1.delete_chat(chat_id)?;
                self.v2()?.delete_chat(chat_id)?;
                let checkpoint = self.options.checkpoint_v1_mutation.as_ref().ok_or_else(|| {
                    RunStoreError::message(
                        "V2 persistence requires migration preparation and V1 checkpoint coordination.",
                    )
                })?;
                checkpoint()?;
                Ok(())
            }
        }
    }

    pub fn pending_chat_deletions(&self) -> Result<Vec<String>, RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self.options.v1.pending_chat_deletions(),
            SubagentRunStoreSelection::V2 => {
                let v1 = self.options.v1.pending_chat_deletions()?;
                let v2 = self.v2()?.pending_chat_deletions()?;
                let mut merged: Vec<String> = v1;
                for chat_id in v2 {
                    if !merged.contains(&chat_id) {
                        merged.push(chat_id);
                    }
                }
                Ok(merged)
            }
        }
    }

    /// Clearing V1 last keeps rollback fail-closed if either acknowledgement
    /// is interrupted after the chat itself has disappeared.
    pub fn complete_chat_deletion(&self, chat_id: &str) -> Result<(), RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self.options.v1.complete_chat_deletion(chat_id),
            SubagentRunStoreSelection::V2 => {
                self.v2()?.complete_chat_deletion(chat_id)?;
                self.options.v1.complete_chat_deletion(chat_id)?;
                let checkpoint = self.options.checkpoint_v1_mutation.as_ref().ok_or_else(|| {
                    RunStoreError::message(
                        "V2 persistence requires migration preparation and V1 checkpoint coordination.",
                    )
                })?;
                checkpoint()?;
                Ok(())
            }
        }
    }

    pub fn flush(&self) -> Result<(), RunStoreError> {
        self.require_initialized()?;
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self.options.v1.flush(),
            SubagentRunStoreSelection::V2 => {
                self.options.v1.flush()?;
                self.v2()?.flush()
            }
        }
    }

    pub fn close(&self) -> Result<(), RunStoreError> {
        match self.options.selection {
            SubagentRunStoreSelection::V1 => self.options.v1.close(),
            SubagentRunStoreSelection::V2 => {
                self.options.v1.close()?;
                self.v2()?.close()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v1_store(directory: &std::path::Path) -> SubagentRunStore {
        crate::run_store::create_subagent_run_store(
            directory.to_path_buf(),
            crate::run_store::SubagentRunStoreOptions::default(),
        )
        .unwrap()
    }

    fn v2_store(directory: &std::path::Path) -> SubagentRunStoreV2 {
        let store = crate::run_store_v2::create_subagent_run_store_v2(
            directory.to_path_buf(),
            crate::run_store_v2::SubagentRunStoreV2Options::default(),
        )
        .unwrap();
        std::fs::write(
            directory.join("runs.json"),
            serde_json::to_string_pretty(&json!({
                "version": 2,
                "storeRevision": 1,
                "migration": {
                    "status": "committed",
                    "adapterVersion": 1,
                    "source": "missing",
                    "sourceGeneration": "missing",
                    "sourceSha256": "0".repeat(64),
                    "migratedAt": 0,
                },
                "snapshots": [],
                "manifests": [],
                "approvals": [],
                "effects": [],
                "backgroundRuns": [],
                "pendingChatDeletions": [],
                "deletionTransactions": [],
            }))
            .unwrap(),
        )
        .unwrap();
        store.initialize().unwrap();
        store
    }

    fn snapshot(run_id: &str, version: u64) -> Value {
        let mut value = json!({
            "runId": run_id,
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "revision": 1,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": "queued",
            "activity": "Waiting for an execution slot",
            "startedAt": 100,
            "updatedAt": 100,
            "modelId": "model-1",
            "turns": 0,
            "tools": 0,
            "tokens": 0,
            "warnings": [],
        });
        if version == 2 {
            value["version"] = json!(2);
            value["depth"] = json!(1);
            value["execution"] = json!("foreground");
            value["context"] = json!("fresh");
            value["authorityRevision"] = json!(1);
        } else {
            value["version"] = json!(1);
        }
        value
    }

    #[test]
    fn v1_selection_never_opens_v2() {
        let directory = tempfile::tempdir().unwrap();
        let v1 = v1_store(directory.path().join("v1").as_path());
        let mut dispatcher =
            SubagentRunStoreDispatcher::create(SubagentRunStoreDispatcherOptions {
                selection: SubagentRunStoreSelection::V1,
                projection: SubagentRunProjection::Native,
                prepare_v2: None,
                checkpoint_v1_mutation: None,
                v1,
                v2: None,
            });
        dispatcher.initialize().unwrap();
        let stored = dispatcher.upsert(&snapshot("run-1", 1), None).unwrap();
        assert!(matches!(stored, SubagentRunSnapshot::V1(_)));
        assert!(dispatcher.prepare_effect(&json!({})).is_err());
        assert!(dispatcher.get("run-1").unwrap().is_some());
    }

    #[test]
    fn v2_selection_requires_preparation_and_projects_native() {
        let directory = tempfile::tempdir().unwrap();
        let v1 = v1_store(directory.path().join("v1").as_path());
        let v2 = v2_store(directory.path().join("v2").as_path());
        let mut dispatcher =
            SubagentRunStoreDispatcher::create(SubagentRunStoreDispatcherOptions {
                selection: SubagentRunStoreSelection::V2,
                projection: SubagentRunProjection::Native,
                prepare_v2: Some(Box::new(|| Ok(()))),
                checkpoint_v1_mutation: Some(Box::new(|| Ok(()))),
                v1,
                v2: Some(std::sync::Arc::new(v2)),
            });
        dispatcher.initialize().unwrap();
        let snapshot = snapshot("run-1", 2);
        let manifest = json!({
            "version": 2,
            "provenance": "v2_native",
            "runId": "run-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "task": "Explore the workspace.",
            "reusableAuthority": false,
            "authority": json!({
                "version": 2,
                "grantId": "grant-1",
                "treeRootId": "tree-1",
                "runId": "run-1",
                "depth": 1,
                "authorityRevision": 1,
                "generationId": "generation-1",
                "chatId": "chat-1",
                "workspaceId": "workspace-1",
                "workspaceRevision": "workspace-revision-1",
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
                    "shell": false,
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
                "expiresAt": 10_000,
            }),
        });
        let manifest =
            crate::run_store_v2::parse_mutable_subagent_private_run_manifest_v2(&manifest).unwrap();
        let stored = dispatcher.upsert(&snapshot, Some(&manifest)).unwrap();
        assert!(matches!(stored, SubagentRunSnapshot::V2(_)));
        // V2 delete also touches V1 and the checkpoint.
        dispatcher.delete_chat("chat-1").unwrap();
        let pending = dispatcher.pending_chat_deletions().unwrap();
        assert!(pending.contains(&"chat-1".to_string()));
        dispatcher.complete_chat_deletion("chat-1").unwrap();
    }
}
