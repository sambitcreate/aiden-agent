//! Port of `renderer/shared/subagent-management-v2.ts` — the renderer-bound
//! management request/result contract for v2 child runs. Every main response
//! is parsed again before it enters renderer state.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::subagent_runs::{parse_subagent_run_snapshot_v2, SubagentRunSnapshotV2};

/// Management requests the renderer may issue to the child-run dispatcher.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SubagentManagementRequestV2 {
    #[serde(rename_all = "camelCase")]
    Status { version: u8, run_id: String },
    #[serde(rename_all = "camelCase")]
    Stop { version: u8, run_id: String },
    #[serde(rename_all = "camelCase")]
    Retry { version: u8, run_id: String },
    #[serde(rename_all = "camelCase")]
    Wait {
        version: u8,
        run_id: String,
        timeout_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Steer {
        version: u8,
        run_id: String,
        instruction: String,
    },
}

/// Results the dispatcher returns; `snapshot` fields are always re-validated.
/// The `Retry` variant carries two snapshots; boxing would diverge from the
/// flat wire shape, so the size lint is suppressed.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SubagentManagementResultV2 {
    #[serde(rename_all = "camelCase")]
    Status {
        version: u8,
        snapshot: SubagentRunSnapshotV2,
    },
    #[serde(rename_all = "camelCase")]
    Wait {
        version: u8,
        snapshot: SubagentRunSnapshotV2,
        timed_out: bool,
    },
    #[serde(rename_all = "camelCase")]
    Stop {
        version: u8,
        snapshot: SubagentRunSnapshotV2,
        changed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Retry {
        version: u8,
        source_snapshot: SubagentRunSnapshotV2,
        snapshot: SubagentRunSnapshotV2,
    },
    #[serde(rename_all = "camelCase")]
    Steer {
        version: u8,
        snapshot: SubagentRunSnapshotV2,
    },
}

fn exact_keys(object: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && object.keys().all(|key| expected.contains(&key.as_str()))
}

/// Parse every main response again before it enters renderer state.
pub fn parse_subagent_management_result_v2(value: &Value) -> Option<SubagentManagementResultV2> {
    let object = value.as_object()?;
    if object.get("version") != Some(&Value::from(2)) {
        return None;
    }
    let action = object.get("action").and_then(Value::as_str)?;
    let snapshot = parse_subagent_run_snapshot_v2(object.get("snapshot")?)?;
    match action {
        "status" | "steer" => {
            if exact_keys(object, &["version", "action", "snapshot"]) {
                let result = if action == "status" {
                    SubagentManagementResultV2::Status {
                        version: 2,
                        snapshot,
                    }
                } else {
                    SubagentManagementResultV2::Steer {
                        version: 2,
                        snapshot,
                    }
                };
                Some(result)
            } else {
                None
            }
        }
        "wait" => {
            if exact_keys(object, &["version", "action", "snapshot", "timedOut"])
                && object.get("timedOut").and_then(Value::as_bool).is_some()
            {
                Some(SubagentManagementResultV2::Wait {
                    version: 2,
                    snapshot,
                    timed_out: object.get("timedOut").unwrap().as_bool().unwrap(),
                })
            } else {
                None
            }
        }
        "stop" => {
            if exact_keys(object, &["version", "action", "snapshot", "changed"])
                && object.get("changed").and_then(Value::as_bool).is_some()
            {
                Some(SubagentManagementResultV2::Stop {
                    version: 2,
                    snapshot,
                    changed: object.get("changed").unwrap().as_bool().unwrap(),
                })
            } else {
                None
            }
        }
        "retry" => {
            if exact_keys(object, &["version", "action", "sourceSnapshot", "snapshot"]) {
                let source_snapshot =
                    parse_subagent_run_snapshot_v2(object.get("sourceSnapshot")?)?;
                if snapshot.retry_of_run_id.as_deref() != Some(source_snapshot.run_id.as_str())
                    || snapshot.chat_id != source_snapshot.chat_id
                    || snapshot.workspace_id != source_snapshot.workspace_id
                {
                    return None;
                }
                Some(SubagentManagementResultV2::Retry {
                    version: 2,
                    source_snapshot,
                    snapshot,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagent_runs::SubagentRunStateV2;
    use serde_json::json;

    fn snapshot(overrides: serde_json::Value) -> Value {
        let mut object = serde_json::Map::new();
        object.insert("version".into(), json!(2));
        object.insert("runId".into(), json!("run-one"));
        object.insert("groupId".into(), json!("group-one"));
        object.insert("generationId".into(), json!("generation-one"));
        object.insert("childId".into(), json!("child-one"));
        object.insert("chatId".into(), json!("chat-one"));
        object.insert("workspaceId".into(), json!("workspace-one"));
        object.insert("revision".into(), json!(1));
        object.insert("role".into(), json!("reviewer"));
        object.insert("label".into(), json!("Review"));
        object.insert("taskPreview".into(), json!("Review the owner boundary."));
        object.insert("state".into(), json!("running"));
        object.insert("activity".into(), json!("Reviewing workspace context"));
        object.insert("startedAt".into(), json!(100));
        object.insert("updatedAt".into(), json!(100));
        object.insert("modelId".into(), json!("model-one"));
        object.insert("turns".into(), json!(0));
        object.insert("tools".into(), json!(0));
        object.insert("tokens".into(), json!(0));
        object.insert("warnings".into(), json!([]));
        object.insert("depth".into(), json!(1));
        object.insert("execution".into(), json!("foreground"));
        object.insert("context".into(), json!("fresh"));
        object.insert("authorityRevision".into(), json!(3));
        if let Some(overrides) = overrides.as_object() {
            for (key, value) in overrides {
                if value.is_null() {
                    // Mimic a TS `undefined` spread: the key is dropped.
                    object.remove(key);
                } else {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
        Value::Object(object)
    }

    fn parse(value: &Value) -> Option<SubagentManagementResultV2> {
        parse_subagent_management_result_v2(value)
    }

    #[test]
    fn management_results_are_exact_and_renderer_safe() {
        let run = snapshot(json!({}));
        let result = parse(&json!({ "version": 2, "action": "status", "snapshot": run }));
        assert!(matches!(
            result,
            Some(SubagentManagementResultV2::Status { version: 2, .. })
        ));
        let result = parse(&json!({
            "version": 2,
            "action": "wait",
            "snapshot": snapshot(json!({})),
            "timedOut": true,
        }));
        assert!(matches!(
            result,
            Some(SubagentManagementResultV2::Wait {
                timed_out: true,
                ..
            })
        ));
        assert_eq!(
            parse(&json!({
                "version": 2,
                "action": "stop",
                "snapshot": snapshot(json!({})),
                "changed": true,
                "privateGrant": "never",
            })),
            None
        );
        assert_eq!(
            parse(&json!({
                "version": 2,
                "action": "wait",
                "snapshot": snapshot(json!({})),
                "timedOut": "yes",
            })),
            None
        );
    }

    #[test]
    fn retry_results_require_exact_lineage_and_owner_identity() {
        let source = snapshot(json!({
            "state": "completed",
            "activity": Value::Null,
            "finishedAt": 200,
            "updatedAt": 200,
        }));
        let retry = snapshot(json!({
            "runId": "run-retry",
            "childId": "child-retry",
            "groupId": "group-retry",
            "retryOfRunId": "run-one",
            "state": "queued",
        }));
        let result = parse(&json!({
            "version": 2,
            "action": "retry",
            "sourceSnapshot": source,
            "snapshot": retry,
        }));
        assert!(matches!(
            result,
            Some(SubagentManagementResultV2::Retry { .. })
        ));
        let wrong_lineage = snapshot(json!({
            "runId": "run-retry",
            "childId": "child-retry",
            "groupId": "group-retry",
            "retryOfRunId": "run-other",
            "state": "queued",
        }));
        assert_eq!(
            parse(&json!({
                "version": 2,
                "action": "retry",
                "sourceSnapshot": snapshot(json!({
                    "state": "completed",
                    "activity": Value::Null,
                    "finishedAt": 200,
                    "updatedAt": 200,
                })),
                "snapshot": wrong_lineage,
            })),
            None
        );
    }

    #[test]
    fn typed_request_and_result_round_trip_with_action_tags() {
        let request = SubagentManagementRequestV2::Wait {
            version: 2,
            run_id: "run-one".into(),
            timeout_ms: 500,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["action"], "wait");
        assert_eq!(value["timeoutMs"], 500);
        let back: SubagentManagementRequestV2 = serde_json::from_value(value).unwrap();
        assert_eq!(back, request);

        let result = SubagentManagementResultV2::Stop {
            version: 2,
            snapshot: serde_json::from_value(snapshot(json!({}))).unwrap(),
            changed: true,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["action"], "stop");
        let back: SubagentManagementResultV2 = serde_json::from_value(value).unwrap();
        assert_eq!(back, result);
        assert!(matches!(
            result.snapshot_state(),
            SubagentRunStateV2::Running
        ));
    }

    impl SubagentManagementResultV2 {
        fn snapshot_state(&self) -> SubagentRunStateV2 {
            match self {
                SubagentManagementResultV2::Status { snapshot, .. }
                | SubagentManagementResultV2::Wait { snapshot, .. }
                | SubagentManagementResultV2::Stop { snapshot, .. }
                | SubagentManagementResultV2::Steer { snapshot, .. } => snapshot.state,
                SubagentManagementResultV2::Retry { snapshot, .. } => snapshot.state,
            }
        }
    }
}
