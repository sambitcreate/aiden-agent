//! Port of `main/services/subagents/subagent-run-store-v2-core.ts` — canonical
//! V2 run persistence: snapshots + private manifests + durable approval/effect
//! journals + background lifecycle records, all behind the same CAS-generation
//! write discipline as V1 (in-process storage).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

pub use aiden_core::subagent_runs::SubagentRunSnapshotV2;
use aiden_core::subagent_runs::{
    parse_subagent_run_snapshot_v2, SubagentRunStateV2, SUBAGENT_ACTIVE_STATES_V2,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::authority::{
    create_subagent_authority_v2, subagent_authority_digest_v2, CreateSubagentAuthorityV2Input,
    SubagentAuthorityV2,
};
use crate::effect::{
    durable_subagent_effect_records_match_v2, is_durable_subagent_effect_terminal_v2,
    parse_durable_subagent_approval_v2, parse_durable_subagent_effect_owner_v2,
    parse_durable_subagent_effect_v2, parse_finish_durable_subagent_effect_v2_input,
    parse_prepare_durable_subagent_effect_v2_input, project_durable_subagent_effect_activity_v1,
    subagent_effect_evidence_digest_v2, DurableSubagentApprovalStateV2, DurableSubagentApprovalV2,
    DurableSubagentEffectOwnerV2, DurableSubagentEffectStateV2, DurableSubagentEffectV2,
};
use crate::run_store::{assert_unique_json_object_keys, RunStoreError, MAX_STORED_SUBAGENT_RUNS};
use crate::run_store_migration::{
    parse_manifest, parse_migration, SubagentPrivateRunManifestV2,
    SubagentRunDatabaseV2 as MigrationSubagentRunDatabaseV2, SubagentRunMigrationV2,
};
use crate::run_store_storage::{
    Generation, ReadResult, StorageFailure, SubagentRunStoreStorage, SubagentRunStoreStorageError,
    MAX_SUBAGENT_RUN_STORE_BYTES,
};

use crate::background_lifecycle::{
    parse_background_subagent_run_v2, BackgroundSubagentRunV2, BackgroundSubagentStoreV2,
};

pub const MAX_SUBAGENT_CHAT_TOMBSTONES_V2: usize = 512;
const MAX_NATIVE_GENERATION_CONFLICT_RETRIES: usize = 1;
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Native (V2-origin) private manifest with the full immutable authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSubagentPrivateRunManifestV2 {
    pub version: u8,
    pub provenance: String,
    pub run_id: String,
    pub generation_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub task: String,
    pub reusable_authority: bool,
    pub authority: SubagentAuthorityV2,
}

/// `MutableSubagentPrivateRunManifestV2` union.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum MutableSubagentPrivateRunManifestV2 {
    Imported(SubagentPrivateRunManifestV2),
    Native(NativeSubagentPrivateRunManifestV2),
}

impl MutableSubagentPrivateRunManifestV2 {
    pub fn run_id(&self) -> &str {
        match self {
            MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.run_id,
            MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.run_id,
        }
    }
    pub fn is_native(&self) -> bool {
        matches!(self, MutableSubagentPrivateRunManifestV2::Native(_))
    }
    pub fn authority(&self) -> Option<&SubagentAuthorityV2> {
        match self {
            MutableSubagentPrivateRunManifestV2::Imported(_) => None,
            MutableSubagentPrivateRunManifestV2::Native(manifest) => Some(&manifest.authority),
        }
    }
}

impl Serialize for MutableSubagentPrivateRunManifestV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            MutableSubagentPrivateRunManifestV2::Imported(manifest) => {
                manifest.serialize(serializer)
            }
            MutableSubagentPrivateRunManifestV2::Native(manifest) => manifest.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for MutableSubagentPrivateRunManifestV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_mutable_subagent_private_run_manifest_v2(&value).ok_or_else(|| {
            serde::de::Error::custom("invalid mutable subagent private run manifest")
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutableSubagentRunDatabaseV2 {
    pub version: u8,
    pub store_revision: u64,
    pub migration: SubagentRunMigrationV2,
    pub snapshots: Vec<SubagentRunSnapshotV2>,
    pub manifests: Vec<MutableSubagentPrivateRunManifestV2>,
    pub approvals: Vec<DurableSubagentApprovalV2>,
    pub effects: Vec<DurableSubagentEffectV2>,
    pub background_runs: Vec<BackgroundSubagentRunV2>,
    pub pending_chat_deletions: Vec<String>,
    pub deletion_transactions: Vec<Value>,
}

impl From<MigrationSubagentRunDatabaseV2> for MutableSubagentRunDatabaseV2 {
    fn from(value: MigrationSubagentRunDatabaseV2) -> Self {
        MutableSubagentRunDatabaseV2 {
            version: value.version,
            store_revision: value.store_revision,
            migration: value.migration,
            snapshots: value.snapshots,
            manifests: value
                .manifests
                .into_iter()
                .map(MutableSubagentPrivateRunManifestV2::Imported)
                .collect(),
            approvals: Vec::new(),
            effects: Vec::new(),
            background_runs: Vec::new(),
            pending_chat_deletions: value.pending_chat_deletions,
            deletion_transactions: value.deletion_transactions,
        }
    }
}

impl From<Value> for MutableSubagentRunDatabaseV2 {
    fn from(value: Value) -> Self {
        parse_mutable_subagent_run_database_v2(&value)
            .or_else(|| {
                crate::run_store_migration::parse_subagent_run_database_v2(&value).map(Into::into)
            })
            .expect("validated migration output")
    }
}

// ===========================================================================
// Parsing
// ===========================================================================

fn exact_keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() >= required.len()
        && object.len() <= required.len() + optional.len()
        && required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn positive_integer(value: &Value) -> bool {
    value.as_u64().map(|value| value >= 1).unwrap_or(false)
}

fn bounded_private_string(value: &Value) -> bool {
    value
        .as_str()
        .map(|value| !value.is_empty() && value.len() <= 256 && !value.contains('\0'))
        .unwrap_or(false)
}

fn parse_authority(value: &Value) -> Option<SubagentAuthorityV2> {
    if !exact_keys(
        value,
        &[
            "version",
            "grantId",
            "treeRootId",
            "runId",
            "depth",
            "authorityRevision",
            "generationId",
            "chatId",
            "workspaceId",
            "workspaceRevision",
            "ownerDocumentId",
            "providerFingerprint",
            "modelFingerprint",
            "contextRevision",
            "execution",
            "context",
            "thinkingLevel",
            "capabilities",
            "budgets",
            "expiresAt",
        ],
        &["parentRunId"],
    ) || !value
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(|level| THINKING_LEVELS.contains(&level))
        .unwrap_or(false)
        || !bounded_private_string(value.get("workspaceRevision")?)
        || !bounded_private_string(value.get("ownerDocumentId")?)
        || !bounded_private_string(value.get("providerFingerprint")?)
        || !bounded_private_string(value.get("modelFingerprint")?)
        || !bounded_private_string(value.get("contextRevision")?)
    {
        return None;
    }
    let input: CreateSubagentAuthorityV2Input = serde_json::from_value(value.clone()).ok()?;
    create_subagent_authority_v2(&input).ok()
}

fn parse_imported_manifest(value: &Value) -> Option<SubagentPrivateRunManifestV2> {
    parse_manifest(value)
}

fn parse_native_manifest(value: &Value) -> Option<NativeSubagentPrivateRunManifestV2> {
    if !exact_keys(
        value,
        &[
            "version",
            "provenance",
            "runId",
            "generationId",
            "childId",
            "chatId",
            "workspaceId",
            "task",
            "reusableAuthority",
            "authority",
        ],
        &[],
    ) || value.get("version").and_then(Value::as_u64) != Some(2)
        || value.get("provenance").and_then(Value::as_str) != Some("v2_native")
        || value.get("reusableAuthority").and_then(Value::as_bool) != Some(false)
    {
        return None;
    }
    let identifiers = ["runId", "generationId", "childId", "chatId", "workspaceId"];
    for key in identifiers {
        let entry = value.get(key).and_then(Value::as_str)?;
        if !crate::safe_text::is_safe_subagent_identifier_str(entry) {
            return None;
        }
    }
    let task = value.get("task").and_then(Value::as_str)?;
    if task.is_empty() || task.len() > 240 || task.contains('\0') {
        return None;
    }
    let authority = parse_authority(value.get("authority")?)?;
    Some(NativeSubagentPrivateRunManifestV2 {
        version: 2,
        provenance: "v2_native".to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        generation_id: value["generationId"].as_str()?.to_string(),
        child_id: value["childId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        workspace_id: value["workspaceId"].as_str()?.to_string(),
        task: task.to_string(),
        reusable_authority: false,
        authority,
    })
}

pub fn parse_mutable_subagent_private_run_manifest_v2(
    value: &Value,
) -> Option<MutableSubagentPrivateRunManifestV2> {
    match value.get("provenance").and_then(Value::as_str) {
        Some("v1_import") => {
            parse_imported_manifest(value).map(MutableSubagentPrivateRunManifestV2::Imported)
        }
        Some("v2_native") => {
            parse_native_manifest(value).map(MutableSubagentPrivateRunManifestV2::Native)
        }
        _ => None,
    }
}

fn manifest_matches_snapshot(
    manifest: &MutableSubagentPrivateRunManifestV2,
    snapshot: &SubagentRunSnapshotV2,
) -> bool {
    if manifest.run_id() != snapshot.run_id
        || manifest_generation(manifest) != snapshot.generation_id
        || manifest_child(manifest) != snapshot.child_id
        || manifest_chat(manifest) != snapshot.chat_id
        || manifest_workspace(manifest) != snapshot.workspace_id
        || manifest_task(manifest) != snapshot.task_preview
    {
        return false;
    }
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(_) => snapshot.authority_revision == 0,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => {
            let authority = &manifest.authority;
            snapshot.authority_revision == authority.authority_revision
                && snapshot.run_id == authority.run_id
                && snapshot.generation_id == authority.generation_id
                && snapshot.chat_id == authority.chat_id
                && snapshot.workspace_id == authority.workspace_id
                && snapshot.depth as u64 == authority.depth as u64
                && snapshot.parent_run_id == authority.parent_run_id
                && snapshot.execution.as_str() == authority.execution.as_str()
                && snapshot.context.as_str() == authority.context.as_str()
        }
    }
}

fn manifest_generation(manifest: &MutableSubagentPrivateRunManifestV2) -> &str {
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.generation_id,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.generation_id,
    }
}
fn manifest_child(manifest: &MutableSubagentPrivateRunManifestV2) -> &str {
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.child_id,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.child_id,
    }
}
fn manifest_chat(manifest: &MutableSubagentPrivateRunManifestV2) -> &str {
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.chat_id,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.chat_id,
    }
}
fn manifest_workspace(manifest: &MutableSubagentPrivateRunManifestV2) -> &str {
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.workspace_id,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.workspace_id,
    }
}
fn manifest_task(manifest: &MutableSubagentPrivateRunManifestV2) -> &str {
    match manifest {
        MutableSubagentPrivateRunManifestV2::Imported(manifest) => &manifest.task,
        MutableSubagentPrivateRunManifestV2::Native(manifest) => &manifest.task,
    }
}

/// Full strict parser for the mutable (canonical) V2 database.
pub fn parse_mutable_subagent_run_database_v2(
    value: &Value,
) -> Option<MutableSubagentRunDatabaseV2> {
    if !exact_keys(
        value,
        &[
            "version",
            "storeRevision",
            "migration",
            "snapshots",
            "manifests",
            "approvals",
            "effects",
            "pendingChatDeletions",
            "deletionTransactions",
        ],
        &["backgroundRuns"],
    ) || value.get("version").and_then(Value::as_u64) != Some(2)
        || !positive_integer(value.get("storeRevision")?)
        || !value.get("snapshots")?.is_array()
        || !value.get("manifests")?.is_array()
    {
        return None;
    }
    let snapshots_value = value.get("snapshots")?.as_array()?;
    let manifests_value = value.get("manifests")?.as_array()?;
    let approvals_value = value.get("approvals")?.as_array()?;
    let effects_value = value.get("effects")?.as_array()?;
    if snapshots_value.len() > MAX_STORED_SUBAGENT_RUNS
        || manifests_value.len() != snapshots_value.len()
        || approvals_value.len() > crate::effect::MAX_DURABLE_SUBAGENT_EFFECTS
        || effects_value.len() > crate::effect::MAX_DURABLE_SUBAGENT_EFFECTS
        || effects_value.len() != approvals_value.len()
    {
        return None;
    }
    let background_value = value.get("backgroundRuns");
    if background_value.is_some() && !background_value.unwrap().is_array() {
        return None;
    }
    if background_value
        .map(|value| {
            value
                .as_array()
                .map(|values| values.len() > MAX_STORED_SUBAGENT_RUNS)
                .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        return None;
    }
    let pending_value = value.get("pendingChatDeletions")?.as_array()?;
    if pending_value.len() > MAX_SUBAGENT_CHAT_TOMBSTONES_V2
        || value
            .get("deletionTransactions")?
            .as_array()
            .map(|values| !values.is_empty())
            .unwrap_or(true)
    {
        return None;
    }
    let migration = parse_migration(value.get("migration")?)?;
    let snapshots: Vec<SubagentRunSnapshotV2> = snapshots_value
        .iter()
        .map(parse_subagent_run_snapshot_v2)
        .collect::<Option<_>>()?;
    let manifests: Vec<MutableSubagentPrivateRunManifestV2> = manifests_value
        .iter()
        .map(parse_mutable_subagent_private_run_manifest_v2)
        .collect::<Option<_>>()?;
    let approvals: Vec<DurableSubagentApprovalV2> = approvals_value
        .iter()
        .map(parse_durable_subagent_approval_v2)
        .collect::<Option<_>>()?;
    let effects: Vec<DurableSubagentEffectV2> = effects_value
        .iter()
        .map(parse_durable_subagent_effect_v2)
        .collect::<Option<_>>()?;
    let background_runs: Vec<BackgroundSubagentRunV2> = match background_value {
        Some(value) => value
            .as_array()
            .expect("checked")
            .iter()
            .map(parse_background_subagent_run_v2)
            .collect::<Option<_>>()?,
        None => Vec::new(),
    };
    let mut pending = Vec::with_capacity(pending_value.len());
    for entry in pending_value {
        let chat_id = entry.as_str()?;
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id)
            || pending.contains(&chat_id.to_string())
        {
            return None;
        }
        pending.push(chat_id.to_string());
    }
    let snapshot_ids: HashSet<&str> = snapshots
        .iter()
        .map(|snapshot| snapshot.run_id.as_str())
        .collect();
    let manifest_ids: HashSet<&str> = manifests.iter().map(|manifest| manifest.run_id()).collect();
    let pending_set: HashSet<&String> = pending.iter().collect();
    let snapshots_by_id: HashMap<&str, &SubagentRunSnapshotV2> = snapshots
        .iter()
        .map(|snapshot| (snapshot.run_id.as_str(), snapshot))
        .collect();
    let manifests_by_id: HashMap<&str, &MutableSubagentPrivateRunManifestV2> = manifests
        .iter()
        .map(|manifest| (manifest.run_id(), manifest))
        .collect();
    let approvals_by_id: HashMap<&str, &DurableSubagentApprovalV2> = approvals
        .iter()
        .map(|approval| (approval.approval_id.as_str(), approval))
        .collect();
    let effects_by_id: HashMap<&str, &DurableSubagentEffectV2> = effects
        .iter()
        .map(|effect| (effect.effect_id.as_str(), effect))
        .collect();
    if snapshot_ids.len() != snapshots.len()
        || manifest_ids.len() != manifests.len()
        || snapshot_ids.len() != manifest_ids.len()
        || manifests.iter().any(|manifest| {
            let Some(snapshot) = snapshots_by_id.get(manifest.run_id()) else {
                return true;
            };
            !manifest_matches_snapshot(manifest, snapshot)
        })
        || snapshots
            .iter()
            .any(|snapshot| pending_set.contains(&snapshot.chat_id))
        || approvals_by_id.len() != approvals.len()
        || effects_by_id.len() != effects.len()
        || approvals
            .iter()
            .any(|approval| effects_by_id.contains_key(approval.approval_id.as_str()))
        || approvals
            .iter()
            .map(|approval| approval.effect_id.as_str())
            .collect::<HashSet<_>>()
            .len()
            != approvals.len()
        || effects
            .iter()
            .map(|effect| effect.approval_id.as_str())
            .collect::<HashSet<_>>()
            .len()
            != effects.len()
        || effects
            .iter()
            .map(|effect| format!("{}\0{}", effect.run_id, effect.tool_call_id))
            .collect::<HashSet<_>>()
            .len()
            != effects.len()
    {
        return None;
    }
    let background_ids: HashSet<&str> = background_runs
        .iter()
        .map(|run| run.snapshot.run_id.as_str())
        .collect();
    if background_ids.len() != background_runs.len()
        || background_runs.iter().any(|run| {
            let Some(snapshot) = snapshots_by_id.get(run.snapshot.run_id.as_str()) else {
                return true;
            };
            let Some(manifest) = manifests_by_id.get(run.snapshot.run_id.as_str()) else {
                return true;
            };
            !manifest.is_native()
                || *snapshot != &run.snapshot
                || manifest.authority() != Some(&run.manifest.authority)
                || manifest_task(manifest) != run.manifest.task
                || pending_set.contains(&run.snapshot.chat_id)
        })
        || effects.iter().any(|effect| {
            let Some(approval) = approvals_by_id.get(effect.approval_id.as_str()) else {
                return true;
            };
            let Some(manifest) = manifests_by_id.get(effect.run_id.as_str()) else {
                return true;
            };
            let Some(authority) = manifest.authority() else {
                return true;
            };
            !durable_subagent_effect_records_match_v2(approval, effect)
                || !manifest.is_native()
                || manifest_chat(manifest) != effect.chat_id
                || manifest_child(manifest) != effect.child_id
                || subagent_authority_digest_v2(authority) != effect.authority_digest
                || pending_set.contains(&effect.chat_id)
        })
    {
        return None;
    }
    Some(MutableSubagentRunDatabaseV2 {
        version: 2,
        store_revision: value.get("storeRevision")?.as_u64()?,
        migration,
        snapshots,
        manifests,
        approvals,
        effects,
        background_runs,
        pending_chat_deletions: pending,
        deletion_transactions: Vec::new(),
    })
}

fn serialized_database(database: &MutableSubagentRunDatabaseV2) -> Result<String, RunStoreError> {
    let parsed = parse_mutable_subagent_run_database_v2(
        &serde_json::to_value(database).map_err(|_| RunStoreError::message("invalid database"))?,
    );
    if parsed.is_none() || parsed.as_ref() != Some(database) {
        return Err(RunStoreError::message(
            "Invalid mutable subagent V2 database.",
        ));
    }
    let serialized = serde_json::to_string_pretty(database)
        .map_err(|_| RunStoreError::message("Invalid mutable subagent V2 database."))?;
    let serialized = format!("{serialized}\n");
    if serialized.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent V2 history exceeds the private store limit.",
        ));
    }
    Ok(serialized)
}

fn parse_durable_contents(contents: &[u8]) -> Result<MutableSubagentRunDatabaseV2, RunStoreError> {
    if contents.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent V2 storage contains oversized evidence and was preserved.",
        ));
    }
    let serialized = String::from_utf8(contents.to_vec()).map_err(|_| {
        RunStoreError::message(
            "Subagent V2 storage contains unreadable evidence and was preserved.",
        )
    })?;
    assert_unique_json_object_keys(&serialized).map_err(|_| {
        RunStoreError::message(
            "Subagent V2 storage contains unreadable evidence and was preserved.",
        )
    })?;
    let value: Value = serde_json::from_str(&serialized).map_err(|_| {
        RunStoreError::message(
            "Subagent V2 storage contains unreadable evidence and was preserved.",
        )
    })?;
    parse_mutable_subagent_run_database_v2(&value).ok_or_else(|| {
        RunStoreError::message("Subagent V2 storage contains invalid evidence and was preserved.")
    })
}

fn stable_identity(left: &SubagentRunSnapshotV2, right: &SubagentRunSnapshotV2) -> bool {
    left.run_id == right.run_id
        && left.group_id == right.group_id
        && left.generation_id == right.generation_id
        && left.child_id == right.child_id
        && left.chat_id == right.chat_id
        && left.workspace_id == right.workspace_id
        && left.role == right.role
        && left.label == right.label
        && left.task_preview == right.task_preview
        && left.started_at == right.started_at
        && left.model_id == right.model_id
        && left.parent_run_id == right.parent_run_id
        && left.retry_of_run_id == right.retry_of_run_id
        && left.depth == right.depth
        && left.execution == right.execution
        && left.context == right.context
        && left.authority_revision == right.authority_revision
}

fn valid_progression(existing: &SubagentRunSnapshotV2, next: &SubagentRunSnapshotV2) -> bool {
    let existing_milestones = existing.milestones.as_deref().unwrap_or(&[]);
    let next_milestones = next.milestones.as_deref().unwrap_or(&[]);
    if !SUBAGENT_ACTIVE_STATES_V2.contains(&existing.state)
        || next.updated_at < existing.updated_at
        || next.turns < existing.turns
        || next.tools < existing.tools
        || next.tokens < existing.tokens
        || next_milestones.len() < existing_milestones.len()
        || existing_milestones
            .iter()
            .zip(next_milestones.iter())
            .any(|(left, right)| left != right)
    {
        return false;
    }
    match existing.state {
        SubagentRunStateV2::Queued => true,
        SubagentRunStateV2::Starting => next.state != SubagentRunStateV2::Queued,
        _ => next.state != SubagentRunStateV2::Queued && next.state != SubagentRunStateV2::Starting,
    }
}

fn newest_first(values: &[SubagentRunSnapshotV2]) -> Vec<SubagentRunSnapshotV2> {
    let mut values = values.to_vec();
    values.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.revision.cmp(&left.revision))
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    values
}

fn interrupt(
    snapshot: &SubagentRunSnapshotV2,
    now: u64,
) -> Result<SubagentRunSnapshotV2, RunStoreError> {
    if !SUBAGENT_ACTIVE_STATES_V2.contains(&snapshot.state) {
        return Ok(snapshot.clone());
    }
    if snapshot.revision >= u64::MAX - 1 {
        return Err(RunStoreError::message(
            "Active subagent V2 evidence cannot be reconciled losslessly.",
        ));
    }
    let mut candidate = snapshot.clone();
    candidate.revision += 1;
    candidate.state = SubagentRunStateV2::Interrupted;
    candidate.activity = Some("Interrupted after Aiden restarted.".to_string());
    candidate.updated_at = snapshot.updated_at.max(now);
    candidate.finished_at = Some(snapshot.updated_at.max(now));
    let value = serde_json::to_value(&candidate).map_err(|_| RunStoreError::message("snapshot"))?;
    parse_subagent_run_snapshot_v2(&value).ok_or_else(|| {
        RunStoreError::message("Active subagent V2 evidence cannot be reconciled losslessly.")
    })
}

fn effect_owner_matches(
    effect: &DurableSubagentEffectV2,
    owner: &DurableSubagentEffectOwnerV2,
) -> bool {
    effect.effect_id == owner.effect_id
        && effect.approval_id == owner.approval_id
        && effect.run_id == owner.run_id
        && effect.chat_id == owner.chat_id
}

fn reconcile_effects_after_restart(
    database: &mut MutableSubagentRunDatabaseV2,
    restart_time: u64,
    fixed_digests: &FixedDigests,
) -> bool {
    let mut changed = false;
    let mut effects = Vec::with_capacity(database.effects.len());
    for effect in &database.effects {
        if !matches!(
            effect.state,
            DurableSubagentEffectStateV2::Prepared
                | DurableSubagentEffectStateV2::Authorized
                | DurableSubagentEffectStateV2::DispatchStarted
        ) {
            effects.push(effect.clone());
            continue;
        }
        changed = true;
        let updated_at = effect.updated_at.max(restart_time);
        let next = if effect.state == DurableSubagentEffectStateV2::DispatchStarted {
            DurableSubagentEffectV2 {
                state: DurableSubagentEffectStateV2::Unknown,
                updated_at,
                terminal_digest: Some(fixed_digests.startup_unknown.to_string()),
                ..effect.clone()
            }
        } else {
            DurableSubagentEffectV2 {
                state: DurableSubagentEffectStateV2::CancelledBeforeDispatch,
                updated_at,
                terminal_digest: Some(fixed_digests.startup_cancelled.to_string()),
                ..effect.clone()
            }
        };
        effects.push(next);
    }
    if !changed {
        return false;
    }
    let effects_by_approval: HashMap<&str, &DurableSubagentEffectV2> = effects
        .iter()
        .map(|effect| (effect.approval_id.as_str(), effect))
        .collect();
    let approvals = database
        .approvals
        .iter()
        .map(|approval| {
            let effect = effects_by_approval
                .get(approval.approval_id.as_str())
                .copied()
                .expect("paired");
            DurableSubagentApprovalV2 {
                state: if effect.state == DurableSubagentEffectStateV2::CancelledBeforeDispatch {
                    DurableSubagentApprovalStateV2::Cancelled
                } else {
                    DurableSubagentApprovalStateV2::Consumed
                },
                updated_at: effect.updated_at,
                ..approval.clone()
            }
        })
        .collect();
    database.effects = effects;
    database.approvals = approvals;
    true
}

pub struct FixedDigests {
    pub startup_cancelled: String,
    pub startup_unknown: String,
    pub explicit_cancelled: String,
    pub terminal_write_unknown: String,
}

impl Default for FixedDigests {
    fn default() -> Self {
        Self::new()
    }
}

impl FixedDigests {
    pub fn new() -> Self {
        FixedDigests {
            startup_cancelled: subagent_effect_evidence_digest_v2(
                "startup_cancelled_before_dispatch",
            ),
            startup_unknown: subagent_effect_evidence_digest_v2("startup_dispatch_outcome_unknown"),
            explicit_cancelled: subagent_effect_evidence_digest_v2("cancelled_before_dispatch"),
            terminal_write_unknown: subagent_effect_evidence_digest_v2(
                "terminal_persistence_failed_outcome_unknown",
            ),
        }
    }
}

// ===========================================================================
// Store
// ===========================================================================

#[derive(Default)]
pub struct SubagentRunStoreV2Options {
    pub now: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
    pub max_runs: Option<usize>,
}

pub struct SubagentRunStoreV2 {
    inner: StdMutex<V2StoreInner>,
}

struct V2StoreInner {
    storage: Box<dyn SubagentRunStoreStorage>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    max_runs: usize,
    initialized: bool,
    deleted_chats: HashSet<String>,
    local_deletion_attempts: HashSet<String>,
    run_reservations: HashSet<String>,
    local_unknown_effects: HashMap<String, DurableSubagentEffectV2>,
    fixed_digests: FixedDigests,
}

impl SubagentRunStoreV2 {
    pub fn create(
        storage_factory: Box<
            dyn Fn(
                    PathBuf,
                )
                    -> Result<Box<dyn SubagentRunStoreStorage>, SubagentRunStoreStorageError>
                + Send
                + Sync,
        >,
        directory: PathBuf,
        options: SubagentRunStoreV2Options,
    ) -> Result<Self, RunStoreError> {
        if !directory.is_absolute() {
            return Err(RunStoreError::message(
                "Subagent V2 storage requires an absolute directory.",
            ));
        }
        let max_runs = options.max_runs.unwrap_or(MAX_STORED_SUBAGENT_RUNS);
        if !(1..=MAX_STORED_SUBAGENT_RUNS).contains(&max_runs) {
            return Err(RunStoreError::message("Invalid subagent V2 history limit."));
        }
        let storage = storage_factory(directory)?;
        Ok(SubagentRunStoreV2 {
            inner: StdMutex::new(V2StoreInner {
                storage,
                now: options.now.unwrap_or_else(|| Box::new(now_millis)),
                max_runs,
                initialized: false,
                deleted_chats: HashSet::new(),
                local_deletion_attempts: HashSet::new(),
                run_reservations: HashSet::new(),
                local_unknown_effects: HashMap::new(),
                fixed_digests: FixedDigests::new(),
            }),
        })
    }

    fn current_time(inner: &V2StoreInner) -> Result<u64, RunStoreError> {
        let value = (inner.now)();
        Ok(value)
    }

    fn read(
        inner: &mut V2StoreInner,
    ) -> Result<(MutableSubagentRunDatabaseV2, String), RunStoreError> {
        let read = inner.storage.read()?;
        let (contents, generation) = match read {
            ReadResult::Missing => {
                return Err(RunStoreError::message(
                    "Committed subagent V2 storage is missing.",
                ))
            }
            ReadResult::Oversized { .. } => {
                return Err(RunStoreError::message(
                    "Subagent V2 storage contains oversized evidence and was preserved.",
                ))
            }
            ReadResult::Data {
                contents,
                generation,
            } => (contents, generation),
        };
        let database = parse_durable_contents(&contents)?;
        if database.migration.status != "committed" {
            return Err(RunStoreError::message(
                "Subagent V2 storage is not committed.",
            ));
        }
        for (effect_id, local) in inner.local_unknown_effects.clone() {
            let persisted = database
                .effects
                .iter()
                .find(|effect| effect.effect_id == effect_id);
            let remove = match persisted {
                Some(persisted) if is_durable_subagent_effect_terminal_v2(persisted.state) => true,
                Some(persisted) => !effect_owner_matches(persisted, &local.into_owner()),
                None => true,
            };
            if remove {
                inner.local_unknown_effects.remove(&effect_id);
            }
        }
        let durable_deletions: HashSet<String> =
            database.pending_chat_deletions.iter().cloned().collect();
        for chat_id in &durable_deletions {
            inner.deleted_chats.insert(chat_id.clone());
        }
        let stale: Vec<String> = inner
            .deleted_chats
            .iter()
            .filter(|chat_id| {
                !durable_deletions.contains(*chat_id)
                    && !inner.local_deletion_attempts.contains(*chat_id)
            })
            .cloned()
            .collect();
        for chat_id in stale {
            inner.deleted_chats.remove(&chat_id);
        }
        Ok((database, generation))
    }

    fn write(
        inner: &mut V2StoreInner,
        expected: &str,
        database: &MutableSubagentRunDatabaseV2,
    ) -> Result<(), RunStoreError> {
        let serialized = serialized_database(database)?;
        inner
            .storage
            .write(expected, &serialized)
            .map_err(RunStoreError::Storage)?;
        Ok(())
    }

    fn mutate(
        inner: &mut V2StoreInner,
        mut transform: impl FnMut(&mut MutableSubagentRunDatabaseV2, &mut V2StoreInner) -> bool,
    ) -> Result<(), RunStoreError> {
        for attempt in 0..=MAX_NATIVE_GENERATION_CONFLICT_RETRIES {
            let (mut database, generation) = Self::read(inner)?;
            let changed = transform(&mut database, inner);
            if !changed {
                return Ok(());
            }
            match Self::write(inner, &generation, &database) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if !matches!(
                        error,
                        RunStoreError::Storage(SubagentRunStoreStorageError {
                            failure: StorageFailure::DestinationChanged
                        })
                    ) || attempt >= MAX_NATIVE_GENERATION_CONFLICT_RETRIES
                    {
                        return Err(error);
                    }
                }
            }
        }
        Err(RunStoreError::message(
            "Subagent V2 storage could not merge a newer generation.",
        ))
    }

    fn require_initialized(inner: &V2StoreInner) -> Result<(), RunStoreError> {
        if !inner.initialized {
            return Err(RunStoreError::message(
                "Subagent V2 storage is not initialized.",
            ));
        }
        Ok(())
    }

    pub fn initialize(&self) -> Result<(), RunStoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        if inner.initialized {
            return Ok(());
        }
        inner.storage.cleanup()?;
        let restart_time = Self::current_time(&inner)?;
        Self::mutate(&mut inner, |database, inner| {
            let mut changed = false;
            let mut snapshots = Vec::with_capacity(database.snapshots.len());
            for snapshot in &database.snapshots {
                match interrupt(snapshot, restart_time) {
                    Ok(interrupted) => {
                        if &interrupted != snapshot {
                            changed = true;
                        }
                        snapshots.push(interrupted);
                    }
                    Err(_) => return false,
                }
            }
            let snapshots_by_run_id: HashMap<&str, &SubagentRunSnapshotV2> = snapshots
                .iter()
                .map(|snapshot| (snapshot.run_id.as_str(), snapshot))
                .collect();
            let mut background_runs = Vec::with_capacity(database.background_runs.len());
            for run in &database.background_runs {
                let snapshot = snapshots_by_run_id
                    .get(run.snapshot.run_id.as_str())
                    .copied();
                let Some(snapshot) = snapshot else {
                    return false;
                };
                if snapshot == &run.snapshot {
                    background_runs.push(run.clone());
                    continue;
                }
                changed = true;
                let sequence = run.events.last().map(|event| event.sequence).unwrap_or(0) + 1;
                let mut next = run.clone();
                next.snapshot = snapshot.clone();
                let next_event = crate::background_lifecycle::BackgroundSubagentEventV2 {
                    sequence,
                    at: snapshot.updated_at,
                    kind: "reconciled".to_string(),
                    state: snapshot.state,
                };
                if next.events.len() >= crate::background_lifecycle::MAX_BACKGROUND_EVENTS_V2 {
                    next.events.remove(0);
                }
                next.events.push(next_event);
                background_runs.push(next);
            }
            let mut effects_reconciled =
                reconcile_effects_after_restart(database, restart_time, &inner.fixed_digests);
            let snapshots_unchanged = !changed;
            let background_unchanged = background_runs == database.background_runs;
            database.snapshots = snapshots;
            database.background_runs = background_runs;
            if snapshots_unchanged && background_unchanged && !effects_reconciled {
                return false;
            }
            if !effects_reconciled {
                // reconcile_effects_after_restart already mutated in place; flag for write.
                effects_reconciled = true;
            }
            database.store_revision += 1;
            changed
        })?;
        inner.initialized = true;
        Ok(())
    }

    pub fn reserve_run(&self, run_id: &str) -> Result<(), RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(run_id) {
            return Err(RunStoreError::message(
                "Invalid subagent V2 run reservation.",
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        if inner.run_reservations.contains(run_id) {
            return Ok(());
        }
        let (database, _) = Self::read(&mut inner)?;
        if database
            .snapshots
            .iter()
            .any(|snapshot| snapshot.run_id == run_id)
        {
            return Err(RunStoreError::message(
                "Subagent V2 run identity was reused.",
            ));
        }
        if database.snapshots.len() + inner.run_reservations.len() >= inner.max_runs {
            return Err(RunStoreError::message(
                "Subagent V2 history is at capacity. Delete an older chat before starting more delegated work.",
            ));
        }
        inner.run_reservations.insert(run_id.to_string());
        Ok(())
    }

    pub fn release_run_reservation(&self, run_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.run_reservations.remove(run_id);
        }
    }

    pub fn upsert(
        &self,
        value: &Value,
        manifest_value: &Value,
    ) -> Result<SubagentRunSnapshotV2, RunStoreError> {
        let snapshot = parse_subagent_run_snapshot_v2(value)
            .ok_or_else(|| RunStoreError::message("Invalid subagent V2 run and manifest."))?;
        let manifest = parse_mutable_subagent_private_run_manifest_v2(manifest_value)
            .ok_or_else(|| RunStoreError::message("Invalid subagent V2 run and manifest."))?;
        if !manifest_matches_snapshot(&manifest, &snapshot) {
            return Err(RunStoreError::message(
                "Invalid subagent V2 run and manifest.",
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        if inner.deleted_chats.contains(&snapshot.chat_id) {
            return Err(RunStoreError::ChatDeleted);
        }
        Self::mutate(&mut inner, |database, inner| {
            if database.pending_chat_deletions.contains(&snapshot.chat_id) {
                inner.deleted_chats.insert(snapshot.chat_id.clone());
                // Signal by returning false and then erroring outside.
                return false;
            }
            let existing_index = database
                .snapshots
                .iter()
                .position(|entry| entry.run_id == snapshot.run_id);
            if let Some(existing_index) = existing_index {
                let existing = database.snapshots[existing_index].clone();
                let existing_manifest = database
                    .manifests
                    .iter()
                    .find(|entry| entry.run_id() == snapshot.run_id)
                    .cloned()
                    .expect("paired");
                if !stable_identity(&existing, &snapshot) || existing_manifest != manifest {
                    return false;
                }
                if snapshot.revision <= existing.revision {
                    if snapshot == existing {
                        return false;
                    }
                    return false;
                }
                if !valid_progression(&existing, &snapshot) {
                    return false;
                }
                database.snapshots[existing_index] = snapshot.clone();
            } else {
                let existing_count = database.snapshots.len() + inner.run_reservations.len()
                    - if inner.run_reservations.contains(&snapshot.run_id) {
                        1
                    } else {
                        0
                    };
                if existing_count >= inner.max_runs {
                    return false;
                }
                database.snapshots.push(snapshot.clone());
                database.manifests.push(manifest.clone());
            }
            database.snapshots = newest_first(&database.snapshots);
            database.store_revision += 1;
            true
        })?;
        inner.run_reservations.remove(&snapshot.run_id);
        Ok(snapshot.clone())
    }

    pub fn get(&self, run_id: &str) -> Result<Option<SubagentRunSnapshotV2>, RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(run_id) {
            return Ok(None);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        let snapshot = database
            .snapshots
            .iter()
            .find(|entry| entry.run_id == run_id)
            .cloned();
        Ok(match snapshot {
            Some(snapshot) if !inner.deleted_chats.contains(&snapshot.chat_id) => Some(snapshot),
            _ => None,
        })
    }

    pub fn list_by_chat(&self, chat_id: &str) -> Result<Vec<SubagentRunSnapshotV2>, RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return Ok(Vec::new());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        if inner.deleted_chats.contains(chat_id) {
            return Ok(Vec::new());
        }
        Ok(newest_first(
            &database
                .snapshots
                .iter()
                .filter(|snapshot| snapshot.chat_id == chat_id)
                .cloned()
                .collect::<Vec<_>>(),
        ))
    }

    fn transition_effect(
        &self,
        value: &Value,
        expected_state: DurableSubagentEffectStateV2,
        next_state: DurableSubagentEffectStateV2,
        approval_state: DurableSubagentApprovalStateV2,
    ) -> Result<DurableSubagentEffectV2, RunStoreError> {
        let owner = parse_durable_subagent_effect_owner_v2(value)
            .ok_or_else(|| RunStoreError::message("Invalid durable subagent V2 effect owner."))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let updated_at = Self::current_time(&inner)?;
        let mut transitioned: Option<DurableSubagentEffectV2> = None;
        let mut expired_before_dispatch = false;
        let owner_clone = owner.clone();
        let result = Self::mutate(&mut inner, |database, inner| {
            let effect_index = database
                .effects
                .iter()
                .position(|effect| effect.effect_id == owner_clone.effect_id);
            let Some(effect_index) = effect_index else {
                return false;
            };
            let effect = database.effects[effect_index].clone();
            if !effect_owner_matches(&effect, &owner_clone) {
                return false;
            }
            if effect.state != expected_state {
                return false;
            }
            let approval_index = database
                .approvals
                .iter()
                .position(|approval| approval.approval_id == owner_clone.approval_id)
                .expect("paired");
            let approval = database.approvals[approval_index].clone();
            if expected_state == DurableSubagentEffectStateV2::Prepared
                && approval.expires_at <= updated_at
            {
                return false;
            }
            if expected_state == DurableSubagentEffectStateV2::Authorized
                && approval.expires_at <= updated_at
            {
                expired_before_dispatch = true;
                transitioned = Some(DurableSubagentEffectV2 {
                    state: DurableSubagentEffectStateV2::CancelledBeforeDispatch,
                    updated_at: effect.updated_at.max(updated_at),
                    terminal_digest: Some(inner.fixed_digests.explicit_cancelled.clone()),
                    ..effect.clone()
                });
                database.approvals[approval_index] = DurableSubagentApprovalV2 {
                    state: DurableSubagentApprovalStateV2::Cancelled,
                    updated_at: transitioned.as_ref().expect("set").updated_at,
                    ..approval
                };
                database.effects[effect_index] = transitioned.clone().expect("set");
                database.store_revision += 1;
                return true;
            }
            transitioned = Some(DurableSubagentEffectV2 {
                state: next_state,
                updated_at: effect.updated_at.max(updated_at),
                ..effect.clone()
            });
            database.approvals[approval_index] = DurableSubagentApprovalV2 {
                state: approval_state,
                updated_at: transitioned.as_ref().expect("set").updated_at,
                ..approval
            };
            database.effects[effect_index] = transitioned.clone().expect("set");
            database.store_revision += 1;
            true
        });
        result?;
        if expired_before_dispatch {
            return Err(RunStoreError::message(
                "Durable subagent V2 approval expired before dispatch.",
            ));
        }
        transitioned
            .ok_or_else(|| RunStoreError::message("Durable subagent V2 effect transition failed."))
    }

    pub fn prepare_effect(&self, value: &Value) -> Result<DurableSubagentEffectV2, RunStoreError> {
        let input = parse_prepare_durable_subagent_effect_v2_input(value).ok_or_else(|| {
            RunStoreError::message("Invalid durable subagent V2 effect preparation.")
        })?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let prepared_at = Self::current_time(&inner)?;
        if input.expires_at <= prepared_at {
            return Err(RunStoreError::message(
                "Durable subagent V2 approval is already expired.",
            ));
        }
        let mut prepared: Option<DurableSubagentEffectV2> = None;
        let input_clone = input.clone();
        Self::mutate(&mut inner, |database, inner| {
            if database
                .pending_chat_deletions
                .contains(&input_clone.chat_id)
                || inner.deleted_chats.contains(&input_clone.chat_id)
            {
                return false;
            }
            let manifest = database
                .manifests
                .iter()
                .find(|manifest| manifest.run_id() == input_clone.run_id)
                .cloned();
            let Some(manifest) = manifest else {
                return false;
            };
            let Some(authority) = manifest.authority() else {
                return false;
            };
            if manifest_chat(&manifest) != input_clone.chat_id
                || manifest_child(&manifest) != input_clone.child_id
                || subagent_authority_digest_v2(authority) != input_clone.authority_digest
            {
                return false;
            }
            if database.effects.len() >= crate::effect::MAX_DURABLE_SUBAGENT_EFFECTS {
                return false;
            }
            let reused = database.effects.iter().any(|effect| {
                effect.effect_id == input_clone.effect_id
                    || effect.approval_id == input_clone.approval_id
                    || effect.effect_id == input_clone.approval_id
                    || effect.approval_id == input_clone.effect_id
                    || (effect.run_id == input_clone.run_id
                        && effect.tool_call_id == input_clone.tool_call_id)
            }) || input_clone.approval_id == input_clone.effect_id;
            if reused {
                return false;
            }
            let approval = DurableSubagentApprovalV2 {
                version: 1,
                approval_id: input_clone.approval_id.clone(),
                effect_id: input_clone.effect_id.clone(),
                run_id: input_clone.run_id.clone(),
                chat_id: input_clone.chat_id.clone(),
                child_id: input_clone.child_id.clone(),
                tool_call_id: input_clone.tool_call_id.clone(),
                tool_name: input_clone.tool_name.clone(),
                state: DurableSubagentApprovalStateV2::Prepared,
                argument_digest: input_clone.argument_digest.clone(),
                effect_digest: input_clone.effect_digest.clone(),
                authority_digest: input_clone.authority_digest.clone(),
                created_at: prepared_at,
                updated_at: prepared_at,
                expires_at: input_clone.expires_at,
            };
            let effect = DurableSubagentEffectV2 {
                version: 1,
                effect_id: input_clone.effect_id.clone(),
                approval_id: input_clone.approval_id.clone(),
                run_id: input_clone.run_id.clone(),
                chat_id: input_clone.chat_id.clone(),
                child_id: input_clone.child_id.clone(),
                tool_call_id: input_clone.tool_call_id.clone(),
                tool_name: input_clone.tool_name.clone(),
                effect_kind: input_clone.effect_kind,
                state: DurableSubagentEffectStateV2::Prepared,
                argument_digest: input_clone.argument_digest.clone(),
                effect_digest: input_clone.effect_digest.clone(),
                authority_digest: input_clone.authority_digest.clone(),
                prepared_at,
                updated_at: prepared_at,
                terminal_digest: None,
            };
            database.approvals.push(approval);
            database.effects.push(effect.clone());
            database.store_revision += 1;
            prepared = Some(effect);
            true
        })?;
        prepared.ok_or_else(|| {
            let reused = true;
            if reused {
                RunStoreError::message("Durable subagent V2 effect identity was reused.")
            } else {
                RunStoreError::message("Subagent history is no longer available for this chat.")
            }
        })
    }

    pub fn authorize_effect(
        &self,
        value: &Value,
    ) -> Result<DurableSubagentEffectV2, RunStoreError> {
        self.transition_effect(
            value,
            DurableSubagentEffectStateV2::Prepared,
            DurableSubagentEffectStateV2::Authorized,
            DurableSubagentApprovalStateV2::Authorized,
        )
    }

    pub fn mark_effect_dispatch_started(
        &self,
        value: &Value,
    ) -> Result<DurableSubagentEffectV2, RunStoreError> {
        self.transition_effect(
            value,
            DurableSubagentEffectStateV2::Authorized,
            DurableSubagentEffectStateV2::DispatchStarted,
            DurableSubagentApprovalStateV2::Consumed,
        )
    }

    pub fn cancel_effect_before_dispatch(
        &self,
        value: &Value,
    ) -> Result<DurableSubagentEffectV2, RunStoreError> {
        let owner = parse_durable_subagent_effect_owner_v2(value)
            .ok_or_else(|| RunStoreError::message("Invalid durable subagent V2 effect owner."))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let updated_at = Self::current_time(&inner)?;
        let mut cancelled: Option<DurableSubagentEffectV2> = None;
        let owner_clone = owner.clone();
        Self::mutate(&mut inner, |database, inner| {
            let effect_index = database
                .effects
                .iter()
                .position(|effect| effect.effect_id == owner_clone.effect_id);
            let Some(effect_index) = effect_index else {
                return false;
            };
            let effect = database.effects[effect_index].clone();
            if !effect_owner_matches(&effect, &owner_clone) {
                return false;
            }
            if !matches!(
                effect.state,
                DurableSubagentEffectStateV2::Prepared | DurableSubagentEffectStateV2::Authorized
            ) {
                return false;
            }
            cancelled = Some(DurableSubagentEffectV2 {
                state: DurableSubagentEffectStateV2::CancelledBeforeDispatch,
                updated_at: effect.updated_at.max(updated_at),
                terminal_digest: Some(inner.fixed_digests.explicit_cancelled.clone()),
                ..effect.clone()
            });
            let approval_index = database
                .approvals
                .iter()
                .position(|approval| approval.approval_id == owner_clone.approval_id)
                .expect("paired");
            database.approvals[approval_index] = DurableSubagentApprovalV2 {
                state: DurableSubagentApprovalStateV2::Cancelled,
                updated_at: cancelled.as_ref().expect("set").updated_at,
                ..database.approvals[approval_index].clone()
            };
            database.effects[effect_index] = cancelled.clone().expect("set");
            database.store_revision += 1;
            true
        })?;
        cancelled
            .ok_or_else(|| RunStoreError::message("Durable subagent V2 effect transition failed."))
    }

    pub fn finish_effect(&self, value: &Value) -> Result<DurableSubagentEffectV2, RunStoreError> {
        let input = parse_finish_durable_subagent_effect_v2_input(value).ok_or_else(|| {
            RunStoreError::message("Invalid durable subagent V2 effect completion.")
        })?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        Self::read(&mut inner)?;
        if let Some(existing_unknown) = inner.local_unknown_effects.get(&input.effect_id) {
            if existing_unknown.effect_id == input.effect_id
                && existing_unknown.approval_id == input.approval_id
                && existing_unknown.run_id == input.run_id
                && existing_unknown.chat_id == input.chat_id
            {
                return Ok(existing_unknown.clone());
            }
            return Err(RunStoreError::message(
                "Durable subagent V2 effect ownership mismatch.",
            ));
        }
        let updated_at = Self::current_time(&inner)?;
        let mut finished: Option<DurableSubagentEffectV2> = None;
        let mut dispatched: Option<DurableSubagentEffectV2> = None;
        let input_clone = input.clone();
        let mutate_result = Self::mutate(&mut inner, |database, _inner| {
            let effect_index = database
                .effects
                .iter()
                .position(|effect| effect.effect_id == input_clone.effect_id);
            let Some(effect_index) = effect_index else {
                return false;
            };
            let effect = database.effects[effect_index].clone();
            if !effect_owner_matches(&effect, &owner_from_input(&input_clone)) {
                return false;
            }
            if effect.state != DurableSubagentEffectStateV2::DispatchStarted {
                return false;
            }
            dispatched = Some(effect.clone());
            finished = Some(DurableSubagentEffectV2 {
                state: input_clone.state,
                updated_at: effect.updated_at.max(updated_at),
                terminal_digest: Some(input_clone.terminal_digest.clone()),
                ..effect.clone()
            });
            let approval_index = database
                .approvals
                .iter()
                .position(|approval| approval.approval_id == input_clone.approval_id)
                .expect("paired");
            database.approvals[approval_index] = DurableSubagentApprovalV2 {
                updated_at: finished.as_ref().expect("set").updated_at,
                ..database.approvals[approval_index].clone()
            };
            database.effects[effect_index] = finished.clone().expect("set");
            database.store_revision += 1;
            true
        });
        match mutate_result {
            Ok(()) => {
                inner.local_unknown_effects.remove(&input.effect_id);
                finished.ok_or_else(|| {
                    RunStoreError::message(
                        "Durable subagent V2 effect must be dispatch-started before completion.",
                    )
                })
            }
            Err(error) => {
                if let Some(dispatched) = dispatched {
                    let failure_time = Self::current_time(&inner)?;
                    let unknown = DurableSubagentEffectV2 {
                        state: DurableSubagentEffectStateV2::Unknown,
                        updated_at: dispatched.updated_at.max(failure_time),
                        terminal_digest: Some(inner.fixed_digests.terminal_write_unknown.clone()),
                        ..dispatched
                    };
                    let read = Self::read(&mut inner);
                    let mut keep_unknown = true;
                    if let Ok((database, _)) = read {
                        if let Some(persisted) = database
                            .effects
                            .iter()
                            .find(|effect| effect.effect_id == input.effect_id)
                        {
                            if effect_owner_matches(persisted, &owner_from_input(&input))
                                && is_durable_subagent_effect_terminal_v2(persisted.state)
                            {
                                keep_unknown = false;
                            }
                        }
                    }
                    if keep_unknown {
                        inner
                            .local_unknown_effects
                            .insert(input.effect_id.clone(), unknown);
                    }
                }
                Err(error)
            }
        }
    }

    pub fn get_effect(
        &self,
        value: &Value,
    ) -> Result<Option<DurableSubagentEffectV2>, RunStoreError> {
        let owner = parse_durable_subagent_effect_owner_v2(value);
        let Some(owner) = owner else {
            return Ok(None);
        };
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        if let Some(local) = inner.local_unknown_effects.get(&owner.effect_id) {
            return Ok(Some(local.clone()));
        }
        let effect = database
            .effects
            .iter()
            .find(|effect| effect.effect_id == owner.effect_id)
            .cloned();
        Ok(match effect {
            Some(effect) if effect_owner_matches(&effect, &owner) => Some(effect),
            _ => None,
        })
    }

    pub fn list_effects_by_chat(
        &self,
        chat_id: &str,
    ) -> Result<Vec<DurableSubagentEffectV2>, RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return Ok(Vec::new());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        if inner.deleted_chats.contains(chat_id) {
            return Ok(Vec::new());
        }
        let (database, _) = Self::read(&mut inner)?;
        Ok(database
            .effects
            .iter()
            .filter(|effect| effect.chat_id == chat_id)
            .map(|effect| {
                inner
                    .local_unknown_effects
                    .get(&effect.effect_id)
                    .cloned()
                    .unwrap_or_else(|| effect.clone())
            })
            .collect())
    }

    pub fn list_effect_activity_for_run(
        &self,
        run_id: &str,
        chat_id: &str,
    ) -> Result<Vec<aiden_core::subagent_runs::SubagentEffectActivityV1>, RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(run_id)
            || !crate::safe_text::is_safe_subagent_identifier_str(chat_id)
        {
            return Ok(Vec::new());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        let snapshot = database
            .snapshots
            .iter()
            .find(|entry| entry.run_id == run_id);
        let Some(snapshot) = snapshot else {
            return Ok(Vec::new());
        };
        if snapshot.chat_id != chat_id || inner.deleted_chats.contains(chat_id) {
            return Ok(Vec::new());
        }
        let mut effects: Vec<&DurableSubagentEffectV2> = database
            .effects
            .iter()
            .filter(|effect| effect.run_id == run_id && effect.chat_id == chat_id)
            .collect();
        effects.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .then_with(|| left.effect_id.cmp(&right.effect_id))
        });
        Ok(effects
            .iter()
            .map(|effect| {
                let effect = inner
                    .local_unknown_effects
                    .get(&effect.effect_id)
                    .unwrap_or(*effect);
                project_durable_subagent_effect_activity_v1(effect)
            })
            .collect())
    }

    pub fn preflight_chat_deletion(&self, chat_id: &str) -> Result<(), RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return Err(RunStoreError::message("Invalid subagent V2 chat deletion."));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        if database.effects.iter().any(|effect| {
            if effect.chat_id != chat_id {
                return false;
            }
            let local = inner.local_unknown_effects.get(&effect.effect_id);
            local.is_none() && !is_durable_subagent_effect_terminal_v2(effect.state)
        }) {
            return Err(RunStoreError::message(
                "Subagent V2 chat has active durable effects and cannot be deleted.",
            ));
        }
        Ok(())
    }

    pub fn delete_chat(&self, chat_id: &str) -> Result<(), RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return Ok(());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        inner.deleted_chats.insert(chat_id.to_string());
        inner.local_deletion_attempts.insert(chat_id.to_string());
        let result = (|| -> Result<(), RunStoreError> {
            Self::require_initialized(&inner)?;
            Self::mutate(&mut inner, |database, inner| {
                if database.effects.iter().any(|effect| {
                    if effect.chat_id != chat_id {
                        return false;
                    }
                    let local = inner.local_unknown_effects.get(&effect.effect_id);
                    local.is_none() && !is_durable_subagent_effect_terminal_v2(effect.state)
                }) {
                    return false;
                }
                let before_len = database.snapshots.len();
                let before_pending_len = database.pending_chat_deletions.len();
                database
                    .snapshots
                    .retain(|snapshot| snapshot.chat_id != chat_id);
                database
                    .manifests
                    .retain(|manifest| manifest_chat(manifest) != chat_id);
                database
                    .approvals
                    .retain(|approval| approval.chat_id != chat_id);
                database.effects.retain(|effect| effect.chat_id != chat_id);
                database
                    .background_runs
                    .retain(|run| run.snapshot.chat_id != chat_id);
                if !database
                    .pending_chat_deletions
                    .contains(&chat_id.to_string())
                {
                    database.pending_chat_deletions.push(chat_id.to_string());
                }
                if database.pending_chat_deletions.len() > MAX_SUBAGENT_CHAT_TOMBSTONES_V2 {
                    return false;
                }
                if database.snapshots.len() == before_len
                    && database.pending_chat_deletions.len() == before_pending_len
                {
                    return false;
                }
                database.store_revision += 1;
                true
            })?;
            let local_ids: Vec<String> = inner
                .local_unknown_effects
                .keys()
                .filter(|effect_id| {
                    inner
                        .local_unknown_effects
                        .get(*effect_id)
                        .map(|effect| effect.chat_id == chat_id)
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            for effect_id in local_ids {
                inner.local_unknown_effects.remove(&effect_id);
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                inner.local_deletion_attempts.remove(chat_id);
                Ok(())
            }
            Err(error) => {
                if error.to_string().contains("active durable effects") {
                    inner.deleted_chats.remove(chat_id);
                    inner.local_deletion_attempts.remove(chat_id);
                }
                inner.local_deletion_attempts.remove(chat_id);
                Err(error)
            }
        }
    }

    pub fn pending_chat_deletions(&self) -> Result<Vec<String>, RunStoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        Ok(database.pending_chat_deletions.clone())
    }

    pub fn complete_chat_deletion(&self, chat_id: &str) -> Result<(), RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return Ok(());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        Self::mutate(&mut inner, |database, _inner| {
            let before = database.pending_chat_deletions.len();
            database
                .pending_chat_deletions
                .retain(|pending| pending != chat_id);
            if database.pending_chat_deletions.len() == before {
                return false;
            }
            database.store_revision += 1;
            true
        })?;
        inner.deleted_chats.remove(chat_id);
        inner.local_deletion_attempts.remove(chat_id);
        Ok(())
    }

    /// `updateV1Checkpoint` — advance the frozen V1 checkpoint after an
    /// intentional rollback-journal mutation.
    pub fn update_v1_checkpoint(
        &self,
        source: &str,
        source_generation: &str,
        source_sha256: &str,
    ) -> Result<(), RunStoreError> {
        if (source != "missing" && source != "v1")
            || !Generation::is_safe(source_generation)
            || source_sha256.len() != 64
            || !source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || (source == "missing" && source_generation != "missing")
            || (source == "v1" && source_generation == "missing")
        {
            return Err(RunStoreError::message("Invalid subagent V1 checkpoint."));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        Self::mutate(&mut inner, |database, _inner| {
            if database.migration.source == source
                && database.migration.source_generation == source_generation
                && database.migration.source_sha256 == source_sha256
            {
                return false;
            }
            database.migration.source = source.to_string();
            database.migration.source_generation = source_generation.to_string();
            database.migration.source_sha256 = source_sha256.to_string();
            database.store_revision += 1;
            true
        })?;
        Ok(())
    }

    pub fn flush(&self) -> Result<(), RunStoreError> {
        Ok(())
    }

    pub fn close(&self) -> Result<(), RunStoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        inner.storage.close()?;
        Ok(())
    }

    /// Background lifecycle store port.
    pub fn background_get(
        &self,
        run_id: &str,
    ) -> Result<Option<BackgroundSubagentRunV2>, RunStoreError> {
        if !crate::safe_text::is_safe_subagent_identifier_str(run_id) {
            return Ok(None);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        let run = database
            .background_runs
            .iter()
            .find(|candidate| candidate.snapshot.run_id == run_id)
            .cloned();
        Ok(match run {
            Some(run) if !inner.deleted_chats.contains(&run.snapshot.chat_id) => Some(run),
            _ => None,
        })
    }

    pub fn background_list(&self) -> Result<Vec<BackgroundSubagentRunV2>, RunStoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        let (database, _) = Self::read(&mut inner)?;
        Ok(database
            .background_runs
            .iter()
            .filter(|run| !inner.deleted_chats.contains(&run.snapshot.chat_id))
            .cloned()
            .collect())
    }

    /// CAS background put (`expected_revision == None` means create-only).
    pub fn background_put(
        &self,
        value: &Value,
        expected_revision: Option<u64>,
    ) -> Result<bool, RunStoreError> {
        let run = parse_background_subagent_run_v2(value).ok_or_else(|| {
            RunStoreError::message("Invalid private background lifecycle record.")
        })?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("poisoned"))?;
        Self::require_initialized(&inner)?;
        if inner.deleted_chats.contains(&run.snapshot.chat_id) {
            return Err(RunStoreError::message(
                "Background lifecycle is no longer available for this chat.",
            ));
        }
        let mut applied = false;
        let run_clone = run.clone();
        Self::mutate(&mut inner, |database, inner| {
            let current_index = database
                .background_runs
                .iter()
                .position(|candidate| candidate.snapshot.run_id == run_clone.snapshot.run_id);
            let current = current_index.map(|index| database.background_runs[index].clone());
            match (&expected_revision, &current) {
                (None, Some(_)) | (Some(_), None) => {
                    applied = false;
                    return false;
                }
                (None, None) => {
                    if database
                        .snapshots
                        .iter()
                        .any(|snapshot| snapshot.run_id == run_clone.snapshot.run_id)
                    {
                        applied = false;
                        return false;
                    }
                }
                (Some(expected), Some(current)) => {
                    if current.snapshot.revision != *expected {
                        applied = false;
                        return false;
                    }
                }
            }
            let manifest = native_manifest_for_background(&run_clone);
            if let Some(_current) = &current {
                let existing_snapshot = database
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot.run_id == run_clone.snapshot.run_id);
                let existing_manifest = database
                    .manifests
                    .iter()
                    .find(|manifest| manifest.run_id() == run_clone.snapshot.run_id);
                let Some(existing_snapshot) = existing_snapshot else {
                    return false;
                };
                let Some(existing_manifest) = existing_manifest else {
                    return false;
                };
                if !stable_identity(existing_snapshot, &run_clone.snapshot)
                    || *existing_manifest != manifest
                    || !valid_progression(existing_snapshot, &run_clone.snapshot)
                {
                    return false;
                }
            } else if database.snapshots.len() >= inner.max_runs {
                return false;
            }
            applied = true;
            database.snapshots = newest_first(&{
                let mut next = database.snapshots.clone();
                next.retain(|snapshot| snapshot.run_id != run_clone.snapshot.run_id);
                next.push(run_clone.snapshot.clone());
                next
            });
            database
                .manifests
                .retain(|entry| entry.run_id() != run_clone.snapshot.run_id);
            database.manifests.push(manifest);
            database
                .background_runs
                .retain(|candidate| candidate.snapshot.run_id != run_clone.snapshot.run_id);
            database.background_runs.push(run_clone.clone());
            database.store_revision += 1;
            true
        })?;
        Ok(applied)
    }
}

fn native_manifest_for_background(
    run: &BackgroundSubagentRunV2,
) -> MutableSubagentPrivateRunManifestV2 {
    MutableSubagentPrivateRunManifestV2::Native(NativeSubagentPrivateRunManifestV2 {
        version: 2,
        provenance: "v2_native".to_string(),
        run_id: run.snapshot.run_id.clone(),
        generation_id: run.snapshot.generation_id.clone(),
        child_id: run.snapshot.child_id.clone(),
        chat_id: run.snapshot.chat_id.clone(),
        workspace_id: run.snapshot.workspace_id.clone(),
        task: run.manifest.task.clone(),
        reusable_authority: false,
        authority: run.manifest.authority.clone(),
    })
}

fn owner_from_input(
    input: &crate::effect::FinishDurableSubagentEffectV2Input,
) -> DurableSubagentEffectOwnerV2 {
    DurableSubagentEffectOwnerV2 {
        effect_id: input.effect_id.clone(),
        approval_id: input.approval_id.clone(),
        run_id: input.run_id.clone(),
        chat_id: input.chat_id.clone(),
    }
}

impl DurableSubagentEffectV2 {
    fn into_owner(self) -> DurableSubagentEffectOwnerV2 {
        DurableSubagentEffectOwnerV2 {
            effect_id: self.effect_id,
            approval_id: self.approval_id,
            run_id: self.run_id,
            chat_id: self.chat_id,
        }
    }
}

impl BackgroundSubagentStoreV2 for SubagentRunStoreV2 {
    fn get(&self, run_id: &str) -> Result<Option<BackgroundSubagentRunV2>, String> {
        self.background_get(run_id)
            .map_err(|error| error.to_string())
    }
    fn put(
        &self,
        run: &BackgroundSubagentRunV2,
        expected_revision: Option<u64>,
    ) -> Result<bool, String> {
        let value = serde_json::to_value(run).map_err(|error| error.to_string())?;
        self.background_put(&value, expected_revision)
            .map_err(|error| error.to_string())
    }
    fn list(&self) -> Result<Vec<BackgroundSubagentRunV2>, String> {
        self.background_list().map_err(|error| error.to_string())
    }
}

pub fn create_subagent_run_store_v2(
    directory: PathBuf,
    options: SubagentRunStoreV2Options,
) -> Result<SubagentRunStoreV2, RunStoreError> {
    let factory: Box<
        dyn Fn(PathBuf) -> Result<Box<dyn SubagentRunStoreStorage>, SubagentRunStoreStorageError>
            + Send
            + Sync,
    > = Box::new(|directory| {
        Ok(
            Box::new(crate::run_store_storage::InProcessSubagentRunStoreStorage::new(directory)?)
                as Box<dyn SubagentRunStoreStorage>,
        )
    });
    SubagentRunStoreV2::create(factory, directory, options)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::{create_subagent_authority_v2, CreateSubagentAuthorityV2Input};
    use serde_json::json;

    fn budget() -> Value {
        json!({
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
        })
    }

    fn capabilities() -> Value {
        json!({
            "workspaceRead": true,
            "workspaceWrite": false,
            "shell": false,
            "web": false,
            "delegation": false,
            "mcp": [],
        })
    }

    fn authority(run_id: &str) -> SubagentAuthorityV2 {
        let input: CreateSubagentAuthorityV2Input = serde_json::from_value(json!({
            "grantId": "grant-1",
            "treeRootId": "tree-1",
            "runId": run_id,
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
            "capabilities": capabilities(),
            "budgets": budget(),
            "expiresAt": 10_000,
        }))
        .unwrap();
        create_subagent_authority_v2(&input).unwrap()
    }

    fn snapshot(run_id: &str, revision: u64, state: &str, chat_id: &str) -> Value {
        let mut value = json!({
            "version": 2,
            "runId": run_id,
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": chat_id,
            "workspaceId": "workspace-1",
            "revision": revision,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": state,
            "activity": "Reviewing workspace context",
            "startedAt": 100,
            "updatedAt": 100 + revision * 100,
            "modelId": "model-1",
            "turns": 0,
            "tools": 0,
            "tokens": 0,
            "warnings": [],
            "depth": 1,
            "execution": "foreground",
            "context": "fresh",
            "authorityRevision": 1,
        });
        if matches!(
            state,
            "completed" | "failed" | "timed_out" | "interrupted" | "stopped"
        ) {
            value["finishedAt"] = json!(100 + revision * 100);
        }
        value
    }

    fn native_manifest(run_id: &str, task: &str) -> Value {
        let authority = authority(run_id);
        json!({
            "version": 2,
            "provenance": "v2_native",
            "runId": run_id,
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "task": task,
            "reusableAuthority": false,
            "authority": authority,
        })
    }

    fn v2_store() -> (tempfile::TempDir, SubagentRunStoreV2) {
        v2_store_at()
    }

    fn v2_store_at() -> (tempfile::TempDir, SubagentRunStoreV2) {
        let directory = tempfile::tempdir().unwrap();
        let store = create_subagent_run_store_v2(
            directory.path().to_path_buf(),
            SubagentRunStoreV2Options {
                now: Some(Box::new(|| 1_000)),
                max_runs: None,
            },
        )
        .unwrap();
        std::fs::write(
            directory.path().join("runs.json"),
            committed_database_json(),
        )
        .unwrap();
        // Initialize a committed database so every operation has canonical state.
        store.initialize().unwrap();
        (directory, store)
    }

    fn committed_database_json() -> String {
        serde_json::json!({
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
        })
        .to_string()
    }

    #[test]
    fn initialize_and_reserve_run() {
        let (directory, store) = {
            let directory = tempfile::tempdir().unwrap();
            let store = create_subagent_run_store_v2(
                directory.path().to_path_buf(),
                SubagentRunStoreV2Options::default(),
            )
            .unwrap();
            std::fs::write(
                directory.path().join("runs.json"),
                committed_database_json(),
            )
            .unwrap();
            store.initialize().unwrap();
            (directory, store)
        };
        let _ = directory;
        store.reserve_run("run-1").unwrap();
        // Re-reservation is idempotent.
        store.reserve_run("run-1").unwrap();
        store.release_run_reservation("run-1");
        // Unsafe identity fails.
        assert!(store.reserve_run("not safe!").is_err());
    }

    #[test]
    fn upsert_requires_a_matching_manifest() {
        let (_directory, store) = v2_store();
        let snapshot_value = snapshot("run-1", 1, "queued", "chat-1");
        let manifest = native_manifest("run-1", "Explore the workspace.");
        let stored = store.upsert(&snapshot_value, &manifest).unwrap();
        assert_eq!(stored.run_id, "run-1");
        // Without a manifest it fails.
        assert!(store.upsert(&snapshot_value, &json!({})).is_err());
        // Manifest must match the snapshot identity.
        let mismatched = native_manifest("run-other", "Explore the workspace.");
        assert!(store.upsert(&snapshot_value, &mismatched).is_err());
        // Re-upserting the identical snapshot is an idempotent no-op.
        assert!(store.upsert(&snapshot_value, &manifest).is_ok());
        let running = snapshot("run-1", 2, "running", "chat-1");
        store.upsert(&running, &manifest).unwrap();
        let got = store.get("run-1").unwrap().unwrap();
        assert_eq!(got.revision, 2);
    }

    #[test]
    fn prepare_authorize_dispatch_finish_effect_lifecycle() {
        let (_directory, store) = v2_store();
        store
            .upsert(
                &snapshot("run-1", 1, "queued", "chat-1"),
                &native_manifest("run-1", "Explore the workspace."),
            )
            .unwrap();
        let digest = |byte: u8| format!("{byte:02x}").repeat(32);
        let authority_digest = crate::authority::subagent_authority_digest_v2(&authority("run-1"));
        let prepare = json!({
            "approvalId": "approval-1",
            "effectId": "effect-1",
            "runId": "run-1",
            "chatId": "chat-1",
            "childId": "child-1",
            "toolCallId": "call-1",
            "toolName": "run_command",
            "effectKind": "shell",
            "argumentDigest": digest(1),
            "effectDigest": digest(2),
            "authorityDigest": authority_digest,
            "expiresAt": 100_000,
        });
        let prepared = store.prepare_effect(&prepare).unwrap();
        assert_eq!(prepared.state, DurableSubagentEffectStateV2::Prepared);
        let owner = json!({
            "effectId": "effect-1",
            "approvalId": "approval-1",
            "runId": "run-1",
            "chatId": "chat-1",
        });
        // authorize -> dispatch -> finish completed.
        let authorized = store.authorize_effect(&owner).unwrap();
        assert_eq!(authorized.state, DurableSubagentEffectStateV2::Authorized);
        let dispatched = store.mark_effect_dispatch_started(&owner).unwrap();
        assert_eq!(
            dispatched.state,
            DurableSubagentEffectStateV2::DispatchStarted
        );
        let finish = json!({
            "effectId": "effect-1",
            "approvalId": "approval-1",
            "runId": "run-1",
            "chatId": "chat-1",
            "state": "completed",
            "terminalDigest": digest(9),
        });
        let finished = store.finish_effect(&finish).unwrap();
        assert_eq!(finished.state, DurableSubagentEffectStateV2::Completed);
        assert!(store.finish_effect(&finish).is_err());
        // Effect activity projection is bounded and renderer-safe.
        let activity = store
            .list_effect_activity_for_run("run-1", "chat-1")
            .unwrap();
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].version, 1);
    }

    #[test]
    fn delete_chat_refuses_active_effects() {
        let (_directory, store) = v2_store();
        store
            .upsert(
                &snapshot("run-1", 1, "queued", "chat-1"),
                &native_manifest("run-1", "Explore the workspace."),
            )
            .unwrap();
        let digest = |byte: u8| format!("{byte:02x}").repeat(32);
        let authority_digest = crate::authority::subagent_authority_digest_v2(&authority("run-1"));
        store
            .prepare_effect(&json!({
                "approvalId": "approval-1",
                "effectId": "effect-1",
                "runId": "run-1",
                "chatId": "chat-1",
                "childId": "child-1",
                "toolCallId": "call-1",
                "toolName": "run_command",
                "effectKind": "shell",
                "argumentDigest": digest(1),
                "effectDigest": digest(2),
                "authorityDigest": authority_digest,
                "expiresAt": 100_000,
            }))
            .unwrap();
        assert!(store.preflight_chat_deletion("chat-1").is_err());
        // Cancel before dispatch, then delete succeeds.
        let owner = json!({
            "effectId": "effect-1",
            "approvalId": "approval-1",
            "runId": "run-1",
            "chatId": "chat-1",
        });
        store.cancel_effect_before_dispatch(&owner).unwrap();
        store.preflight_chat_deletion("chat-1").unwrap();
        store.delete_chat("chat-1").unwrap();
        assert_eq!(store.pending_chat_deletions().unwrap(), vec!["chat-1"]);
        assert!(store.get("run-1").unwrap().is_none());
        store.complete_chat_deletion("chat-1").unwrap();
        assert!(store.pending_chat_deletions().unwrap().is_empty());
    }

    #[test]
    fn restart_reconciles_active_effects_to_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runs.json");
        std::fs::write(&path, committed_database_json()).unwrap();
        let authority_digest = crate::authority::subagent_authority_digest_v2(&authority("run-1"));
        {
            let store = create_subagent_run_store_v2(
                directory.path().to_path_buf(),
                SubagentRunStoreV2Options {
                    now: Some(Box::new(|| 1_000)),
                    max_runs: None,
                },
            )
            .unwrap();
            store.initialize().unwrap();
            store
                .upsert(
                    &snapshot("run-1", 1, "queued", "chat-1"),
                    &native_manifest("run-1", "Explore the workspace."),
                )
                .unwrap();
            let digest = |byte: u8| format!("{byte:02x}").repeat(32);
            store
                .prepare_effect(&json!({
                    "approvalId": "approval-1",
                    "effectId": "effect-1",
                    "runId": "run-1",
                    "chatId": "chat-1",
                    "childId": "child-1",
                    "toolCallId": "call-1",
                    "toolName": "run_command",
                    "effectKind": "shell",
                    "argumentDigest": digest(1),
                    "effectDigest": digest(2),
                    "authorityDigest": authority_digest,
                    "expiresAt": 100_000,
                }))
                .unwrap();
        }
        let store = create_subagent_run_store_v2(
            directory.path().to_path_buf(),
            SubagentRunStoreV2Options {
                now: Some(Box::new(|| 1_000)),
                max_runs: None,
            },
        )
        .unwrap();
        store.initialize().unwrap();
        let owner = json!({
            "effectId": "effect-1",
            "approvalId": "approval-1",
            "runId": "run-1",
            "chatId": "chat-1",
        });
        let effect = store.get_effect(&owner).unwrap().unwrap();
        assert_eq!(
            effect.state,
            DurableSubagentEffectStateV2::CancelledBeforeDispatch
        );
        // The run snapshot was interrupted by the restart reconciliation.
        let run = store.get("run-1").unwrap().unwrap();
        assert_eq!(run.state, SubagentRunStateV2::Interrupted);
    }

    #[test]
    fn corrupted_committed_store_fails_closed_without_panicking_or_destroying_evidence() {
        let directory = tempfile::tempdir().unwrap();
        // A truncated / partially-written runs.json (e.g. an interrupted
        // external write). The store must not crash, must not silently delete
        // the evidence, and must fail every subsequent mutation.
        let corrupted = "{\"version\":2,\"storeRevision\":1,\"migration\":{";
        std::fs::write(directory.path().join("runs.json"), corrupted).unwrap();

        let store = create_subagent_run_store_v2(
            directory.path().to_path_buf(),
            SubagentRunStoreV2Options {
                now: Some(Box::new(|| 1_000)),
                max_runs: None,
            },
        )
        .unwrap();
        // initialize surfaces the corruption as an error (no panic).
        let error = store.initialize().unwrap_err();
        assert!(error.to_string().contains("preserved"), "{error}");
        // The corrupt file is left in place (preserved as evidence).
        let on_disk = std::fs::read(directory.path().join("runs.json")).unwrap();
        assert_eq!(String::from_utf8_lossy(&on_disk), corrupted);
        // Every later mutation fails closed instead of overwriting the
        // unreadable store.
        assert!(store.reserve_run("run-1").is_err());
        assert!(store
            .upsert(
                &snapshot("run-1", 1, "queued", "chat-1"),
                &native_manifest("run-1", "Explore the workspace."),
            )
            .is_err());
    }
}
