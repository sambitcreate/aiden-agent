//! Port of `main/services/subagents/outbound-approval-v2.ts` — the
//! foreground-only one-shot approval hook for exact child egress tools (web +
//! MCP reads). The model's capability request is only an authority ceiling;
//! every exact invocation still receives one owner-bound grant.

use serde_json::Value;

use crate::approval::{PrepareSubagentApprovalV2Input, SubagentApprovalLedgerV2};
use crate::authority::{SubagentAuthorityV2, SubagentExecutionModeV2, SubagentMcpToolScopeV2};

pub const SUBAGENT_EGRESS_APPROVAL_WINDOW_MS: u64 = 60_000;
pub const MAX_SUBAGENT_MCP_APPROVAL_ARGUMENT_BYTES: usize = 8 * 1024;
pub const MAX_SUBAGENT_OUTBOUND_APPROVAL_SUMMARY_CHARS: usize = 12_000;

#[derive(Debug, Clone)]
pub struct SubagentOutboundMcpBinding {
    pub server_id: String,
    pub connection_fingerprint: String,
    pub tool: SubagentMcpToolScopeV2,
}

#[derive(Debug, Clone)]
pub struct SubagentOutboundToolBindingV2 {
    pub tool_name: String,
    pub kind: &'static str,
    pub mcp: Option<SubagentOutboundMcpBinding>,
}

/// `sameSubagentAuthorityBindingV2` — exact identity + capability/budget
/// equality (canonical JSON).
pub fn same_subagent_authority_binding_v2(
    expected: &SubagentAuthorityV2,
    current: Option<&SubagentAuthorityV2>,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    current.version == expected.version
        && current.grant_id == expected.grant_id
        && current.tree_root_id == expected.tree_root_id
        && current.run_id == expected.run_id
        && current.parent_run_id == expected.parent_run_id
        && current.depth == expected.depth
        && current.authority_revision == expected.authority_revision
        && current.generation_id == expected.generation_id
        && current.chat_id == expected.chat_id
        && current.workspace_id == expected.workspace_id
        && current.workspace_revision == expected.workspace_revision
        && current.owner_document_id == expected.owner_document_id
        && current.provider_fingerprint == expected.provider_fingerprint
        && current.model_fingerprint == expected.model_fingerprint
        && current.context_revision == expected.context_revision
        && current.execution == expected.execution
        && current.context == expected.context
        && current.thinking_level == expected.thinking_level
        && current.expires_at == expected.expires_at
        && serde_json::to_string(&current.capabilities).expect("json")
            == serde_json::to_string(&expected.capabilities).expect("json")
        && serde_json::to_string(&current.budgets).expect("json")
            == serde_json::to_string(&expected.budgets).expect("json")
}

pub fn authority_allows(
    authority: &SubagentAuthorityV2,
    binding: &SubagentOutboundToolBindingV2,
) -> bool {
    if authority.execution != SubagentExecutionModeV2::Foreground {
        return false;
    }
    if binding.kind == "web" {
        return authority.capabilities.web && binding.mcp.is_none();
    }
    let Some(mcp) = &binding.mcp else {
        return false;
    };
    if mcp.tool.effect() != crate::authority::SubagentMcpEffectV2::Read {
        return false;
    }
    authority.capabilities.mcp.iter().any(|scope| {
        scope.server_id == mcp.server_id
            && scope.connection_fingerprint == mcp.connection_fingerprint
            && scope.tools.iter().any(|tool| {
                tool.tool_name() == mcp.tool.tool_name()
                    && tool.schema_hash() == mcp.tool.schema_hash()
                    && tool.effect() == crate::authority::SubagentMcpEffectV2::Read
            })
    })
}

fn blocked(reason: &str) -> Blocked {
    Blocked {
        reason: reason.to_string(),
    }
}

pub struct Blocked {
    pub reason: String,
}

/// `canonicalApprovalValue` — a display-only plain JSON reduction.
pub fn canonical_approval_value(value: &Value) -> Result<Value, String> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            if number
                .as_f64()
                .map(|float| float.is_finite())
                .unwrap_or(false)
            {
                Ok(value.clone())
            } else {
                Err("Subagent approval arguments are not displayable.".to_string())
            }
        }
        Value::Array(values) => values
            .iter()
            .map(canonical_approval_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            let mut result = serde_json::Map::new();
            for key in keys {
                result.insert(
                    key.clone(),
                    canonical_approval_value(object.get(key).expect("key"))?,
                );
            }
            Ok(Value::Object(result))
        }
    }
}

/// `subagentOutboundApprovalSummaryV2` — the fixed human-readable summary.
pub fn subagent_outbound_approval_summary_v2(
    binding: &SubagentOutboundToolBindingV2,
    arguments_value: &Value,
) -> Result<String, String> {
    let args = canonical_approval_value(arguments_value)?;
    let summary = if binding.kind == "web" {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| "Subagent web approval query is invalid.".to_string())?;
        let result_count = args.get("numResults").and_then(Value::as_u64).unwrap_or(5);
        format!(
            "Search the public web\nQuery: {}\nResults: {}",
            serde_json::to_string(query).expect("json"),
            serde_json::to_string(&result_count).expect("json")
        )
    } else {
        let mcp = binding
            .mcp
            .as_ref()
            .ok_or_else(|| "Subagent MCP approval binding is invalid.".to_string())?;
        let canonical_arguments = serde_json::to_string(&args).expect("json");
        if canonical_arguments.len() > MAX_SUBAGENT_MCP_APPROVAL_ARGUMENT_BYTES {
            return Err(
                "Subagent MCP approval arguments are too large to review safely.".to_string(),
            );
        }
        format!(
            "Call server-declared read-only MCP tool {}:{}\nThe configured server controls the actual effect.\nArguments: {}",
            mcp.server_id,
            mcp.tool.tool_name(),
            canonical_arguments
        )
    };
    if summary.len() > MAX_SUBAGENT_OUTBOUND_APPROVAL_SUMMARY_CHARS {
        return Err("Subagent approval summary is too large to review safely.".to_string());
    }
    Ok(summary)
}

pub struct SubagentOutboundApprovalBrokerV2Input {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub tools: Vec<SubagentOutboundToolBindingV2>,
    pub ledger: SubagentApprovalLedgerV2,
    pub current_authority: Box<dyn Fn(&str) -> Option<SubagentAuthorityV2> + Send + Sync>,
    pub request_approval: Box<dyn Fn(&str, &str) -> Result<bool, String> + Send + Sync>,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub allocate_id: Box<dyn Fn() -> String + Send + Sync>,
}

pub struct SubagentOutboundApprovalGateV2 {
    pub authority: SubagentAuthorityV2,
    pub child_id: String,
    pub ledger: SubagentApprovalLedgerV2,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub allocate_id: Box<dyn Fn() -> String + Send + Sync>,
    tools: std::collections::HashMap<String, SubagentOutboundToolBindingV2>,
    authorized: std::collections::HashMap<String, AuthorizedEntry>,
}

struct AuthorizedEntry {
    approval_id: String,
    expires_at: u64,
    tool_name: String,
}

impl SubagentOutboundApprovalGateV2 {
    pub fn new(input: SubagentOutboundApprovalBrokerV2Input) -> Result<Self, String> {
        let mut tools: std::collections::HashMap<String, SubagentOutboundToolBindingV2> =
            std::collections::HashMap::new();
        for tool in input.tools {
            if tools.contains_key(&tool.tool_name) {
                return Err("Duplicate subagent outbound tool approval binding.".to_string());
            }
            if !authority_allows(&input.authority, &tool) {
                return Err("Subagent outbound tool exceeds its authority ceiling.".to_string());
            }
            tools.insert(tool.tool_name.clone(), tool);
        }
        Ok(SubagentOutboundApprovalGateV2 {
            authority: input.authority,
            child_id: input.child_id,
            ledger: input.ledger,
            now: input.now,
            allocate_id: input.allocate_id,
            tools,
            authorized: std::collections::HashMap::new(),
        })
    }

    /// `beforeToolCall` — prepare, request approval, and authorize.
    pub fn before_tool_call(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        args: &Value,
        current_authority: &dyn Fn(&str) -> Option<SubagentAuthorityV2>,
        request_approval: &mut dyn FnMut(&str, &str) -> Result<bool, String>,
    ) -> Result<Option<Blocked>, String> {
        let Some(binding) = self.tools.get(tool_name).cloned() else {
            return Ok(Some(blocked(
                "This subagent outbound tool is outside its approved authority.",
            )));
        };
        let authority = current_authority(&self.authority.run_id);
        if !same_subagent_authority_binding_v2(&self.authority, authority.as_ref())
            || authority
                .as_ref()
                .map(|authority| authority.expires_at <= (self.now)())
                .unwrap_or(true)
        {
            return Ok(Some(blocked(
                "This subagent authority expired or was revoked.",
            )));
        }
        let authority = authority.expect("checked");
        let expires_at = authority
            .expires_at
            .min((self.now)() + SUBAGENT_EGRESS_APPROVAL_WINDOW_MS);
        let ledger_input = PrepareSubagentApprovalV2Input {
            tree_root_id: authority.tree_root_id.clone(),
            run_id: authority.run_id.clone(),
            child_id: self.child_id.clone(),
            chat_id: authority.chat_id.clone(),
            workspace_id: authority.workspace_id.clone(),
            owner_document_id: authority.owner_document_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            authority_revision: authority.authority_revision,
            arguments: args.clone(),
            expires_at,
        };
        let prepared = self
            .ledger
            .prepare(&ledger_input, (self.now)(), &mut self.allocate_id);
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(_) => {
                return Ok(Some(blocked(
                    "This subagent action could not be prepared for approval.",
                )))
            }
        };
        let summary = subagent_outbound_approval_summary_v2(&binding, args);
        let summary = match summary {
            Ok(summary) => summary,
            Err(_) => {
                self.ledger.deny(&prepared.0, &authority.owner_document_id);
                return Ok(Some(blocked(
                    "This subagent action is too large to review safely.",
                )));
            }
        };
        let allowed = request_approval(tool_name, &summary);
        let allowed = allowed.unwrap_or_default();
        if !allowed {
            self.ledger.deny(&prepared.0, &authority.owner_document_id);
            return Ok(Some(blocked("The user denied this subagent action.")));
        }
        let live = current_authority(&authority.run_id);
        if !same_subagent_authority_binding_v2(&authority, live.as_ref())
            || live
                .map(|live| live.expires_at <= (self.now)())
                .unwrap_or(true)
        {
            self.ledger.deny(&prepared.0, &authority.owner_document_id);
            return Ok(Some(blocked(
                "This subagent authority changed after approval.",
            )));
        }
        if !self.ledger.authorize(
            &prepared.0,
            &authority.owner_document_id,
            &ledger_input,
            (self.now)(),
        ) {
            self.ledger.deny(&prepared.0, &authority.owner_document_id);
            return Ok(Some(blocked(
                "This subagent approval expired or no longer matches the action.",
            )));
        }
        self.authorized.insert(
            tool_call_id.to_string(),
            AuthorizedEntry {
                approval_id: prepared.0,
                expires_at,
                tool_name: tool_name.to_string(),
            },
        );
        Ok(None)
    }

    /// `consume` — one-shot consumption before dispatch.
    pub fn consume(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        args: &Value,
        current_authority: &dyn Fn(&str) -> Option<SubagentAuthorityV2>,
    ) -> Result<(), String> {
        let Some(pending) = self.authorized.remove(tool_call_id) else {
            return Err("This subagent action does not have a live one-shot approval.".to_string());
        };
        if pending.tool_name != tool_name {
            self.ledger
                .deny(&pending.approval_id, &self.authority.owner_document_id);
            return Err("This subagent action does not have a live one-shot approval.".to_string());
        }
        let authority = current_authority(&self.authority.run_id);
        let ledger_input = PrepareSubagentApprovalV2Input {
            tree_root_id: self.authority.tree_root_id.clone(),
            run_id: self.authority.run_id.clone(),
            child_id: self.child_id.clone(),
            chat_id: self.authority.chat_id.clone(),
            workspace_id: self.authority.workspace_id.clone(),
            owner_document_id: self.authority.owner_document_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            authority_revision: self.authority.authority_revision,
            arguments: args.clone(),
            expires_at: pending.expires_at,
        };
        if !same_subagent_authority_binding_v2(&self.authority, authority.as_ref())
            || authority
                .map(|authority| authority.expires_at <= (self.now)())
                .unwrap_or(true)
            || !self
                .ledger
                .consume(&pending.approval_id, &ledger_input, (self.now)())
        {
            self.ledger
                .deny(&pending.approval_id, &self.authority.owner_document_id);
            return Err(
                "This subagent approval expired, changed, was revoked, or was already used."
                    .to_string(),
            );
        }
        Ok(())
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
                    "web": true,
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
    fn outbound_summary_is_fixed_and_bounded() {
        let binding = SubagentOutboundToolBindingV2 {
            tool_name: "web_search".to_string(),
            kind: "web",
            mcp: None,
        };
        let summary = subagent_outbound_approval_summary_v2(
            &binding,
            &json!({ "query": "aiden agent", "numResults": 3 }),
        )
        .unwrap();
        assert!(summary.contains("Search the public web"));
        assert!(summary.contains("\"aiden agent\""));
        assert!(summary.contains("3"));
        // Oversized arguments fail closed.
        assert!(subagent_outbound_approval_summary_v2(
            &binding,
            &json!({ "query": "x".repeat(13_000) }),
        )
        .is_err());
    }

    #[test]
    fn same_binding_requires_exact_equality() {
        let authority = authority();
        assert!(same_subagent_authority_binding_v2(
            &authority,
            Some(&authority)
        ));
        let mut changed = authority.clone();
        changed.authority_revision += 1;
        assert!(!same_subagent_authority_binding_v2(
            &authority,
            Some(&changed)
        ));
        assert!(!same_subagent_authority_binding_v2(&authority, None));
    }

    #[test]
    fn gate_prepare_approve_consume_is_one_shot() {
        let authority = authority();
        let mut gate = SubagentOutboundApprovalGateV2::new(SubagentOutboundApprovalBrokerV2Input {
            authority: authority.clone(),
            child_id: "child-1".to_string(),
            tools: vec![SubagentOutboundToolBindingV2 {
                tool_name: "web_search".to_string(),
                kind: "web",
                mcp: None,
            }],
            ledger: SubagentApprovalLedgerV2::new(),
            current_authority: Box::new(move |run_id| {
                if run_id == "run-1" {
                    Some(authority.clone())
                } else {
                    None
                }
            }),
            request_approval: Box::new(|_, _| Ok(true)),
            now: Box::new(|| 1_000),
            allocate_id: Box::new(|| "approval-1".to_string()),
        })
        .unwrap();
        let current = gate.authority.clone();
        let blocked = gate
            .before_tool_call(
                "web_search",
                "call-1",
                &json!({ "query": "aiden" }),
                &|run_id| {
                    if run_id == "run-1" {
                        Some(current.clone())
                    } else {
                        None
                    }
                },
                &mut |_, _| Ok(true),
            )
            .unwrap();
        assert!(blocked.is_none());
        let current = gate.authority.clone();
        gate.consume(
            "call-1",
            "web_search",
            &json!({ "query": "aiden" }),
            &|run_id| {
                if run_id == "run-1" {
                    Some(current.clone())
                } else {
                    None
                }
            },
        )
        .unwrap();
        // Second consume fails.
        let current = gate.authority.clone();
        assert!(gate
            .consume(
                "call-1",
                "web_search",
                &json!({ "query": "aiden" }),
                &|run_id| if run_id == "run-1" {
                    Some(current.clone())
                } else {
                    None
                },
            )
            .is_err());
    }

    #[test]
    fn mcp_read_gate_retains_the_exact_binding_and_consumes_once() {
        let mut authority = authority();
        authority.capabilities.web = false;
        let tool = SubagentMcpToolScopeV2::Read(crate::authority::SubagentMcpReadToolScopeV2 {
            tool_name: "lookup".to_string(),
            schema_hash: "ab".repeat(32),
            effect: crate::authority::SubagentMcpEffectV2::Read,
        });
        authority.capabilities.mcp = vec![crate::authority::SubagentMcpScopeV2 {
            server_id: "docs".to_string(),
            connection_fingerprint: "cd".repeat(32),
            tools: vec![tool.clone()],
        }];
        let binding = SubagentOutboundToolBindingV2 {
            tool_name: "mcp_docs_lookup".to_string(),
            kind: "mcp",
            mcp: Some(SubagentOutboundMcpBinding {
                server_id: "docs".to_string(),
                connection_fingerprint: "cd".repeat(32),
                tool,
            }),
        };
        let mut gate = SubagentOutboundApprovalGateV2::new(SubagentOutboundApprovalBrokerV2Input {
            authority: authority.clone(),
            child_id: "child-1".to_string(),
            tools: vec![binding],
            ledger: SubagentApprovalLedgerV2::new(),
            current_authority: Box::new(|_| None),
            request_approval: Box::new(|_, _| Ok(true)),
            now: Box::new(|| 1_000),
            allocate_id: Box::new(|| "approval-mcp-1".to_string()),
        })
        .unwrap();

        let current = authority.clone();
        let mut summary = String::new();
        let blocked = gate
            .before_tool_call(
                "mcp_docs_lookup",
                "call-mcp-1",
                &json!({ "query": "Aiden" }),
                &|_| Some(current.clone()),
                &mut |_, value| {
                    summary = value.to_string();
                    Ok(true)
                },
            )
            .unwrap();
        assert!(blocked.is_none());
        assert!(summary.contains("docs:lookup"));

        let current = authority.clone();
        gate.consume(
            "call-mcp-1",
            "mcp_docs_lookup",
            &json!({ "query": "Aiden" }),
            &|_| Some(current.clone()),
        )
        .unwrap();
        assert!(gate
            .consume(
                "call-mcp-1",
                "mcp_docs_lookup",
                &json!({ "query": "Aiden" }),
                &|_| Some(authority.clone()),
            )
            .is_err());
    }

    #[test]
    fn gate_rejects_revoked_authority() {
        let authority = authority();
        let expired = {
            let mut expired = authority.clone();
            expired.expires_at = 500; // expired before `now` = 1_000
            expired
        };
        let gate_authority = authority.clone();
        let mut gate = SubagentOutboundApprovalGateV2::new(SubagentOutboundApprovalBrokerV2Input {
            authority: authority.clone(),
            child_id: "child-1".to_string(),
            tools: vec![SubagentOutboundToolBindingV2 {
                tool_name: "web_search".to_string(),
                kind: "web",
                mcp: None,
            }],
            ledger: SubagentApprovalLedgerV2::new(),
            current_authority: Box::new(move |_| Some(gate_authority.clone())),
            request_approval: Box::new(|_, _| Ok(true)),
            now: Box::new(|| 1_000),
            allocate_id: Box::new(|| "approval-1".to_string()),
        })
        .unwrap();
        // The live authority differs from the gate's frozen authority, so the
        // gate blocks before any approval prompt.
        let blocked = gate
            .before_tool_call(
                "web_search",
                "call-1",
                &json!({ "query": "aiden" }),
                &|_| Some(expired.clone()),
                &mut |_, _| Ok(true),
            )
            .unwrap();
        assert!(blocked.is_some());
    }
}
