//! Port of `main/services/subagents/subagent-run-store-v2-migration.ts` — the
//! prepared/committed V2 migration that runs **beside** V1 without ever writing
//! or normalizing V1.
//!
//! A prepared migration freezes a V1 checkpoint (source + generation +
//! sha256). The V2 file is written with `migration.status == "prepared"` and
//! only flipped to `"committed"` after the V1 checkpoint is re-read and proven
//! unchanged; any V1 drift blocks activation instead of making deleted history
//! visible again.

use aiden_core::subagent_runs::{adapt_subagent_run_snapshot_v1_to_v2, SubagentRunSnapshotV2};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::run_store::{parse_subagent_run_database_v1_for_migration, RunStoreError};
use crate::run_store_storage::{
    Generation, ReadResult, SubagentRunStoreStorage, SubagentRunStoreStorageError,
    MAX_SUBAGENT_RUN_STORE_BYTES,
};

pub const STORE_VERSION_V2: u8 = 2;
pub const MIGRATION_ADAPTER_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunMigrationV2 {
    pub status: String,
    pub adapter_version: u8,
    pub source: String,
    pub source_generation: String,
    pub source_sha256: String,
    pub migrated_at: u64,
}

/// Imported (V1-origin) private manifest; `authority` is never persisted for
/// imported runs (they carry no V2 grant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPrivateRunManifestV2 {
    pub version: u8,
    pub provenance: String,
    pub run_id: String,
    pub generation_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub task: String,
    pub reusable_authority: bool,
}

/// The migration (prepared) V2 database schema: exactly the keys a committed
/// V1→V2 migration can carry, with empty approvals/effects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunDatabaseV2 {
    pub version: u8,
    pub store_revision: u64,
    pub migration: SubagentRunMigrationV2,
    pub snapshots: Vec<SubagentRunSnapshotV2>,
    pub manifests: Vec<SubagentPrivateRunManifestV2>,
    pub approvals: Vec<Value>,
    pub effects: Vec<Value>,
    pub pending_chat_deletions: Vec<String>,
    pub deletion_transactions: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct V1Checkpoint {
    pub source: String,
    pub generation: String,
    pub sha256: String,
    pub serialized: Option<String>,
}

fn has_exact_keys(value: &Value, keys: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
}

fn safe_generation(value: &Value) -> bool {
    value.as_str().map(Generation::is_safe).unwrap_or(false)
}

pub fn parse_migration(value: &Value) -> Option<SubagentRunMigrationV2> {
    if !has_exact_keys(
        value,
        &[
            "status",
            "adapterVersion",
            "source",
            "sourceGeneration",
            "sourceSha256",
            "migratedAt",
        ],
    ) {
        return None;
    }
    let status = value.get("status").and_then(Value::as_str)?;
    if status != "prepared" && status != "committed" {
        return None;
    }
    if value.get("adapterVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let source = value.get("source").and_then(Value::as_str)?;
    if source != "missing" && source != "v1" {
        return None;
    }
    let source_generation = value.get("sourceGeneration")?;
    if !safe_generation(source_generation) {
        return None;
    }
    let source_sha256 = value.get("sourceSha256").and_then(Value::as_str)?;
    if source_sha256.len() != 64 || !source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let migrated_at = value.get("migratedAt")?.as_u64()?;
    let generation_is_missing = source_generation.as_str() == Some("missing");
    if (source == "missing" && !generation_is_missing) || (source == "v1" && generation_is_missing)
    {
        return None;
    }
    Some(SubagentRunMigrationV2 {
        status: status.to_string(),
        adapter_version: 1,
        source: source.to_string(),
        source_generation: source_generation.as_str()?.to_string(),
        source_sha256: source_sha256.to_string(),
        migrated_at,
    })
}

pub fn parse_manifest(value: &Value) -> Option<SubagentPrivateRunManifestV2> {
    if !has_exact_keys(
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
        ],
    ) || value.get("version").and_then(Value::as_u64) != Some(2)
        || value.get("provenance").and_then(Value::as_str) != Some("v1_import")
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
    if task.trim().is_empty() || task.len() > 8_000 || task.contains('\0') {
        return None;
    }
    if value.get("reusableAuthority").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    Some(SubagentPrivateRunManifestV2 {
        version: 2,
        provenance: "v1_import".to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        generation_id: value["generationId"].as_str()?.to_string(),
        child_id: value["childId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        workspace_id: value["workspaceId"].as_str()?.to_string(),
        task: task.to_string(),
        reusable_authority: false,
    })
}

/// Strict parser for the migration-phase (prepared) schema.
pub fn parse_subagent_run_database_v2(value: &Value) -> Option<SubagentRunDatabaseV2> {
    if !has_exact_keys(
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
    ) || value.get("version").and_then(Value::as_u64) != Some(2)
        || value
            .get("storeRevision")
            .and_then(Value::as_u64)
            .map(|v| v < 1)
            .unwrap_or(true)
    {
        return None;
    }
    let snapshots_value = value.get("snapshots").and_then(Value::as_array)?;
    let manifests_value = value.get("manifests").and_then(Value::as_array)?;
    if snapshots_value.len() > 512 || manifests_value.len() != snapshots_value.len() {
        return None;
    }
    if value
        .get("approvals")
        .and_then(Value::as_array)
        .map(|values| !values.is_empty())
        .unwrap_or(true)
        || value
            .get("effects")
            .and_then(Value::as_array)
            .map(|values| !values.is_empty())
            .unwrap_or(true)
    {
        return None;
    }
    let migration = parse_migration(value.get("migration")?)?;
    let snapshots: Vec<SubagentRunSnapshotV2> = snapshots_value
        .iter()
        .map(aiden_core::subagent_runs::parse_subagent_run_snapshot_v2)
        .collect::<Option<_>>()?;
    let manifests: Vec<SubagentPrivateRunManifestV2> = manifests_value
        .iter()
        .map(parse_manifest)
        .collect::<Option<_>>()?;
    let pending_chat_deletions = value.get("pendingChatDeletions")?.as_array()?;
    if pending_chat_deletions.len() > 512 {
        return None;
    }
    let mut pending = Vec::with_capacity(pending_chat_deletions.len());
    for entry in pending_chat_deletions {
        let chat_id = entry.as_str()?;
        if !crate::safe_text::is_safe_subagent_identifier_str(chat_id) {
            return None;
        }
        if pending.contains(&chat_id.to_string()) {
            return None;
        }
        pending.push(chat_id.to_string());
    }
    let snapshot_by_run: std::collections::HashMap<&str, &SubagentRunSnapshotV2> = snapshots
        .iter()
        .map(|snapshot| (snapshot.run_id.as_str(), snapshot))
        .collect();
    if snapshot_by_run.len() != snapshots.len() {
        return None;
    }
    let mut manifest_ids = std::collections::HashSet::new();
    for manifest in &manifests {
        if !manifest_ids.insert(manifest.run_id.as_str()) {
            return None;
        }
        let snapshot = snapshot_by_run.get(manifest.run_id.as_str())?;
        if snapshot.generation_id != manifest.generation_id
            || snapshot.child_id != manifest.child_id
            || snapshot.chat_id != manifest.chat_id
            || snapshot.workspace_id != manifest.workspace_id
            || snapshot.task_preview != manifest.task
            || snapshot.authority_revision != 0
        {
            return None;
        }
    }
    if snapshots
        .iter()
        .any(|snapshot| pending.contains(&snapshot.chat_id))
    {
        return None;
    }
    Some(SubagentRunDatabaseV2 {
        version: 2,
        store_revision: value.get("storeRevision")?.as_u64()?,
        migration,
        snapshots,
        manifests,
        approvals: Vec::new(),
        effects: Vec::new(),
        pending_chat_deletions: pending,
        deletion_transactions: Vec::new(),
    })
}

fn sha256_hex(contents: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(contents);
    crate::authority::hex(&hasher.finalize())
}

fn read_v1_checkpoint(
    storage: &dyn SubagentRunStoreStorage,
) -> Result<V1Checkpoint, RunStoreError> {
    match storage.read()? {
        ReadResult::Oversized { .. } => Err(RunStoreError::message(
            "Subagent V1 migration source is oversized and was preserved.",
        )),
        ReadResult::Missing => Ok(V1Checkpoint {
            source: "missing".to_string(),
            generation: "missing".to_string(),
            sha256: sha256_hex(&[]),
            serialized: None,
        }),
        ReadResult::Data {
            generation,
            contents,
        } => {
            let decoded = String::from_utf8(contents.clone()).map_err(|_| {
                RunStoreError::message("Subagent run migration contains invalid UTF-8 evidence.")
            })?;
            Ok(V1Checkpoint {
                source: "v1".to_string(),
                generation,
                sha256: sha256_hex(&contents),
                serialized: Some(decoded),
            })
        }
    }
}

/// Fresh raw evidence used after an intentional rollback-journal mutation
/// (`readSubagentRunStoreV1CheckpointV2`).
pub fn read_subagent_run_store_v1_checkpoint_v2(
    storage: &dyn SubagentRunStoreStorage,
) -> Result<(String, String, String), RunStoreError> {
    let checkpoint = read_v1_checkpoint(storage)?;
    Ok((checkpoint.source, checkpoint.generation, checkpoint.sha256))
}

fn same_checkpoint(checkpoint: &V1Checkpoint, migration: &SubagentRunMigrationV2) -> bool {
    checkpoint.source == migration.source
        && checkpoint.generation == migration.source_generation
        && checkpoint.sha256 == migration.source_sha256
}

fn migrated_database(
    checkpoint: &V1Checkpoint,
    now: u64,
) -> Result<SubagentRunDatabaseV2, RunStoreError> {
    let source = match &checkpoint.serialized {
        Some(serialized) => parse_subagent_run_database_v1_for_migration(serialized)?,
        None => SubagentRunDatabaseV1Empty {
            version: 1,
            runs: Vec::new(),
            pending_chat_deletions: Vec::new(),
        }
        .into(),
    };
    let mut snapshots = Vec::with_capacity(source.runs.len());
    for snapshot in &source.runs {
        let migrated = adapt_subagent_run_snapshot_v1_to_v2(snapshot).ok_or_else(|| {
            RunStoreError::message("Subagent V1 run could not be migrated losslessly.")
        })?;
        snapshots.push(migrated);
    }
    let manifests = source
        .runs
        .iter()
        .map(|snapshot| SubagentPrivateRunManifestV2 {
            version: 2,
            provenance: "v1_import".to_string(),
            run_id: snapshot.run_id.clone(),
            generation_id: snapshot.generation_id.clone(),
            child_id: snapshot.child_id.clone(),
            chat_id: snapshot.chat_id.clone(),
            workspace_id: snapshot.workspace_id.clone(),
            task: snapshot.task_preview.clone(),
            reusable_authority: false,
        })
        .collect();
    Ok(SubagentRunDatabaseV2 {
        version: 2,
        store_revision: 1,
        migration: SubagentRunMigrationV2 {
            status: "prepared".to_string(),
            adapter_version: 1,
            source: checkpoint.source.clone(),
            source_generation: checkpoint.generation.clone(),
            source_sha256: checkpoint.sha256.clone(),
            migrated_at: now,
        },
        snapshots,
        manifests,
        approvals: Vec::new(),
        effects: Vec::new(),
        pending_chat_deletions: source.pending_chat_deletions.clone(),
        deletion_transactions: Vec::new(),
    })
}

#[derive(Debug, Clone)]
pub struct SubagentRunDatabaseV1Empty {
    pub version: u8,
    pub runs: Vec<aiden_core::subagent_runs::SubagentRunSnapshotV1>,
    pub pending_chat_deletions: Vec<String>,
}

impl From<SubagentRunDatabaseV1Empty> for crate::run_store::SubagentRunDatabaseV1 {
    fn from(value: SubagentRunDatabaseV1Empty) -> Self {
        crate::run_store::SubagentRunDatabaseV1 {
            version: value.version,
            runs: value.runs,
            pending_chat_deletions: value.pending_chat_deletions,
        }
    }
}

fn serialize(database: &SubagentRunDatabaseV2) -> Result<String, RunStoreError> {
    let serialized = serde_json::to_string_pretty(database)
        .map_err(|_| RunStoreError::message("Subagent V2 migration output is invalid."))?;
    let serialized = format!("{serialized}\n");
    if serialized.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent V2 migration output exceeds its store limit.",
        ));
    }
    Ok(serialized)
}

/// Prepare/commit V2 beside V1 without ever writing or normalizing V1
/// (`migrateSubagentRunStoreV2`). `v2_mutable_parse` understands both the
/// prepared and native schemas for the activation verifier.
pub fn migrate_subagent_run_store_v2(
    v1_storage: &dyn SubagentRunStoreStorage,
    v2_storage: &dyn SubagentRunStoreStorage,
    now: u64,
    _v2_mutable_parse: impl Fn(&Value) -> Option<crate::run_store_v2::MutableSubagentRunDatabaseV2>,
) -> Result<Value, RunStoreError> {
    v2_storage.cleanup()?;
    let v2_read = v2_storage.read()?;
    let existing_value = match &v2_read {
        ReadResult::Missing => None,
        ReadResult::Oversized { .. } => {
            return Err(RunStoreError::message(
                "Subagent V2 migration evidence is oversized and was preserved.",
            ))
        }
        ReadResult::Data { contents, .. } => {
            if contents.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
                return Err(RunStoreError::message(
                    "Subagent V2 migration evidence is oversized and was preserved.",
                ));
            }
            let serialized = String::from_utf8(contents.clone()).map_err(|_| {
                RunStoreError::message(
                    "Subagent V2 migration evidence is unreadable and was preserved.",
                )
            })?;
            crate::run_store::assert_unique_json_object_keys(&serialized).map_err(|_| {
                RunStoreError::message(
                    "Subagent V2 migration evidence is unreadable and was preserved.",
                )
            })?;
            let value: Value = serde_json::from_str(&serialized).map_err(|_| {
                RunStoreError::message(
                    "Subagent V2 migration evidence is unreadable and was preserved.",
                )
            })?;
            Some(value)
        }
    };
    let existing_generation = match &v2_read {
        ReadResult::Missing => "missing".to_string(),
        ReadResult::Data { generation, .. } | ReadResult::Oversized { generation } => {
            generation.clone()
        }
    };
    let checkpoint = read_v1_checkpoint(v1_storage)?;
    // Committed migration: verify the checkpoint then reuse.
    let prepared_commit = match &existing_value {
        Some(value) => {
            let database = crate::run_store_v2::parse_mutable_subagent_run_database_v2(value)
                .or_else(|| parse_subagent_run_database_v2(value).map(Into::into));
            match database {
                Some(database) if database.migration.status == "committed" => {
                    if !same_checkpoint(&checkpoint, &database.migration) {
                        return Err(RunStoreError::message(
                            "Subagent V1 changed after V2 migration; automatic merge is blocked.",
                        ));
                    }
                    Some(database)
                }
                Some(database) if database.migration.status == "prepared" => {
                    // Prepared migration: must be pure V1-import schema.
                    let prepared = existing_value
                        .as_ref()
                        .and_then(parse_subagent_run_database_v2);
                    if prepared.is_none() {
                        return Err(RunStoreError::message(
                            "A prepared subagent V2 migration cannot contain native run manifests.",
                        ));
                    }
                    Some(database)
                }
                _ => None,
            }
        }
        None => None,
    };
    let mut generation = existing_generation;
    let prepared_value = existing_value;
    let prepared_database = match prepared_commit {
        Some(database) => Some(database),
        None => {
            if let Some(prepared) = prepared_value
                .as_ref()
                .and_then(parse_subagent_run_database_v2)
            {
                if !same_checkpoint(&checkpoint, &prepared.migration) {
                    return Err(RunStoreError::message(
                        "Subagent V1 changed while V2 migration was prepared.",
                    ));
                }
                let _ = prepared_value;
                Some(Into::<crate::run_store_v2::MutableSubagentRunDatabaseV2>::into(prepared))
            } else {
                let migrated = migrated_database(&checkpoint, now)?;
                let serialized = serialize(&migrated)?;
                generation = v2_storage.write("missing", &serialized)?;
                let value: Value = serde_json::from_str(&serialized).map_err(|_| {
                    RunStoreError::message("Subagent V2 migration output is invalid.")
                })?;
                Some(Into::<crate::run_store_v2::MutableSubagentRunDatabaseV2>::into(value))
            }
        }
    };
    let prepared = prepared_database.expect("prepared migration");
    // Re-verify the checkpoint immediately before commit.
    let verified = read_v1_checkpoint(v1_storage)?;
    if !same_checkpoint(&verified, &prepared.migration) {
        return Err(RunStoreError::message(
            "Subagent V1 changed before V2 migration could commit.",
        ));
    }
    let committed = {
        let mut database = prepared;
        database.store_revision += 1;
        database.migration.status = "committed".to_string();
        database
    };
    let serialized = serde_json::to_string_pretty(&committed)
        .map_err(|_| RunStoreError::message("Subagent V2 migration output is invalid."))?;
    let serialized = format!("{serialized}\n");
    if serialized.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent V2 migration output exceeds its store limit.",
        ));
    }
    v2_storage.write(&generation, &serialized)?;
    let value: Value = serde_json::from_str(&serialized)
        .map_err(|_| RunStoreError::message("Subagent V2 migration output is invalid."))?;
    Ok(value)
}

pub fn default_v2_storage(
    directory: &std::path::Path,
) -> Result<Box<dyn SubagentRunStoreStorage>, SubagentRunStoreStorageError> {
    Ok(Box::new(
        crate::run_store_storage::InProcessSubagentRunStoreStorage::new(directory.to_path_buf())?,
    ))
}

impl ReadResult {
    pub fn generation(&self) -> String {
        match self {
            ReadResult::Missing => "missing".to_string(),
            ReadResult::Oversized { generation } | ReadResult::Data { generation, .. } => {
                generation.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_store_storage::InProcessSubagentRunStoreStorage;
    use serde_json::json;

    #[test]
    fn migration_parses_exact_prepared_schema() {
        let value = json!({
            "version": 2,
            "storeRevision": 1,
            "migration": {
                "status": "prepared",
                "adapterVersion": 1,
                "source": "missing",
                "sourceGeneration": "missing",
                "sourceSha256": "a".repeat(64),
                "migratedAt": 100,
            },
            "snapshots": [],
            "manifests": [],
            "approvals": [],
            "effects": [],
            "pendingChatDeletions": [],
            "deletionTransactions": [],
        });
        let parsed = parse_subagent_run_database_v2(&value).unwrap();
        assert_eq!(parsed.version, 2);
        assert_eq!(parsed.migration.source, "missing");
        // v1 source requires a generation token.
        let mut bad = value.clone();
        bad["migration"]["source"] = json!("v1");
        assert!(parse_subagent_run_database_v2(&bad).is_none());
        // extra key fails.
        let mut extra = value.clone();
        extra["extra"] = json!(1);
        assert!(parse_subagent_run_database_v2(&extra).is_none());
    }

    #[test]
    fn prepared_to_committed_migration_flow() {
        let directory = tempfile::tempdir().unwrap();
        let v1 = InProcessSubagentRunStoreStorage::new(directory.path().join("v1")).unwrap();
        let v2 = InProcessSubagentRunStoreStorage::new(directory.path().join("v2")).unwrap();
        v1.write(
            "missing",
            "{\"version\":1,\"runs\":[],\"pendingChatDeletions\":[]}\n",
        )
        .unwrap();
        let committed = migrate_subagent_run_store_v2(&v1, &v2, 1_000, |value| {
            crate::run_store_v2::parse_mutable_subagent_run_database_v2(value)
        })
        .unwrap();
        let migration = &committed["migration"];
        assert_eq!(migration["status"], "committed");
        assert_eq!(migration["source"], "v1");
        assert!(migration["sourceSha256"].as_str().unwrap().len() == 64);
        // A committed migration with a changed V1 source is blocked.
        v1.write(
            &v1.read().unwrap().generation(),
            "{\"version\":1,\"runs\":[]}\n",
        )
        .unwrap();
        let error = migrate_subagent_run_store_v2(&v1, &v2, 1_000, |value| {
            crate::run_store_v2::parse_mutable_subagent_run_database_v2(value)
        });
        assert!(error.is_err());
    }
}
