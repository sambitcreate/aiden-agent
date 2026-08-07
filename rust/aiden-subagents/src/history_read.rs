//! Port of `main/services/subagents/subagent-history-read-core.ts` — validate
//! both renderer-controlled lookup keys before any private-store access, and
//! keep the exact invoking document authoritative across both reads.

use aiden_core::subagent_runs::{
    SubagentEffectActivityV1, SubagentHistoryDetailV1, SubagentRunSnapshot,
};
use serde_json::Value;

use crate::safe_text::is_safe_subagent_identifier_str;

/// Validate both renderer-controlled lookup keys before any private-store
/// access (`parseSubagentHistoryRequestIds`).
pub fn parse_subagent_history_request_ids(
    chat_id: &Value,
    run_id: &Value,
) -> Result<(String, String), String> {
    let chat_id = chat_id
        .as_str()
        .filter(|value| is_safe_subagent_identifier_str(value))
        .ok_or_else(|| "Invalid subagent history request.".to_string())?;
    let run_id = run_id
        .as_str()
        .filter(|value| is_safe_subagent_identifier_str(value))
        .ok_or_else(|| "Invalid subagent history request.".to_string())?;
    Ok((chat_id.to_string(), run_id.to_string()))
}

/// `persistedChatReferencesSubagentRun` — a persisted assistant message
/// references the run when any `subagents.runIds` entry matches.
pub fn persisted_chat_references_subagent_run(
    messages: &[Value],
    run_id: &str,
    generation_id: &str,
) -> bool {
    messages.iter().any(|message| {
        let Some(subagents) = message.get("subagents") else {
            return false;
        };
        if subagents.get("generationId").and_then(Value::as_str) != Some(generation_id) {
            return false;
        }
        subagents
            .get("runIds")
            .and_then(Value::as_array)
            .map(|run_ids| run_ids.iter().any(|entry| entry.as_str() == Some(run_id)))
            .unwrap_or(false)
    })
}

/// `persistedChatWorkspaceId` — undefined → "default".
pub fn persisted_chat_workspace_id(workspace_id: Option<&str>) -> &str {
    workspace_id.unwrap_or("default")
}

/// Read the snapshot only if the exact invoking document owns the lookup chain
/// (`readSubagentHistoryForOwner`). The owner fence is represented by
/// `owner_active` checks between the two asynchronous reads.
pub fn read_subagent_history_for_owner(
    chat_id: &str,
    run_id: &str,
    get_chat: &dyn Fn(&str) -> Result<Option<(String, Option<String>, Vec<Value>)>, String>,
    get_snapshot: &dyn Fn(&str) -> Result<Option<SubagentRunSnapshot>, String>,
    owner_active_between: &dyn Fn() -> bool,
) -> Result<Option<SubagentRunSnapshot>, String> {
    let chat = get_chat(chat_id)?;
    if !owner_active_between() {
        return Err("The renderer document is no longer active.".to_string());
    }
    let Some((chat_id_value, workspace_id, messages)) = chat else {
        return Ok(None);
    };
    if chat_id_value != chat_id {
        return Ok(None);
    }
    let snapshot = get_snapshot(run_id)?;
    if !owner_active_between() {
        return Err("The renderer document is no longer active.".to_string());
    }
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let (snapshot_chat_id, snapshot_workspace_id, snapshot_run_id, snapshot_generation_id) =
        match &snapshot {
            SubagentRunSnapshot::V1(snapshot) => (
                snapshot.chat_id.as_str(),
                snapshot.workspace_id.as_str(),
                snapshot.run_id.as_str(),
                snapshot.generation_id.as_str(),
            ),
            SubagentRunSnapshot::V2(snapshot) => (
                snapshot.chat_id.as_str(),
                snapshot.workspace_id.as_str(),
                snapshot.run_id.as_str(),
                snapshot.generation_id.as_str(),
            ),
        };
    if snapshot_chat_id == chat_id_value
        && snapshot_workspace_id == persisted_chat_workspace_id(workspace_id.as_deref())
        && persisted_chat_references_subagent_run(
            &messages,
            snapshot_run_id,
            snapshot_generation_id,
        )
    {
        Ok(Some(snapshot))
    } else {
        Ok(None)
    }
}

/// Read the run plus its bounded effect activity (`readSubagentHistoryDetailForOwner`).
pub fn read_subagent_history_detail_for_owner(
    chat_id: &str,
    run_id: &str,
    get_chat: &dyn Fn(&str) -> Result<Option<(String, Option<String>, Vec<Value>)>, String>,
    get_snapshot: &dyn Fn(&str) -> Result<Option<SubagentRunSnapshot>, String>,
    get_effect_activity: &dyn Fn(&str, &str) -> Result<Vec<SubagentEffectActivityV1>, String>,
    owner_active_between: &dyn Fn() -> bool,
) -> Result<Option<SubagentHistoryDetailV1>, String> {
    let snapshot = read_subagent_history_for_owner(
        chat_id,
        run_id,
        get_chat,
        get_snapshot,
        owner_active_between,
    )?;
    if !owner_active_between() {
        return Err("The renderer document is no longer active.".to_string());
    }
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let effects = get_effect_activity(run_id, chat_id)?;
    if !owner_active_between() {
        return Err("The renderer document is no longer active.".to_string());
    }
    Ok(Some(SubagentHistoryDetailV1 {
        version: 1,
        snapshot,
        effects,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> SubagentRunSnapshot {
        let value = json!({
            "version": 1,
            "runId": "run-1",
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "default",
            "revision": 1,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": "completed",
            "activity": "Reading a workspace file",
            "startedAt": 100,
            "updatedAt": 200,
            "finishedAt": 200,
            "modelId": "model-1",
            "turns": 1,
            "tools": 1,
            "tokens": 0,
            "milestones": ["reading"],
            "warnings": [],
        });
        aiden_core::subagent_runs::parse_subagent_run_snapshot(&value).unwrap()
    }

    fn chat(reference: bool) -> (String, Option<String>, Vec<Value>) {
        let messages = if reference {
            vec![json!({
                "role": "assistant",
                "content": "done",
                "subagents": {
                    "version": 1,
                    "generationId": "generation-1",
                    "runIds": ["run-1"],
                    "total": 1,
                    "completed": 1,
                    "failed": 0,
                    "timedOut": 0,
                    "interrupted": 0,
                },
            })]
        } else {
            vec![]
        };
        ("chat-1".to_string(), None, messages)
    }

    #[test]
    fn request_ids_are_strict() {
        let (chat_id, run_id) =
            parse_subagent_history_request_ids(&json!("chat-1"), &json!("run-1")).unwrap();
        assert_eq!(chat_id, "chat-1");
        assert_eq!(run_id, "run-1");
        assert!(parse_subagent_history_request_ids(&json!("not safe!"), &json!("run-1")).is_err());
        assert!(parse_subagent_history_request_ids(&json!("chat-1"), &json!(42)).is_err());
    }

    #[test]
    fn owned_history_read_requires_chat_reference() {
        let snapshot = snapshot();
        let referenced = read_subagent_history_for_owner(
            "chat-1",
            "run-1",
            &|_| Ok(Some(chat(true))),
            &|_| Ok(Some(snapshot.clone())),
            &|| true,
        )
        .unwrap();
        assert!(referenced.is_some());
        let unreferenced = read_subagent_history_for_owner(
            "chat-1",
            "run-1",
            &|_| Ok(Some(chat(false))),
            &|_| Ok(Some(snapshot.clone())),
            &|| true,
        )
        .unwrap();
        assert!(unreferenced.is_none());
    }

    #[test]
    fn owner_fence_blocks_after_async_read() {
        let snapshot = snapshot();
        let result = read_subagent_history_for_owner(
            "chat-1",
            "run-1",
            &|_| Ok(Some(chat(true))),
            &|_| Ok(Some(snapshot.clone())),
            &|| false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn detail_read_includes_effect_activity() {
        let snapshot = snapshot();
        let detail = read_subagent_history_detail_for_owner(
            "chat-1",
            "run-1",
            &|_| Ok(Some(chat(true))),
            &|_| Ok(Some(snapshot.clone())),
            &|_, _| {
                Ok(vec![SubagentEffectActivityV1 {
                    version: 1,
                    kind: aiden_core::subagent_runs::SubagentEffectActivityKindV1::Shell,
                    state: aiden_core::subagent_runs::SubagentEffectActivityStateV1::Completed,
                    label: "Command completed".to_string(),
                    updated_at: 200,
                }])
            },
            &|| true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(detail.version, 1);
        assert_eq!(detail.effects.len(), 1);
    }
}
