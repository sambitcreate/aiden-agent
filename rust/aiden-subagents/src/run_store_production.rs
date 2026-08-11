//! Port of `main/services/subagents/subagent-run-store-production.ts` — one
//! production-effective lifecycle selector wiring the dispatcher to the V1
//! (`subagent-runs`) and V2 (`subagent-runs-v2`) directories under `userData`.

use std::path::PathBuf;

use crate::run_store::{RunStoreError, SubagentRunStore, SubagentRunStoreOptions};
use crate::run_store_dispatcher::{
    SubagentRunStoreDispatcher, SubagentRunStoreDispatcherOptions, SubagentRunStoreSelection,
};
use crate::run_store_migration::{
    migrate_subagent_run_store_v2, read_subagent_run_store_v1_checkpoint_v2,
};
use crate::run_store_storage::{
    create_in_process_subagent_run_store_storage, SubagentRunStoreStorage,
};
use crate::run_store_v2::{SubagentRunStoreV2, SubagentRunStoreV2Options};

const V1_DIRECTORY: &str = "subagent-runs";
const V2_DIRECTORY: &str = "subagent-runs-v2";

pub struct ProductionSubagentRunStoreOptions {
    pub selection: SubagentRunStoreSelection,
    pub resolve_user_data_directory: Box<dyn Fn() -> PathBuf + Send + Sync>,
    pub now: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
}

/// One production-effective store. `selection` is explicit (V2 when the
/// rollout flag is on); migration and canonical reads share the exact same
/// directories used by startup, projector writes, history reads, deletion
/// recovery, and shutdown flushing.
pub struct ProductionSubagentRunStore {
    pub dispatcher: SubagentRunStoreDispatcher,
    selection: SubagentRunStoreSelection,
    #[allow(dead_code)]
    resolve_user_data_directory: Box<dyn Fn() -> PathBuf + Send + Sync>,
    #[allow(dead_code)]
    now: Option<std::sync::Arc<dyn Fn() -> u64 + Send + Sync>>,
}

impl ProductionSubagentRunStore {
    pub fn create(options: ProductionSubagentRunStoreOptions) -> Result<Self, RunStoreError> {
        let selection = options.selection;
        let resolve_user_data_directory = options.resolve_user_data_directory;
        let now = options.now;

        fn storage_for(
            directory: &std::path::Path,
        ) -> Result<Box<dyn SubagentRunStoreStorage>, RunStoreError> {
            create_in_process_subagent_run_store_storage(directory)
                .map(|storage| Box::new(storage) as Box<dyn SubagentRunStoreStorage>)
                .map_err(RunStoreError::Storage)
        }

        // The clock is a trait object; share it through an Arc so every store
        // and migration closure observes the same clock.
        let now_arc: Option<std::sync::Arc<dyn Fn() -> u64 + Send + Sync>> = now.map(|clock| {
            std::sync::Arc::new(clock) as std::sync::Arc<dyn Fn() -> u64 + Send + Sync>
        });
        let v1_now = now_arc
            .clone()
            .map(|clock| Box::new(move || clock()) as Box<dyn Fn() -> u64 + Send + Sync>);
        let v2_now = now_arc
            .clone()
            .map(|clock| Box::new(move || clock()) as Box<dyn Fn() -> u64 + Send + Sync>);
        let migration_now = now_arc.clone();

        let v1 = SubagentRunStore::create(
            Box::new(|directory| {
                Ok(Box::new(
                    crate::run_store_storage::InProcessSubagentRunStoreStorage::new(directory)?,
                ) as Box<dyn SubagentRunStoreStorage>)
            }),
            resolve_user_data_directory().join(V1_DIRECTORY),
            SubagentRunStoreOptions {
                now: v1_now,
                max_runs: None,
                storage_factory: None,
            },
        )?;
        let v2 = SubagentRunStoreV2::create(
            Box::new(|directory| {
                Ok(Box::new(
                    crate::run_store_storage::InProcessSubagentRunStoreStorage::new(directory)?,
                ) as Box<dyn SubagentRunStoreStorage>)
            }),
            resolve_user_data_directory().join(V2_DIRECTORY),
            SubagentRunStoreV2Options {
                now: v2_now,
                max_runs: None,
            },
        )?;

        let (prepare_v2, checkpoint_v1_mutation, v2) = if selection == SubagentRunStoreSelection::V2
        {
            let v2_arc = std::sync::Arc::new(v2);
            let migration_now = migration_now.clone();
            let user_data = resolve_user_data_directory();
            let v1_dir = user_data.join(V1_DIRECTORY);
            let v2_dir = user_data.join(V2_DIRECTORY);
            let prepare_v2: Box<dyn Fn() -> Result<(), RunStoreError> + Send + Sync> = Box::new({
                let v1_dir = v1_dir.clone();
                let v2_dir = v2_dir.clone();
                move || {
                    let v1_storage = storage_for(&v1_dir)?;
                    let v2_storage = storage_for(&v2_dir)?;
                    let result = migrate_subagent_run_store_v2(
                        v1_storage.as_ref(),
                        v2_storage.as_ref(),
                        migration_now
                            .as_ref()
                            .map(|clock| clock())
                            .unwrap_or_else(now_millis),
                        crate::run_store_v2::parse_mutable_subagent_run_database_v2,
                    );
                    drop(v1_storage);
                    drop(v2_storage);
                    result.map(|_| ())
                }
            });
            let v2_checkpoint = v2_arc.clone();
            let checkpoint_v1_mutation: Box<dyn Fn() -> Result<(), RunStoreError> + Send + Sync> =
                Box::new(move || {
                    let v1_storage = storage_for(&v1_dir)?;
                    let (source, generation, sha256) =
                        read_subagent_run_store_v1_checkpoint_v2(v1_storage.as_ref())?;
                    drop(v1_storage);
                    v2_checkpoint.update_v1_checkpoint(&source, &generation, &sha256)
                });
            (Some(prepare_v2), Some(checkpoint_v1_mutation), Some(v2_arc))
        } else {
            (None, None, None)
        };

        let dispatcher = SubagentRunStoreDispatcher::create(SubagentRunStoreDispatcherOptions {
            selection,
            projection: crate::run_store_dispatcher::SubagentRunProjection::Native,
            prepare_v2,
            checkpoint_v1_mutation,
            v1,
            v2,
        });
        Ok(ProductionSubagentRunStore {
            dispatcher,
            selection,
            resolve_user_data_directory,
            now: now_arc,
        })
    }

    pub fn selection(&self) -> SubagentRunStoreSelection {
        self.selection
    }

    pub fn initialize(&mut self) -> Result<(), RunStoreError> {
        self.dispatcher.initialize()
    }

    /// Port of `subagentV2Enabled`: V2 is the production default and the
    /// environment variables are emergency rollback switches. Only exact `0`
    /// disables the whole feature or V2, matching Electron's packaged
    /// behavior and canonical variable names.
    pub fn subagent_v2_enabled(environment: &std::collections::HashMap<String, String>) -> bool {
        rollout_enabled(environment, "AIDEN_SUBAGENTS_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENTS_V2_ENABLED")
    }

    /// Independent emergency rollback for attended child workspace writes.
    /// The capability defaults on, only exact `0` disables it, and the global
    /// Subagents rollback remains the parent gate.
    pub fn subagent_child_write_enabled(
        environment: &std::collections::HashMap<String, String>,
    ) -> bool {
        rollout_enabled(environment, "AIDEN_SUBAGENTS_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENTS_V2_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENT_CHILD_WRITE_ENABLED")
    }

    /// Independent emergency rollback for attended foreground child shell.
    /// It never authorizes shell alone: production admission must additionally
    /// prove the V2 authority, workspace authority, and approval channel.
    pub fn subagent_child_shell_enabled(
        environment: &std::collections::HashMap<String, String>,
    ) -> bool {
        rollout_enabled(environment, "AIDEN_SUBAGENTS_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENTS_V2_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENT_CHILD_SHELL_ENABLED")
    }

    /// Independent emergency rollback for foreground remote child MCP reads.
    /// Stdio servers and every actual call remain subject to the exact V2
    /// authority, bounded inventory, network budget, and one-use egress
    /// approval; this flag alone grants nothing.
    pub fn subagent_child_mcp_enabled(
        environment: &std::collections::HashMap<String, String>,
    ) -> bool {
        rollout_enabled(environment, "AIDEN_SUBAGENTS_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENTS_V2_ENABLED")
            && rollout_enabled(environment, "AIDEN_SUBAGENT_CHILD_MCP_ENABLED")
    }

    /// Separate subordinate rollback for attended child MCP mutations. A
    /// disabled base read lane always disables mutations as well.
    pub fn subagent_child_mcp_mutations_enabled(
        environment: &std::collections::HashMap<String, String>,
    ) -> bool {
        Self::subagent_child_mcp_enabled(environment)
            && rollout_enabled(environment, "AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED")
    }
}

fn rollout_enabled(environment: &std::collections::HashMap<String, String>, name: &str) -> bool {
    environment
        .get(name)
        .is_none_or(|value| value.trim() != "0")
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
    use std::collections::HashMap;

    #[test]
    fn v2_flag_selection() {
        let mut environment = HashMap::new();
        assert!(ProductionSubagentRunStore::subagent_v2_enabled(
            &environment
        ));
        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_v2_enabled(
            &environment
        ));
        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "1".to_string());
        assert!(ProductionSubagentRunStore::subagent_v2_enabled(
            &environment
        ));
        environment.insert("AIDEN_SUBAGENTS_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_v2_enabled(
            &environment
        ));
    }

    #[test]
    fn child_write_flag_defaults_on_and_exact_zero_or_global_zero_disables() {
        let mut environment = HashMap::new();
        assert!(ProductionSubagentRunStore::subagent_child_write_enabled(
            &environment
        ));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_WRITE_ENABLED".to_string(),
            "1".to_string(),
        );
        assert!(ProductionSubagentRunStore::subagent_child_write_enabled(
            &environment
        ));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_WRITE_ENABLED".to_string(),
            "0".to_string(),
        );
        assert!(!ProductionSubagentRunStore::subagent_child_write_enabled(
            &environment
        ));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_WRITE_ENABLED".to_string(),
            "1".to_string(),
        );
        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_child_write_enabled(
            &environment
        ));

        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "1".to_string());
        environment.insert("AIDEN_SUBAGENTS_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_child_write_enabled(
            &environment
        ));
    }

    #[test]
    fn child_shell_flag_defaults_on_and_exact_zero_or_global_zero_disables() {
        let mut environment = HashMap::new();
        assert!(ProductionSubagentRunStore::subagent_child_shell_enabled(
            &environment
        ));
        environment.insert(
            "AIDEN_SUBAGENT_CHILD_SHELL_ENABLED".to_string(),
            "false".to_string(),
        );
        assert!(ProductionSubagentRunStore::subagent_child_shell_enabled(
            &environment
        ));
        environment.insert(
            "AIDEN_SUBAGENT_CHILD_SHELL_ENABLED".to_string(),
            "0".to_string(),
        );
        assert!(!ProductionSubagentRunStore::subagent_child_shell_enabled(
            &environment
        ));
        environment.insert(
            "AIDEN_SUBAGENT_CHILD_SHELL_ENABLED".to_string(),
            "1".to_string(),
        );
        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_child_shell_enabled(
            &environment
        ));
        environment.insert("AIDEN_SUBAGENTS_V2_ENABLED".to_string(), "1".to_string());
        environment.insert("AIDEN_SUBAGENTS_ENABLED".to_string(), "0".to_string());
        assert!(!ProductionSubagentRunStore::subagent_child_shell_enabled(
            &environment
        ));
    }

    #[test]
    fn child_mcp_flags_default_on_and_mutation_is_subordinate_to_base() {
        let mut environment = HashMap::new();
        assert!(ProductionSubagentRunStore::subagent_child_mcp_enabled(
            &environment
        ));
        assert!(ProductionSubagentRunStore::subagent_child_mcp_mutations_enabled(&environment));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED".to_string(),
            "0".to_string(),
        );
        assert!(ProductionSubagentRunStore::subagent_child_mcp_enabled(
            &environment
        ));
        assert!(!ProductionSubagentRunStore::subagent_child_mcp_mutations_enabled(&environment));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED".to_string(),
            "1".to_string(),
        );
        environment.insert(
            "AIDEN_SUBAGENT_CHILD_MCP_ENABLED".to_string(),
            "0".to_string(),
        );
        assert!(!ProductionSubagentRunStore::subagent_child_mcp_enabled(
            &environment
        ));
        assert!(!ProductionSubagentRunStore::subagent_child_mcp_mutations_enabled(&environment));

        environment.insert(
            "AIDEN_SUBAGENT_CHILD_MCP_ENABLED".to_string(),
            "false".to_string(),
        );
        assert!(ProductionSubagentRunStore::subagent_child_mcp_enabled(
            &environment
        ));
        assert!(ProductionSubagentRunStore::subagent_child_mcp_mutations_enabled(&environment));
    }

    #[test]
    fn production_store_resolves_absolute_user_data() {
        let directory = tempfile::tempdir().unwrap();
        let user_data = directory.path().to_path_buf();
        let mut store = ProductionSubagentRunStore::create(ProductionSubagentRunStoreOptions {
            selection: SubagentRunStoreSelection::V1,
            resolve_user_data_directory: Box::new(move || user_data.clone()),
            now: None,
        })
        .unwrap();
        store.initialize().unwrap();
        assert!(directory.path().join("subagent-runs").exists());
    }
}
