//! Port of `main/services/subagents/approval-v2.ts` — digest-pinned one-shot
//! approvals. `subagent_approval_argument_digest_v2` canonicalizes plain JSON
//! (no getters/proxies can exist in serde_json values, so the structural checks
//! reduce to depth/entry/byte limits) and binds a tool identity. The ledger is
//! the owner-bound prepare → authorize → consume state machine.

use std::collections::HashMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::safe_text::is_safe_subagent_identifier_str;

pub const MAX_CANONICAL_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_CANONICAL_DEPTH: usize = 32;
const MAX_CANONICAL_ENTRIES: usize = 2_048;
const MAX_PENDING_SUBAGENT_APPROVALS: usize = 128;
const MAX_SUBAGENT_APPROVAL_ID_ALLOCATION_ATTEMPTS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentApprovalBindingV2 {
    pub tree_root_id: String,
    pub run_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub owner_document_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub authority_revision: u64,
    pub argument_digest: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone)]
pub struct PrepareSubagentApprovalV2Input {
    pub tree_root_id: String,
    pub run_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub owner_document_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub authority_revision: u64,
    pub arguments: Value,
    pub expires_at: u64,
}

struct CanonicalState {
    depth: usize,
    entries: usize,
}

fn json_string(value: &str) -> String {
    // serde_json escapes non-ASCII? No: it emits raw UTF-8, matching
    // JSON.stringify for text except for U+2028/U+2029 (both emit raw in
    // JSON.stringify too in modern engines, and serde_json emits raw as well).
    serde_json::to_string(value).expect("string serialization cannot fail")
}

fn canonical_value(value: &Value, state: &mut CanonicalState) -> Result<String, String> {
    state.entries += 1;
    if state.entries > MAX_CANONICAL_ENTRIES {
        return Err("Subagent approval arguments exceed their structural limit.".to_string());
    }
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(_) | Value::String(_) => Ok(serde_json::to_string(value).expect("json")),
        Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if !float.is_finite() {
                    return Err("Subagent approval arguments are not finite.".to_string());
                }
            }
            // Normalize -0 to 0 (JS JSON.stringify behavior).
            if number.as_f64() == Some(0.0) && number.is_i64() {
                // integers: serde emits -0 as "0" for i64 0 already; f64 -0.0
                // is normalized explicitly below.
            }
            if let Some(float) = number.as_f64() {
                if float == 0.0 && float.is_sign_negative() {
                    return Ok("0".to_string());
                }
            }
            Ok(number.to_string())
        }
        Value::Array(values) => {
            if state.depth + 1 > MAX_CANONICAL_DEPTH {
                return Err(
                    "Subagent approval arguments exceed their structural limit.".to_string()
                );
            }
            if values.len() > MAX_CANONICAL_ENTRIES {
                return Err(
                    "Subagent approval arguments exceed their structural limit.".to_string()
                );
            }
            state.depth += 1;
            let mut entries = Vec::with_capacity(values.len());
            for value in values {
                entries.push(canonical_value(value, state)?);
            }
            state.depth -= 1;
            Ok(format!("[{}]", entries.join(",")))
        }
        Value::Object(object) => {
            if state.depth + 1 > MAX_CANONICAL_DEPTH {
                return Err(
                    "Subagent approval arguments exceed their structural limit.".to_string()
                );
            }
            state.depth += 1;
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            let mut entries = Vec::with_capacity(keys.len());
            for key in keys {
                let value = object.get(key).expect("key present");
                entries.push(format!(
                    "{}:{}",
                    json_string(key),
                    canonical_value(value, state)?
                ));
            }
            state.depth -= 1;
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

/// `subagentApprovalArgumentDigestV2` — canonicalized plain-JSON digest bound to
/// an exact tool identity.
pub fn subagent_approval_argument_digest_v2(
    tool_name: &str,
    value: &Value,
) -> Result<String, String> {
    if !is_safe_subagent_identifier_str(tool_name) {
        return Err("Invalid subagent approval tool identity.".to_string());
    }
    let wrapper = serde_json::json!({ "toolName": tool_name, "arguments": value });
    let canonical = canonical_value(
        &wrapper,
        &mut CanonicalState {
            depth: 0,
            entries: 0,
        },
    )?;
    if canonical.len() > MAX_CANONICAL_ARGUMENT_BYTES {
        return Err("Subagent approval arguments exceed their byte limit.".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(crate::authority::hex(&hasher.finalize()))
}

/// `canonicalSubagentApprovalArgumentsV2` — snapshot plain JSON without any
/// coercion hooks.
pub fn canonical_subagent_approval_arguments_v2(
    value: &Value,
    maximum_bytes: usize,
) -> Result<String, String> {
    if !(1..=MAX_CANONICAL_ARGUMENT_BYTES).contains(&maximum_bytes) {
        return Err("Invalid subagent approval argument byte limit.".to_string());
    }
    let canonical = canonical_value(
        value,
        &mut CanonicalState {
            depth: 0,
            entries: 0,
        },
    )?;
    if canonical.len() > maximum_bytes {
        return Err("Subagent approval arguments exceed their byte limit.".to_string());
    }
    Ok(canonical)
}

fn valid_binding(binding: &SubagentApprovalBindingV2) -> bool {
    let identifiers = [
        &binding.tree_root_id,
        &binding.run_id,
        &binding.child_id,
        &binding.chat_id,
        &binding.workspace_id,
        &binding.tool_call_id,
        &binding.tool_name,
    ];
    identifiers
        .iter()
        .all(|value| is_safe_subagent_identifier_str(value))
        && !binding.owner_document_id.is_empty()
        && binding.owner_document_id.len() <= 256
        && !binding.owner_document_id.contains('\0')
        && binding.authority_revision >= 1
        && binding.argument_digest.len() == 64
        && binding
            .argument_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        && binding.expires_at > 0
}

fn same_binding(
    binding: &SubagentApprovalBindingV2,
    current: &PrepareSubagentApprovalV2Input,
) -> bool {
    let current_digest =
        subagent_approval_argument_digest_v2(&current.tool_name, &current.arguments);
    let Ok(current_digest) = current_digest else {
        return false;
    };
    binding.tree_root_id == current.tree_root_id
        && binding.run_id == current.run_id
        && binding.child_id == current.child_id
        && binding.chat_id == current.chat_id
        && binding.workspace_id == current.workspace_id
        && binding.owner_document_id == current.owner_document_id
        && binding.tool_call_id == current.tool_call_id
        && binding.tool_name == current.tool_name
        && binding.authority_revision == current.authority_revision
        && binding.argument_digest == current_digest
        && binding.expires_at == current.expires_at
}

#[derive(Clone)]
struct PendingSubagentApprovalV2 {
    binding: SubagentApprovalBindingV2,
    authorized: bool,
}

/// Owner-bound one-shot approval ledger. The owner document id fences every
/// authorize/deny; the exact binding (including the argument digest) must match
/// at authorize and consume time.
#[derive(Default)]
pub struct SubagentApprovalLedgerV2 {
    pending: HashMap<String, PendingSubagentApprovalV2>,
    call_owners: std::collections::HashSet<String>,
}

impl SubagentApprovalLedgerV2 {
    pub fn new() -> Self {
        Self::default()
    }

    fn remove_expired(&mut self, now: u64) {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.binding.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(pending) = self.pending.remove(&id) {
                self.remove_pending(&id, &pending);
            }
        }
    }

    fn remove_pending(&mut self, approval_id: &str, pending: &PendingSubagentApprovalV2) {
        self.pending.remove(approval_id);
        self.call_owners.remove(&format!(
            "{}\0{}",
            pending.binding.run_id, pending.binding.tool_call_id
        ));
    }

    /// Prepare a new approval; returns `(approval_id, binding)`.
    pub fn prepare(
        &mut self,
        input: &PrepareSubagentApprovalV2Input,
        now: u64,
        allocate_id: &mut dyn FnMut() -> String,
    ) -> Result<(String, SubagentApprovalBindingV2), String> {
        self.remove_expired(now);
        if self.pending.len() >= MAX_PENDING_SUBAGENT_APPROVALS {
            return Err("Too many subagent approvals are pending.".to_string());
        }
        let argument_digest =
            subagent_approval_argument_digest_v2(&input.tool_name, &input.arguments)?;
        let binding = SubagentApprovalBindingV2 {
            tree_root_id: input.tree_root_id.clone(),
            run_id: input.run_id.clone(),
            child_id: input.child_id.clone(),
            chat_id: input.chat_id.clone(),
            workspace_id: input.workspace_id.clone(),
            owner_document_id: input.owner_document_id.clone(),
            tool_call_id: input.tool_call_id.clone(),
            tool_name: input.tool_name.clone(),
            authority_revision: input.authority_revision,
            argument_digest,
            expires_at: input.expires_at,
        };
        if !valid_binding(&binding) || binding.expires_at <= now {
            return Err("Invalid or expired subagent approval binding.".to_string());
        }
        let call_owner = format!("{}\0{}", binding.run_id, binding.tool_call_id);
        if self.call_owners.contains(&call_owner) {
            return Err("A subagent tool call already has an approval binding.".to_string());
        }
        let mut approval_id = None;
        for _ in 0..MAX_SUBAGENT_APPROVAL_ID_ALLOCATION_ATTEMPTS {
            let candidate = allocate_id();
            if is_safe_subagent_identifier_str(&candidate) && !self.pending.contains_key(&candidate)
            {
                approval_id = Some(candidate);
                break;
            }
        }
        let Some(approval_id) = approval_id else {
            return Err("Could not allocate a subagent approval identity.".to_string());
        };
        self.call_owners.insert(call_owner);
        self.pending.insert(
            approval_id.clone(),
            PendingSubagentApprovalV2 {
                binding: binding.clone(),
                authorized: false,
            },
        );
        Ok((approval_id, binding))
    }

    /// Authorize a prepared approval if the owner and binding still match.
    pub fn authorize(
        &mut self,
        approval_id: &str,
        owner_document_id: &str,
        current: &PrepareSubagentApprovalV2Input,
        now: u64,
    ) -> bool {
        let Some(pending) = self.pending.get(approval_id) else {
            return false;
        };
        if pending.authorized || pending.binding.owner_document_id != owner_document_id {
            return false;
        }
        if pending.binding.expires_at <= now {
            let pending = self.pending.remove(approval_id).expect("present");
            self.call_owners.remove(&format!(
                "{}\0{}",
                pending.binding.run_id, pending.binding.tool_call_id
            ));
            return false;
        }
        if !same_binding(&pending.binding, current) {
            return false;
        }
        let pending = self.pending.get_mut(approval_id).expect("present");
        pending.authorized = true;
        true
    }

    /// Consume an authorized approval (one-shot).
    pub fn consume(
        &mut self,
        approval_id: &str,
        current: &PrepareSubagentApprovalV2Input,
        now: u64,
    ) -> bool {
        let Some(pending) = self.pending.get(approval_id) else {
            return false;
        };
        if !pending.authorized {
            return false;
        }
        if pending.binding.expires_at <= now {
            let pending = self.pending.remove(approval_id).expect("present");
            self.call_owners.remove(&format!(
                "{}\0{}",
                pending.binding.run_id, pending.binding.tool_call_id
            ));
            return false;
        }
        if !same_binding(&pending.binding, current) {
            return false;
        }
        let pending = self.pending.remove(approval_id).expect("present");
        self.call_owners.remove(&format!(
            "{}\0{}",
            pending.binding.run_id, pending.binding.tool_call_id
        ));
        true
    }

    pub fn deny(&mut self, approval_id: &str, owner_document_id: &str) -> bool {
        let Some(pending) = self.pending.get(approval_id) else {
            return false;
        };
        if pending.binding.owner_document_id != owner_document_id {
            return false;
        }
        let pending = self.pending.remove(approval_id).expect("present");
        self.call_owners.remove(&format!(
            "{}\0{}",
            pending.binding.run_id, pending.binding.tool_call_id
        ));
        true
    }

    pub fn cancel_run(&mut self, run_id: &str) {
        let cancelled: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.binding.run_id == run_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in cancelled {
            if let Some(pending) = self.pending.remove(&id) {
                self.call_owners.remove(&format!(
                    "{}\0{}",
                    pending.binding.run_id, pending.binding.tool_call_id
                ));
            }
        }
    }

    pub fn clear(&mut self) {
        self.pending.clear();
        self.call_owners.clear();
    }

    pub fn pending_count(&mut self, now: u64) -> usize {
        self.remove_expired(now);
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding_input(
        tool_call_id: &str,
        tool_name: &str,
        args: Value,
    ) -> PrepareSubagentApprovalV2Input {
        PrepareSubagentApprovalV2Input {
            tree_root_id: "tree-1".into(),
            run_id: "run-1".into(),
            child_id: "child-1".into(),
            chat_id: "chat-1".into(),
            workspace_id: "workspace-1".into(),
            owner_document_id: "document-1".into(),
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            authority_revision: 1,
            arguments: args,
            expires_at: 10_000,
        }
    }

    #[test]
    fn canonical_arguments_are_stable_and_bounded() {
        let value = json!({
            "b": [1, 2.5, "text", true, null],
            "a": { "nested": { "key": "value" } },
        });
        let canonical =
            canonical_subagent_approval_arguments_v2(&value, MAX_CANONICAL_ARGUMENT_BYTES).unwrap();
        assert_eq!(
            canonical,
            r#"{"a":{"nested":{"key":"value"}},"b":[1,2.5,"text",true,null]}"#
        );
        // Re-serialization stability.
        let again =
            canonical_subagent_approval_arguments_v2(&value, MAX_CANONICAL_ARGUMENT_BYTES).unwrap();
        assert_eq!(canonical, again);
    }

    #[test]
    fn canonical_arguments_normalize_negative_zero() {
        let value = serde_json::from_str::<Value>("{\"x\":-0.0}").unwrap();
        let canonical =
            canonical_subagent_approval_arguments_v2(&value, MAX_CANONICAL_ARGUMENT_BYTES).unwrap();
        assert_eq!(canonical, r#"{"x":0}"#);
    }

    #[test]
    fn canonical_arguments_reject_deep_structures() {
        // 40 levels of nesting.
        let mut value = json!(1);
        for _ in 0..40 {
            value = json!({ "nested": value });
        }
        assert!(
            canonical_subagent_approval_arguments_v2(&value, MAX_CANONICAL_ARGUMENT_BYTES).is_err()
        );
    }

    #[test]
    fn digest_is_exact_and_tool_bound() {
        let args = json!({ "path": "src/main.rs", "content": "fn main() {}" });
        let digest = subagent_approval_argument_digest_v2("write_file", &args).unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(
            subagent_approval_argument_digest_v2("write_file", &args).unwrap(),
            digest
        );
        // Different tool identity -> different digest.
        assert_ne!(
            subagent_approval_argument_digest_v2("edit_file", &args).unwrap(),
            digest
        );
        // Different argument order is the same canonical object (sorted keys).
        let reordered = json!({ "content": "fn main() {}", "path": "src/main.rs" });
        assert_eq!(
            subagent_approval_argument_digest_v2("write_file", &reordered).unwrap(),
            digest
        );
        // Unsafe tool name fails.
        assert!(subagent_approval_argument_digest_v2("not safe!", &args).is_err());
    }

    #[test]
    fn ledger_prepare_authorize_consume_is_one_shot() {
        let mut ledger = SubagentApprovalLedgerV2::new();
        let mut allocate = || "approval-1".to_string();
        let input = binding_input("call-1", "write_file", json!({ "path": "a.txt" }));
        let (approval_id, binding) = ledger.prepare(&input, 100, &mut allocate).unwrap();
        assert_eq!(approval_id, "approval-1");
        assert_eq!(binding.argument_digest.len(), 64);

        // Wrong owner cannot authorize.
        let mut wrong_owner = input.clone();
        wrong_owner.owner_document_id = "other-document".into();
        assert!(!ledger.authorize(&approval_id, "other-document", &wrong_owner, 100));

        // Exact match authorizes.
        assert!(ledger.authorize(&approval_id, "document-1", &input, 100));
        // Consume succeeds once.
        assert!(ledger.consume(&approval_id, &input, 100));
        // Second consume fails.
        assert!(!ledger.consume(&approval_id, &input, 100));
        assert_eq!(ledger.pending_count(100), 0);
    }

    #[test]
    fn ledger_rejects_changed_arguments_at_consume() {
        let mut ledger = SubagentApprovalLedgerV2::new();
        let mut allocate = || "approval-2".to_string();
        let input = binding_input("call-2", "write_file", json!({ "path": "a.txt" }));
        let (approval_id, _) = ledger.prepare(&input, 100, &mut allocate).unwrap();
        assert!(ledger.authorize(&approval_id, "document-1", &input, 100));
        let mut changed = input.clone();
        changed.arguments = json!({ "path": "b.txt" });
        assert!(!ledger.consume(&approval_id, &changed, 100));
        // The original still consumes.
        assert!(ledger.consume(&approval_id, &input, 100));
    }

    #[test]
    fn ledger_expiry_removes_pending() {
        let mut ledger = SubagentApprovalLedgerV2::new();
        let mut allocate = || "approval-3".to_string();
        let input = binding_input("call-3", "write_file", json!({}));
        let (approval_id, _) = ledger.prepare(&input, 100, &mut allocate).unwrap();
        assert!(!ledger.authorize(&approval_id, "document-1", &input, 20_000));
        assert_eq!(ledger.pending_count(20_000), 0);
    }

    #[test]
    fn ledger_denies_duplicate_call_owners_and_cancels_by_run() {
        let mut ledger = SubagentApprovalLedgerV2::new();
        let mut allocate = || "approval-4".to_string();
        let input = binding_input("call-4", "write_file", json!({}));
        let (_, _) = ledger.prepare(&input, 100, &mut allocate).unwrap();
        // Same tool call cannot be prepared twice.
        assert!(ledger.prepare(&input, 100, &mut allocate).is_err());
        ledger.cancel_run("run-1");
        assert_eq!(ledger.pending_count(100), 0);
    }
}
