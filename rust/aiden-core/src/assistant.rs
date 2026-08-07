//! Port of the validation half of `renderer/shared/assistant.ts`: the
//! fail-closed renderer boundaries for attended tool approvals plus the
//! canonical escaped-JSON helper for mutating MCP arguments.
//!
//! The approval *types* already live in `lib.rs` (`ToolApprovalDetails` and
//! friends); this module keeps the dependency-free predicates the Electron
//! renderer uses before trusting any "Allow" action. Literal safety claims
//! (e.g. `automaticRetry: false`) must match exactly.

use serde_json::Value;

pub const SUBAGENT_MCP_MUTATION_DISPLAY_INPUT_BYTES: usize = 8 * 1024;
pub const SUBAGENT_MCP_MUTATION_DISPLAY_ESCAPED_CHARS: usize = 64 * 1024;

fn unsafe_approval_code_point(code_point: u32, multiline: bool) -> bool {
    let allowed_whitespace = multiline && matches!(code_point, 0x09 | 0x0a | 0x0d);
    (!allowed_whitespace && code_point <= 0x1f)
        || (0x7f..=0x9f).contains(&code_point)
        || code_point == 0x061c
        || code_point == 0x200e
        || code_point == 0x200f
        || (0x202a..=0x202e).contains(&code_point)
        || code_point == 0x2028
        || code_point == 0x2029
        || (0x2066..=0x2069).contains(&code_point)
}

fn safe_approval_text(value: &Value, limit: usize, multiline: bool) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if value.is_empty() || value.chars().count() > limit || value.trim() != value {
        return false;
    }
    value
        .chars()
        .all(|ch| !unsafe_approval_code_point(ch as u32, multiline))
}

fn safe_approval_preview(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if value.trim().is_empty() || value.chars().count() > 12 * 1024 {
        return false;
    }
    value
        .chars()
        .all(|ch| !unsafe_approval_code_point(ch as u32, true))
}

fn has_exact_approval_keys(value: &Value, keys: &[&str]) -> bool {
    match value.as_object() {
        Some(object) => {
            object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
        }
        None => false,
    }
}

fn safe_workspace_relative_path(value: &Value) -> bool {
    if !safe_approval_text(value, 512, false) {
        return false;
    }
    let value = value.as_str().unwrap();
    if !value.is_ascii() || value.starts_with('/') || value.starts_with('~') || value.contains('\\')
    {
        return false;
    }
    let segments: Vec<&str> = value.split('/').collect();
    !segments.is_empty()
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
}

fn safe_digest_prefix(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => {
            value.len() == 12
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        }
        None => false,
    }
}

/// Canonical JSON stringification: sorted object keys, no whitespace. Mirrors
/// the TypeScript `canonicalParsedJson`.
pub fn canonical_parsed_json(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(bool) => Ok(bool.to_string()),
        Value::Number(number) => {
            let text = number.to_string();
            // JSON.stringify(-0) is "0"; serde_json already renders -0 as "0"
            // for integer zero, and preserves -0.0 as "-0.0" only for floats.
            if text == "-0.0" || text == "-0" {
                Ok("0".to_string())
            } else {
                Ok(text)
            }
        }
        Value::String(string) => Ok(serde_json::to_string(string).unwrap()),
        Value::Array(array) => {
            let mut parts = Vec::with_capacity(array.len());
            for entry in array {
                parts.push(canonical_parsed_json(entry)?);
            }
            Ok(format!("[{}]", parts.join(",")))
        }
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            let mut parts = Vec::with_capacity(keys.len());
            for key in keys {
                parts.push(format!(
                    "{}:{}",
                    serde_json::to_string(key).unwrap(),
                    canonical_parsed_json(&object[key])?
                ));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
    }
}

/// Escape every raw control, bidi, isolate, and Unicode line-separator code
/// point into `\uXXXX` (or surrogate pairs for astral code points).
pub fn escape_subagent_mcp_mutation_approval_json(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        let code_point = ch as u32;
        if unsafe_approval_code_point(code_point, false) {
            if code_point <= 0xffff {
                result.push_str(&format!("\\u{code_point:04x}"));
            } else {
                let adjusted = code_point - 0x10000;
                let high = 0xd800 + (adjusted >> 10);
                let low = 0xdc00 + (adjusted & 0x3ff);
                result.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
            }
        } else {
            result.push(ch);
        }
    }
    result
}

fn safe_canonical_mutation_arguments(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let char_count = value.chars().count();
    if !(2..=SUBAGENT_MCP_MUTATION_DISPLAY_ESCAPED_CHARS).contains(&char_count) {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    if !parsed.is_object() {
        return false;
    }
    let Ok(canonical) = canonical_parsed_json(&parsed) else {
        return false;
    };
    if canonical.len() > SUBAGENT_MCP_MUTATION_DISPLAY_INPUT_BYTES {
        return false;
    }
    escape_subagent_mcp_mutation_approval_json(&canonical) == value
}

/// Malformed privileged mutation details never retain an Allow action.
pub fn is_subagent_mcp_mutation_approval_details(value: &Value) -> bool {
    if !has_exact_approval_keys(
        value,
        &[
            "kind",
            "childLabel",
            "serverId",
            "toolName",
            "connectionDigestPrefix",
            "schemaDigestPrefix",
            "profileDigestPrefix",
            "argumentDigestPrefix",
            "classification",
            "destructive",
            "idempotency",
            "openWorld",
            "taskSupport",
            "timeoutMs",
            "canonicalArguments",
            "priorUnknownEffect",
            "automaticRetry",
            "rollbackAvailable",
        ],
    ) {
        return false;
    }
    let get = |key: &str| value.get(key).unwrap();
    let classification = matches!(
        get("classification").as_str(),
        Some("declared_mutating") | Some("unproven_mutating")
    );
    let destructive = matches!(
        get("destructive").as_str(),
        Some("destructive") | Some("additive") | Some("unknown")
    );
    let idempotency = matches!(
        get("idempotency").as_str(),
        Some("idempotent") | Some("not_declared")
    );
    let open_world = matches!(
        get("openWorld").as_str(),
        Some("open") | Some("closed") | Some("unknown")
    );
    let task_support = matches!(
        get("taskSupport").as_str(),
        Some("forbidden") | Some("optional")
    );
    let timeout_ok = matches!(get("timeoutMs").as_u64(), Some(1..=120_000));
    get("kind").as_str() == Some("subagent-mcp-mutation")
        && safe_approval_text(get("childLabel"), 120, false)
        && safe_approval_text(get("serverId"), 128, false)
        && safe_approval_text(get("toolName"), 128, false)
        && safe_digest_prefix(get("connectionDigestPrefix"))
        && safe_digest_prefix(get("schemaDigestPrefix"))
        && safe_digest_prefix(get("profileDigestPrefix"))
        && safe_digest_prefix(get("argumentDigestPrefix"))
        && classification
        && destructive
        && idempotency
        && open_world
        && task_support
        && timeout_ok
        && safe_canonical_mutation_arguments(get("canonicalArguments"))
        && get("priorUnknownEffect").as_bool().is_some()
        && get("automaticRetry") == &Value::Bool(false)
        && get("rollbackAvailable") == &Value::Bool(false)
}

fn safe_shell_command(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if value.trim().is_empty() || value.chars().count() > 32 * 1024 {
        return false;
    }
    value.chars().all(|ch| {
        let point = ch as u32;
        !(point == 0
            || point == 0x0d
            || point == 0x1b
            || (point < 0x20 && point != 0x09 && point != 0x0a)
            || (0x7f..=0x9f).contains(&point)
            || point == 0x2028
            || point == 0x2029
            || (0x202a..=0x202e).contains(&point)
            || (0x2066..=0x2069).contains(&point))
    })
}

/// Malformed full-host shell claims never retain an Allow action.
pub fn is_subagent_shell_approval_details(value: &Value) -> bool {
    if !has_exact_approval_keys(
        value,
        &[
            "kind",
            "childLabel",
            "command",
            "initialCwd",
            "shell",
            "argumentDigestPrefix",
            "rootDigestPrefix",
            "effectDigestPrefix",
            "timeoutMs",
            "stdoutLimitBytes",
            "stderrLimitBytes",
            "workspaceLabel",
            "isManagedWorktree",
            "worktreeLabel",
            "environmentProfile",
            "osSandboxed",
            "rollbackAvailable",
            "outputSentToModel",
            "arbitraryNetworkAvailable",
            "detachedProcessesMaySurvive",
        ],
    ) {
        return false;
    }
    let get = |key: &str| value.get(key).unwrap();
    let worktree_ok = (get("isManagedWorktree") == &Value::Bool(false)
        && get("worktreeLabel").is_null())
        || (get("isManagedWorktree") == &Value::Bool(true)
            && safe_approval_text(get("worktreeLabel"), 160, false));
    let initial_cwd = get("initialCwd").as_str();
    get("kind").as_str() == Some("subagent-shell")
        && safe_approval_text(get("childLabel"), 120, false)
        && safe_shell_command(get("command"))
        && safe_approval_text(get("initialCwd"), 1024, false)
        && initial_cwd.map(|cwd| cwd.starts_with('/')).unwrap_or(false)
        && get("shell").as_str() == Some("/bin/zsh -f -c")
        && safe_digest_prefix(get("argumentDigestPrefix"))
        && safe_digest_prefix(get("rootDigestPrefix"))
        && safe_digest_prefix(get("effectDigestPrefix"))
        && matches!(get("timeoutMs").as_u64(), Some(1..=120_000))
        && get("stdoutLimitBytes") == &Value::from(512 * 1024)
        && get("stderrLimitBytes") == &Value::from(512 * 1024)
        && safe_approval_text(get("workspaceLabel"), 120, false)
        && worktree_ok
        && get("environmentProfile").as_str() == Some("minimal-private-0700-v1")
        && get("osSandboxed") == &Value::Bool(false)
        && get("rollbackAvailable") == &Value::Bool(false)
        && get("outputSentToModel") == &Value::Bool(true)
        && get("arbitraryNetworkAvailable") == &Value::Bool(true)
        && get("detachedProcessesMaySurvive") == &Value::Bool(true)
}

fn safe_byte_count(value: &Value) -> bool {
    matches!(value.as_u64(), Some(bytes) if bytes <= 10 * 1024 * 1024)
}

/// Fail closed before structured child-mutation facts are rendered as trusted
/// safety copy.
pub fn is_subagent_workspace_write_approval_details(value: &Value) -> bool {
    if !has_exact_approval_keys(
        value,
        &[
            "kind",
            "operation",
            "childLabel",
            "path",
            "workspaceLabel",
            "worktreeLabel",
            "isManagedWorktree",
            "preDigestPrefix",
            "postDigestPrefix",
            "beforeBytes",
            "afterBytes",
            "diffPreview",
            "diffTruncated",
            "commandWillRun",
            "refuseIfChanged",
        ],
    ) {
        return false;
    }
    let get = |key: &str| value.get(key).unwrap();
    let operation_ok = matches!(
        get("operation").as_str(),
        Some("create") | Some("replace") | Some("edit")
    );
    let operation = get("operation").as_str().unwrap_or_default();
    let worktree_ok = (get("isManagedWorktree") == &Value::Bool(false)
        && get("worktreeLabel").is_null())
        || (get("isManagedWorktree") == &Value::Bool(true)
            && safe_approval_text(get("worktreeLabel"), 160, false));
    let preimage_ok = if operation == "create" {
        get("preDigestPrefix").is_null() && get("beforeBytes") == &Value::from(0)
    } else {
        safe_digest_prefix(get("preDigestPrefix"))
    };
    get("kind").as_str() == Some("subagent-workspace-write")
        && operation_ok
        && safe_approval_text(get("childLabel"), 120, false)
        && safe_workspace_relative_path(get("path"))
        && safe_approval_text(get("workspaceLabel"), 120, false)
        && worktree_ok
        && preimage_ok
        && safe_digest_prefix(get("postDigestPrefix"))
        && safe_byte_count(get("beforeBytes"))
        && safe_byte_count(get("afterBytes"))
        && safe_approval_preview(get("diffPreview"))
        && get("diffTruncated").as_bool().is_some()
        && get("commandWillRun") == &Value::Bool(false)
        && get("refuseIfChanged") == &Value::Bool(true)
}

/// Fail-closed renderer boundary for attended Assistant automation approvals.
pub fn is_assistant_automation_approval_details(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let get = |key: &str| object.get(key).unwrap_or(&Value::Null);
    let action = get("action").as_str();
    let action_ok = match action {
        Some("create") => !object.contains_key("taskId") && !object.contains_key("enabled"),
        Some("edit") => {
            safe_approval_text(get("taskId"), 160, false) && get("enabled").as_bool().is_some()
        }
        _ => false,
    };
    let project_ok = (get("workspaceId").is_null() && get("workspaceName").is_null())
        || (safe_approval_text(get("workspaceId"), 160, false)
            && safe_approval_text(get("workspaceName"), 120, false));
    let mcp_server_ids = get("mcpServerIds").as_array().cloned().unwrap_or_default();
    let mcp_server_names = get("mcpServerNames")
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mcp_servers_are_valid = get("mcpServerIds").is_array()
        && get("mcpServerNames").is_array()
        && mcp_server_ids.len() <= 16
        && mcp_server_ids.len() == mcp_server_names.len()
        && {
            let mut unique = std::collections::BTreeSet::new();
            mcp_server_ids
                .iter()
                .map(|id| id.as_str().unwrap_or_default())
                .all(|id| unique.insert(id))
        }
        && mcp_server_ids
            .iter()
            .all(|id| safe_approval_text(id, 160, false))
        && mcp_server_names
            .iter()
            .all(|name| safe_approval_text(name, 120, false));
    let next_run_ok = get("nextRunAt").as_u64().is_some();
    get("kind").as_str() == Some("assistant-automation")
        && action_ok
        && safe_approval_text(get("name"), 120, false)
        && safe_approval_text(get("prompt"), 32 * 1024, true)
        && safe_approval_text(get("cron"), 256, false)
        && safe_approval_text(get("timezone"), 128, false)
        && next_run_ok
        && get("notify").as_bool().is_some()
        && get("mode").as_str() == Some("llm")
        && matches!(get("permission").as_str(), Some("read-only") | Some("full"))
        && project_ok
        && mcp_servers_are_valid
        && (get("workspaceId").is_null() || mcp_server_ids.is_empty())
        && safe_approval_text(get("providerId"), 160, false)
        && safe_approval_text(get("providerName"), 120, false)
        && safe_approval_text(get("model"), 256, false)
        && safe_approval_text(get("modelName"), 256, false)
        && (mcp_server_ids.is_empty() || get("permission").as_str() == Some("full"))
        && (get("permission").as_str() != Some("full")
            || !get("workspaceId").is_null()
            || !mcp_server_ids.is_empty())
        && get("schedulerEnabled").as_bool().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mcp_mutation() -> Value {
        json!({
            "kind": "subagent-mcp-mutation",
            "childLabel": "Publisher",
            "serverId": "docs",
            "toolName": "publish",
            "connectionDigestPrefix": "aaaaaaaaaaaa",
            "schemaDigestPrefix": "bbbbbbbbbbbb",
            "profileDigestPrefix": "cccccccccccc",
            "argumentDigestPrefix": "dddddddddddd",
            "classification": "declared_mutating",
            "destructive": "destructive",
            "idempotency": "not_declared",
            "openWorld": "open",
            "taskSupport": "optional",
            "timeoutMs": 30_000,
            "canonicalArguments": "{\"title\":\"Safe\\u202e title\",\"value\":1}",
            "priorUnknownEffect": false,
            "automaticRetry": false,
            "rollbackAvailable": false,
        })
    }

    fn base() -> Value {
        json!({
            "kind": "assistant-automation",
            "action": "create",
            "name": "Daily report",
            "prompt": "Update the report.",
            "cron": "0 9 * * *",
            "timezone": "UTC",
            "nextRunAt": 1_800_000_000_000_i64,
            "notify": true,
            "mode": "llm",
            "permission": "read-only",
            "workspaceId": null,
            "workspaceName": null,
            "mcpServerIds": [],
            "mcpServerNames": [],
            "providerId": "local-provider",
            "providerName": "Local Provider",
            "model": "local-model",
            "modelName": "Local Model",
            "schedulerEnabled": true,
        })
    }

    fn workspace_write() -> Value {
        json!({
            "kind": "subagent-workspace-write",
            "operation": "edit",
            "childLabel": "Correct the parser",
            "path": "renderer/shared/assistant.ts",
            "workspaceLabel": "Aiden",
            "worktreeLabel": null,
            "isManagedWorktree": false,
            "preDigestPrefix": "0123456789ab",
            "postDigestPrefix": "abcdef012345",
            "beforeBytes": 1_024,
            "afterBytes": 1_080,
            "diffPreview": "- old\n+ new",
            "diffTruncated": false,
            "commandWillRun": false,
            "refuseIfChanged": true,
        })
    }

    #[test]
    fn assistant_automation_details_require_a_matching_project_identity_for_full_access() {
        assert!(is_assistant_automation_approval_details(&base()));
        assert!(is_assistant_automation_approval_details(&{
            let mut value = base();
            value["permission"] = json!("full");
            value["workspaceId"] = json!("workspace-1");
            value["workspaceName"] = json!("Website");
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["permission"] = json!("full");
            value["workspaceId"] = json!("workspace-1");
            value["workspaceName"] = json!("Website");
            value["mcpServerIds"] = json!(["gmail"]);
            value["mcpServerNames"] = json!(["Gmail"]);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["permission"] = json!("full");
            value
        }));
        assert!(is_assistant_automation_approval_details(&{
            let mut value = base();
            value["permission"] = json!("full");
            value["mcpServerIds"] = json!(["gmail"]);
            value["mcpServerNames"] = json!(["Gmail"]);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["mcpServerIds"] = json!(["gmail"]);
            value["mcpServerNames"] = json!(["Gmail"]);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["permission"] = json!("full");
            value["mcpServerIds"] = json!(["gmail"]);
            value["mcpServerNames"] = json!([]);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["workspaceId"] = json!("workspace-1");
            value["workspaceName"] = Value::Null;
            value
        }));
    }

    #[test]
    fn assistant_edit_approvals_require_an_exact_task_identity_and_enabled_state() {
        assert!(is_assistant_automation_approval_details(&{
            let mut value = base();
            value["action"] = json!("edit");
            value["taskId"] = json!("task-1");
            value["enabled"] = json!(true);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["action"] = json!("edit");
            value["enabled"] = json!(true);
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["action"] = json!("edit");
            value["taskId"] = json!("task-1");
            value
        }));
        assert!(!is_assistant_automation_approval_details(&{
            let mut value = base();
            value["taskId"] = json!("task-1");
            value
        }));
    }

    #[test]
    fn subagent_workspace_write_details_accept_only_exact_bounded_truthful_fields() {
        assert!(is_subagent_workspace_write_approval_details(
            &workspace_write()
        ));
        assert!(is_subagent_workspace_write_approval_details(&{
            let mut value = workspace_write();
            value["diffPreview"] = json!("- old\n+ new\n");
            value
        }));
        assert!(is_subagent_workspace_write_approval_details(&{
            let mut value = workspace_write();
            value["isManagedWorktree"] = json!(true);
            value["worktreeLabel"] = json!("feature/approval-ui");
            value
        }));
        let invalid: Vec<Value> = vec![
            {
                let mut v = workspace_write();
                v["extra"] = json!(true);
                v
            },
            {
                let mut v = workspace_write();
                v["operation"] = json!("delete");
                v
            },
            {
                let mut v = workspace_write();
                v["childLabel"] = json!("Unsafe\nlabel");
                v
            },
            {
                let mut v = workspace_write();
                v["path"] = json!("/tmp/outside");
                v
            },
            {
                let mut v = workspace_write();
                v["path"] = json!("src/../outside");
                v
            },
            {
                let mut v = workspace_write();
                v["path"] = json!("src\\outside");
                v
            },
            {
                let mut v = workspace_write();
                v["path"] = json!("src//file.ts");
                v
            },
            {
                let mut v = workspace_write();
                v["worktreeLabel"] = json!("feature/x");
                v
            },
            {
                let mut v = workspace_write();
                v["isManagedWorktree"] = json!(true);
                v["worktreeLabel"] = Value::Null;
                v
            },
            {
                let mut v = workspace_write();
                v["preDigestPrefix"] = json!("ABCDEF012345");
                v
            },
            {
                let mut v = workspace_write();
                v["postDigestPrefix"] = json!("too-short");
                v
            },
            {
                let mut v = workspace_write();
                v["beforeBytes"] = json!(-1);
                v
            },
            {
                let mut v = workspace_write();
                v["afterBytes"] = json!(i64::MAX);
                v
            },
            {
                let mut v = workspace_write();
                v["diffPreview"] = json!("   \n");
                v
            },
            {
                let mut v = workspace_write();
                v["diffPreview"] = json!("+ unsafe\u{202e}");
                v
            },
            {
                let mut v = workspace_write();
                v["commandWillRun"] = json!(true);
                v
            },
            {
                let mut v = workspace_write();
                v["refuseIfChanged"] = json!(false);
                v
            },
        ];
        for entry in &invalid {
            assert!(
                !is_subagent_workspace_write_approval_details(entry),
                "{entry}"
            );
        }
    }

    #[test]
    fn subagent_create_approvals_bind_absence_while_edits_bind_a_preimage() {
        assert!(is_subagent_workspace_write_approval_details(&{
            let mut value = workspace_write();
            value["operation"] = json!("create");
            value["preDigestPrefix"] = Value::Null;
            value["beforeBytes"] = json!(0);
            value
        }));
        assert!(!is_subagent_workspace_write_approval_details(&{
            let mut value = workspace_write();
            value["operation"] = json!("create");
            value
        }));
        assert!(!is_subagent_workspace_write_approval_details(&{
            let mut value = workspace_write();
            value["preDigestPrefix"] = Value::Null;
            value
        }));
    }

    #[test]
    fn workspace_write_display_fields_reject_bidi_controls_and_unicode_line_separators() {
        let unsafe_chars = ['\u{61c}', '\u{200e}', '\u{200f}', '\u{2028}', '\u{2029}'];
        for character in unsafe_chars {
            let mut cases: Vec<Value> = Vec::new();
            let mut case = workspace_write();
            case["childLabel"] = json!(format!("child{character}label"));
            cases.push(case);
            let mut case = workspace_write();
            case["path"] = json!(format!("src/{character}file.ts"));
            cases.push(case);
            let mut case = workspace_write();
            case["workspaceLabel"] = json!(format!("work{character}space"));
            cases.push(case);
            let mut case = workspace_write();
            case["isManagedWorktree"] = json!(true);
            case["worktreeLabel"] = json!(format!("feature/{character}write"));
            cases.push(case);
            let mut case = workspace_write();
            case["diffPreview"] = json!(format!("- old\n+ new{character}line"));
            cases.push(case);
            for entry in &cases {
                assert!(
                    !is_subagent_workspace_write_approval_details(entry),
                    "{entry}"
                );
            }
        }
    }

    #[test]
    fn mcp_mutation_details_require_exact_canonical_safe_arguments_and_literal_safeguards() {
        assert!(is_subagent_mcp_mutation_approval_details(&mcp_mutation()));
        let invalid: Vec<Value> = vec![
            {
                let mut v = mcp_mutation();
                v["extra"] = json!(true);
                v
            },
            {
                let mut v = mcp_mutation();
                v["classification"] = json!("read");
                v
            },
            {
                let mut v = mcp_mutation();
                v["connectionDigestPrefix"] = json!("short");
                v
            },
            {
                let mut v = mcp_mutation();
                v["timeoutMs"] = json!(0);
                v
            },
            {
                let mut v = mcp_mutation();
                v["automaticRetry"] = json!(true);
                v
            },
            {
                let mut v = mcp_mutation();
                v["rollbackAvailable"] = json!(true);
                v
            },
            {
                let mut v = mcp_mutation();
                v["canonicalArguments"] = json!("{\"value\":1,\"title\":\"out of order\"}");
                v
            },
            {
                let mut v = mcp_mutation();
                v["canonicalArguments"] = json!("{\"title\":\"raw\u{202e}\",\"value\":1}");
                v
            },
            {
                let mut v = mcp_mutation();
                v["canonicalArguments"] = json!("[]");
                v
            },
        ];
        for entry in &invalid {
            assert!(!is_subagent_mcp_mutation_approval_details(entry), "{entry}");
        }
    }

    #[test]
    fn canonical_json_escapes_controls_and_sorts_keys() {
        let parsed: Value =
            serde_json::from_str(r#"{"title":"Safe\u202e title","value":1}"#).unwrap();
        let canonical = canonical_parsed_json(&parsed).unwrap();
        // Canonical JSON keeps the raw bidi char (like JSON.stringify); the
        // escape pass turns it back into the \u202e escape, round-tripping the
        // exact canonicalArguments fixture.
        assert_eq!(canonical, "{\"title\":\"Safe\u{202e} title\",\"value\":1}");
        let escaped = escape_subagent_mcp_mutation_approval_json(&canonical);
        assert_eq!(escaped, r#"{"title":"Safe\u202e title","value":1}"#);
        assert_eq!(
            canonical_parsed_json(&json!({ "b": 2, "a": 1 })).unwrap(),
            r#"{"a":1,"b":2}"#
        );
        assert_eq!(
            canonical_parsed_json(&json!([1, "x", null])).unwrap(),
            r#"[1,"x",null]"#
        );
        // Raw controls get escaped, so the escaped form round-trips the check.
        let raw_control = "{\"title\":\"unsafe\u{1b} title\",\"value\":1}".to_string();
        assert_ne!(
            escape_subagent_mcp_mutation_approval_json(&raw_control),
            raw_control
        );
        assert_eq!(
            escape_subagent_mcp_mutation_approval_json(&raw_control),
            r#"{"title":"unsafe\u001b title","value":1}"#
        );
    }

    #[test]
    fn shell_approval_details_are_exact() {
        let shell = json!({
            "kind": "subagent-shell",
            "childLabel": "Run tests",
            "command": "cargo test",
            "initialCwd": "/Users/sambit/project",
            "shell": "/bin/zsh -f -c",
            "argumentDigestPrefix": "aaaaaaaaaaaa",
            "rootDigestPrefix": "bbbbbbbbbbbb",
            "effectDigestPrefix": "cccccccccccc",
            "timeoutMs": 30_000,
            "stdoutLimitBytes": 524288,
            "stderrLimitBytes": 524288,
            "workspaceLabel": "Aiden",
            "isManagedWorktree": false,
            "worktreeLabel": null,
            "environmentProfile": "minimal-private-0700-v1",
            "osSandboxed": false,
            "rollbackAvailable": false,
            "outputSentToModel": true,
            "arbitraryNetworkAvailable": true,
            "detachedProcessesMaySurvive": true,
        });
        assert!(is_subagent_shell_approval_details(&shell));
        let mut bad_shell = shell.clone();
        bad_shell["shell"] = json!("/bin/bash");
        assert!(!is_subagent_shell_approval_details(&bad_shell));
        let mut bad_cwd = shell.clone();
        bad_cwd["initialCwd"] = json!("relative/path");
        assert!(!is_subagent_shell_approval_details(&bad_cwd));
        let mut bad_flags = shell.clone();
        bad_flags["osSandboxed"] = json!(true);
        assert!(!is_subagent_shell_approval_details(&bad_flags));
        let mut bad_safe = shell;
        bad_safe["command"] = json!("echo \u{1b}escape");
        assert!(!is_subagent_shell_approval_details(&bad_safe));
    }
}
