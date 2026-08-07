//! Port of `main/services/subagents/subagent-nesting-core.ts` — the tree
//! identity/ceiling derivation (root + descendants), the tree budget ledger,
//! and the deployment scheduler. Descendants cannot widen any capability or
//! tool ceiling; every multi-child reservation is all-or-nothing.

use std::collections::{HashMap, HashSet};

use crate::authority::{
    parse_subagent_capability_set_v2, subagent_capabilities_are_subset_v2, SubagentCapabilitySetV2,
    SubagentContextModeV2, SubagentExecutionModeV2, MAX_SUBAGENT_TREE_DEPTH,
};
use crate::safe_text::is_safe_subagent_identifier_str;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeIdentityV2 {
    pub tree_root_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub depth: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeFixedCeilingV2 {
    pub workspace: SubagentTreeWorkspaceCeilingV2,
    pub runtime: SubagentTreeRuntimeCeilingV2,
    pub context: SubagentTreeContextCeilingV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeWorkspaceCeilingV2 {
    pub generation_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub workspace_revision: String,
    pub owner_document_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeRuntimeCeilingV2 {
    pub provider_fingerprint: String,
    pub model_fingerprint: String,
    pub execution: SubagentExecutionModeV2,
    pub thinking_level: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeContextCeilingV2 {
    pub mode: SubagentContextModeV2,
    pub revision: String,
    pub max_input_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeNodeV2 {
    pub identity: SubagentTreeIdentityV2,
    pub fixed_ceiling: SubagentTreeFixedCeilingV2,
    pub capabilities: SubagentCapabilitySetV2,
    pub tool_names: Vec<String>,
}

/// A minted node can only be created through `create_subagent_tree_root_v2` /
/// `create_subagent_tree_descendant_v2` (the WeakSet gate).
pub struct MintedSubagentTree {
    pub node: SubagentTreeNodeV2,
}

const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TOOL_NAME_MAX: usize = 128;

fn tree_identifier(value: &serde_json::Value, field: &str) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!("Invalid subagent tree {field}."));
    };
    if !is_safe_subagent_identifier_str(value) {
        return Err(format!("Invalid subagent tree {field}."));
    }
    Ok(value.to_string())
}

fn private_text(value: &serde_json::Value, field: &str) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!("Invalid subagent tree {field}."));
    };
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(format!("Invalid subagent tree {field}."));
    }
    Ok(value.to_string())
}

fn positive_integer(value: &serde_json::Value, maximum: u64, field: &str) -> Result<u64, String> {
    let Some(value) = value.as_u64() else {
        return Err(format!("Invalid subagent tree {field}."));
    };
    if value < 1 || value > maximum {
        return Err(format!("Invalid subagent tree {field}."));
    }
    Ok(value)
}

fn exact_keys(value: &serde_json::Value, keys: &[&str]) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent tree fields.".to_string());
    };
    if object.len() != keys.len() || object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("Invalid subagent tree fields.".to_string());
    }
    Ok(())
}

fn parse_fixed_ceiling(value: &serde_json::Value) -> Result<SubagentTreeFixedCeilingV2, String> {
    exact_keys(value, &["workspace", "runtime", "context"])?;
    let workspace = value.get("workspace").expect("key");
    exact_keys(
        workspace,
        &[
            "generationId",
            "chatId",
            "workspaceId",
            "workspaceRevision",
            "ownerDocumentId",
        ],
    )?;
    let runtime = value.get("runtime").expect("key");
    exact_keys(
        runtime,
        &[
            "providerFingerprint",
            "modelFingerprint",
            "execution",
            "thinkingLevel",
        ],
    )?;
    let context = value.get("context").expect("key");
    exact_keys(context, &["mode", "revision", "maxInputTokens"])?;
    let execution = match runtime.get("execution").and_then(serde_json::Value::as_str) {
        Some("foreground") => SubagentExecutionModeV2::Foreground,
        Some("background") => SubagentExecutionModeV2::Background,
        _ => return Err("Invalid subagent tree fixed ceiling.".to_string()),
    };
    let thinking_level = runtime
        .get("thinkingLevel")
        .and_then(serde_json::Value::as_str);
    if !thinking_level
        .map(|level| THINKING_LEVELS.contains(&level))
        .unwrap_or(false)
    {
        return Err("Invalid subagent tree fixed ceiling.".to_string());
    }
    let mode = match context.get("mode").and_then(serde_json::Value::as_str) {
        Some("fresh") => SubagentContextModeV2::Fresh,
        Some("fork") => SubagentContextModeV2::Fork,
        _ => return Err("Invalid subagent tree fixed ceiling.".to_string()),
    };
    Ok(SubagentTreeFixedCeilingV2 {
        workspace: SubagentTreeWorkspaceCeilingV2 {
            generation_id: tree_identifier(
                workspace.get("generationId").expect("key"),
                "generation identity",
            )?,
            chat_id: tree_identifier(workspace.get("chatId").expect("key"), "chat identity")?,
            workspace_id: tree_identifier(
                workspace.get("workspaceId").expect("key"),
                "workspace identity",
            )?,
            workspace_revision: private_text(
                workspace.get("workspaceRevision").expect("key"),
                "workspace revision",
            )?,
            owner_document_id: private_text(
                workspace.get("ownerDocumentId").expect("key"),
                "renderer owner",
            )?,
        },
        runtime: SubagentTreeRuntimeCeilingV2 {
            provider_fingerprint: private_text(
                runtime.get("providerFingerprint").expect("key"),
                "provider fingerprint",
            )?,
            model_fingerprint: private_text(
                runtime.get("modelFingerprint").expect("key"),
                "model fingerprint",
            )?,
            execution,
            thinking_level: thinking_level.expect("checked").to_string(),
        },
        context: SubagentTreeContextCeilingV2 {
            mode,
            revision: private_text(context.get("revision").expect("key"), "context revision")?,
            max_input_tokens: positive_integer(
                context.get("maxInputTokens").expect("key"),
                10_000_000,
                "context ceiling",
            )?,
        },
    })
}

fn safe_capability_snapshot(value: &serde_json::Value) -> Result<serde_json::Value, String> {
    exact_keys(
        value,
        &[
            "workspaceRead",
            "workspaceWrite",
            "shell",
            "web",
            "delegation",
            "mcp",
        ],
    )?;
    let mcp = value.get("mcp").expect("key");
    let Some(scopes) = mcp.as_array() else {
        return Err("Invalid subagent tree MCP ceiling.".to_string());
    };
    if scopes.len() > 16 {
        return Err("Invalid subagent tree MCP ceiling.".to_string());
    }
    let mut parsed_scopes = Vec::with_capacity(scopes.len());
    for scope in scopes {
        exact_keys(scope, &["serverId", "connectionFingerprint", "tools"])?;
        let Some(tools) = scope.get("tools").and_then(serde_json::Value::as_array) else {
            return Err("Invalid subagent tree MCP tool ceiling.".to_string());
        };
        if tools.len() > 32 {
            return Err("Invalid subagent tree MCP tool ceiling.".to_string());
        }
        let mut parsed_tools = Vec::with_capacity(tools.len());
        for tool in tools {
            if exact_keys(tool, &["toolName", "schemaHash", "effect"]).is_ok() {
                parsed_tools.push(tool.clone());
                continue;
            }
            exact_keys(tool, &["toolName", "schemaHash", "effect", "effectProfile"])?;
            let profile = tool.get("effectProfile").expect("key");
            exact_keys(
                profile,
                &[
                    "classification",
                    "destructive",
                    "idempotency",
                    "openWorld",
                    "taskSupport",
                    "fingerprint",
                ],
            )?;
            let mut tool = tool.clone();
            tool["effectProfile"] = profile.clone();
            parsed_tools.push(tool);
        }
        let mut scope = scope.clone();
        scope["tools"] = serde_json::Value::Array(parsed_tools);
        parsed_scopes.push(scope);
    }
    let mut snapshot = value.clone();
    snapshot["mcp"] = serde_json::Value::Array(parsed_scopes);
    Ok(snapshot)
}

fn freeze_capabilities(value: &serde_json::Value) -> Result<SubagentCapabilitySetV2, String> {
    let snapshot = safe_capability_snapshot(value)?;
    parse_subagent_capability_set_v2(&snapshot)
}

fn exact_tool_names(value: &serde_json::Value) -> Result<Vec<String>, String> {
    let Some(names) = value.as_array() else {
        return Err("Invalid subagent tree tool ceiling.".to_string());
    };
    if names.len() > 128 {
        return Err("Invalid subagent tree tool ceiling.".to_string());
    }
    let mut parsed = Vec::with_capacity(names.len());
    for name in names {
        let Some(name) = name.as_str() else {
            return Err("Invalid subagent tree tool ceiling.".to_string());
        };
        if name.is_empty()
            || name.len() > TOOL_NAME_MAX
            || !name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err("Invalid subagent tree tool ceiling.".to_string());
        }
        parsed.push(name.to_string());
    }
    let unique: HashSet<&String> = parsed.iter().collect();
    if unique.len() != parsed.len() {
        return Err("Invalid or duplicate subagent tree tool ceiling.".to_string());
    }
    Ok(parsed)
}

/// Exact depth-0 parent-generation record (`createSubagentTreeRootV2`). It is
/// control state, not a child authority.
pub fn create_subagent_tree_root_v2(
    value: &serde_json::Value,
) -> Result<MintedSubagentTree, String> {
    exact_keys(
        value,
        &[
            "treeRootId",
            "runId",
            "fixedCeiling",
            "capabilities",
            "toolNames",
        ],
    )?;
    let tree_root_id = tree_identifier(value.get("treeRootId").expect("key"), "root identity")?;
    let run_id = tree_identifier(value.get("runId").expect("key"), "root run identity")?;
    if tree_root_id != run_id {
        return Err("A subagent tree root must identify itself.".to_string());
    }
    Ok(MintedSubagentTree {
        node: SubagentTreeNodeV2 {
            identity: SubagentTreeIdentityV2 {
                tree_root_id,
                run_id,
                parent_run_id: None,
                depth: 0,
            },
            fixed_ceiling: parse_fixed_ceiling(value.get("fixedCeiling").expect("key"))?,
            capabilities: freeze_capabilities(value.get("capabilities").expect("key"))?,
            tool_names: exact_tool_names(value.get("toolNames").expect("key"))?,
        },
    })
}

/// Derive, rather than accept, lineage and fixed ceilings from the exact
/// parent (`createSubagentTreeDescendantV2`).
pub fn create_subagent_tree_descendant_v2(
    parent: &MintedSubagentTree,
    value: &serde_json::Value,
) -> Result<MintedSubagentTree, String> {
    exact_keys(value, &["runId", "capabilities", "toolNames"])?;
    let depth = parent.node.identity.depth + 1;
    if depth > MAX_SUBAGENT_TREE_DEPTH {
        return Err(format!(
            "Subagent nesting cannot exceed depth {MAX_SUBAGENT_TREE_DEPTH}."
        ));
    }
    let run_id = tree_identifier(value.get("runId").expect("key"), "run identity")?;
    if run_id == parent.node.identity.run_id || run_id == parent.node.identity.tree_root_id {
        return Err("A subagent tree descendant requires a fresh run identity.".to_string());
    }
    let capabilities = freeze_capabilities(value.get("capabilities").expect("key"))?;
    if !subagent_capabilities_are_subset_v2(&capabilities, &parent.node.capabilities) {
        return Err("A subagent tree descendant cannot widen its capability ceiling.".to_string());
    }
    let tool_names = exact_tool_names(value.get("toolNames").expect("key"))?;
    let parent_tools: HashSet<&String> = parent.node.tool_names.iter().collect();
    if tool_names.iter().any(|name| !parent_tools.contains(name)) {
        return Err("A subagent tree descendant cannot widen its tool ceiling.".to_string());
    }
    Ok(MintedSubagentTree {
        node: SubagentTreeNodeV2 {
            identity: SubagentTreeIdentityV2 {
                tree_root_id: parent.node.identity.tree_root_id.clone(),
                run_id,
                parent_run_id: if depth == 1 {
                    None
                } else {
                    Some(parent.node.identity.run_id.clone())
                },
                depth,
            },
            fixed_ceiling: parent.node.fixed_ceiling.clone(),
            capabilities,
            tool_names,
        },
    })
}

// ===========================================================================
// Budget ledger
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeBudgetLimitsV2 {
    pub max_depth: u8,
    pub max_launches: u64,
    pub max_active: u64,
    pub max_queued: u64,
    pub max_tokens: u64,
    pub max_tool_calls: u64,
    pub max_wall_time_ms: u64,
    pub max_output_chars: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeBudgetUsageV2 {
    pub tokens: u64,
    pub tool_calls: u64,
    pub output_chars: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeBudgetSnapshotV2 {
    pub launched: u64,
    pub active: u64,
    pub queued: u64,
    pub tokens: u64,
    pub tool_calls: u64,
    pub output_chars: u64,
    pub elapsed_wall_time_ms: u64,
    pub expired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTreeLaunchReservationV2 {
    pub sequence: u64,
    pub tree_root_id: String,
    pub parent_run_id: Option<String>,
    pub run_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerRunState {
    Queued,
    Active,
    Waiting,
    Terminal,
}

#[derive(Debug, Clone)]
struct LedgerRun {
    identity: SubagentTreeIdentityV2,
    state: LedgerRunState,
}

fn parse_budget_limits(value: &serde_json::Value) -> Result<SubagentTreeBudgetLimitsV2, String> {
    exact_keys(
        value,
        &[
            "maxDepth",
            "maxLaunches",
            "maxActive",
            "maxQueued",
            "maxTokens",
            "maxToolCalls",
            "maxWallTimeMs",
            "maxOutputChars",
        ],
    )?;
    Ok(SubagentTreeBudgetLimitsV2 {
        max_depth: positive_integer(
            value.get("maxDepth").expect("key"),
            MAX_SUBAGENT_TREE_DEPTH as u64,
            "depth budget",
        )? as u8,
        max_launches: positive_integer(
            value.get("maxLaunches").expect("key"),
            64,
            "launch budget",
        )?,
        max_active: positive_integer(value.get("maxActive").expect("key"), 32, "active budget")?,
        max_queued: positive_integer(value.get("maxQueued").expect("key"), 64, "queue budget")?,
        max_tokens: positive_integer(
            value.get("maxTokens").expect("key"),
            10_000_000,
            "token budget",
        )?,
        max_tool_calls: positive_integer(
            value.get("maxToolCalls").expect("key"),
            512,
            "tool-call budget",
        )?,
        max_wall_time_ms: positive_integer(
            value.get("maxWallTimeMs").expect("key"),
            24 * 60 * 60_000,
            "wall-time budget",
        )?,
        max_output_chars: positive_integer(
            value.get("maxOutputChars").expect("key"),
            1_000_000,
            "output budget",
        )?,
    })
}

fn parse_usage(value: &serde_json::Value) -> Result<SubagentTreeBudgetUsageV2, String> {
    exact_keys(value, &["tokens", "toolCalls", "outputChars"])?;
    let field = |key: &str| -> Result<u64, String> {
        let Some(value) = value.get(key).and_then(serde_json::Value::as_u64) else {
            return Err("Invalid subagent tree usage value.".to_string());
        };
        Ok(value)
    };
    Ok(SubagentTreeBudgetUsageV2 {
        tokens: field("tokens")?,
        tool_calls: field("toolCalls")?,
        output_chars: field("outputChars")?,
    })
}

/// One synchronous, tree-owned ledger. Every multi-child reservation is
/// all-or-nothing (`SubagentTreeBudgetLedgerV2`).
pub struct SubagentTreeBudgetLedgerV2 {
    pub tree_root_id: String,
    pub limits: SubagentTreeBudgetLimitsV2,
    created_at: u64,
    runs: HashMap<String, LedgerRun>,
    launched: u64,
    active: u64,
    queued: u64,
    tokens: u64,
    tool_calls: u64,
    output_chars: u64,
    reservation_sequence: u64,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl SubagentTreeBudgetLedgerV2 {
    pub fn new(
        tree_root_id: &str,
        limits: &serde_json::Value,
        clock: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Self, String> {
        if !is_safe_subagent_identifier_str(tree_root_id) {
            return Err("Invalid subagent tree budget root identity.".to_string());
        }
        let limits = parse_budget_limits(limits)?;
        let created_at = clock();
        Ok(SubagentTreeBudgetLedgerV2 {
            tree_root_id: tree_root_id.to_string(),
            limits,
            created_at,
            runs: HashMap::new(),
            launched: 0,
            active: 0,
            queued: 0,
            tokens: 0,
            tool_calls: 0,
            output_chars: 0,
            reservation_sequence: 0,
            clock,
        })
    }

    fn assert_live(&self) -> Result<(), String> {
        let now = (self.clock)();
        if now < self.created_at || now - self.created_at > self.limits.max_wall_time_ms {
            return Err("Subagent tree wall-time budget exhausted.".to_string());
        }
        Ok(())
    }

    fn validate_nodes(
        &self,
        nodes: &[&MintedSubagentTree],
        parent_run_id: Option<&str>,
        expected_depth: u8,
    ) -> Result<(), String> {
        if nodes.is_empty() || nodes.len() > 32 {
            return Err("A subagent tree reservation requires 1 to 32 descendants.".to_string());
        }
        let mut ids = HashSet::new();
        for node in nodes {
            let identity = &node.node.identity;
            if identity.tree_root_id != self.tree_root_id
                || identity.parent_run_id.as_deref() != parent_run_id
                || identity.depth != expected_depth
                || identity.depth > self.limits.max_depth
                || !ids.insert(identity.run_id.clone())
                || self.runs.contains_key(&identity.run_id)
            {
                return Err(
                    "Invalid, duplicate, or over-depth subagent tree reservation.".to_string(),
                );
            }
        }
        Ok(())
    }

    fn reservation(
        &mut self,
        nodes: &[&MintedSubagentTree],
        parent_run_id: Option<&str>,
    ) -> SubagentTreeLaunchReservationV2 {
        self.reservation_sequence += 1;
        SubagentTreeLaunchReservationV2 {
            sequence: self.reservation_sequence,
            tree_root_id: self.tree_root_id.clone(),
            parent_run_id: parent_run_id.map(str::to_string),
            run_ids: nodes
                .iter()
                .map(|node| node.node.identity.run_id.clone())
                .collect(),
        }
    }

    pub fn reserve_launches(
        &mut self,
        nodes: &[&MintedSubagentTree],
    ) -> Result<SubagentTreeLaunchReservationV2, String> {
        self.assert_live()?;
        self.validate_nodes(nodes, None, 1)?;
        if self.launched + nodes.len() as u64 > self.limits.max_launches {
            return Err("Subagent tree launch budget exhausted.".to_string());
        }
        if self.queued + nodes.len() as u64 > self.limits.max_queued {
            return Err("Subagent tree queue budget exhausted.".to_string());
        }
        for node in nodes {
            self.runs.insert(
                node.node.identity.run_id.clone(),
                LedgerRun {
                    identity: node.node.identity.clone(),
                    state: LedgerRunState::Queued,
                },
            );
        }
        self.launched += nodes.len() as u64;
        self.queued += nodes.len() as u64;
        Ok(self.reservation(nodes, None))
    }

    pub fn reserve_descendants_and_suspend_parent(
        &mut self,
        parent_run_id: &str,
        nodes: &[&MintedSubagentTree],
    ) -> Result<SubagentTreeLaunchReservationV2, String> {
        self.assert_live()?;
        let Some(parent) = self.runs.get(parent_run_id) else {
            return Err("Only an active subagent may reserve descendants.".to_string());
        };
        if parent.state != LedgerRunState::Active {
            return Err("Only an active subagent may reserve descendants.".to_string());
        }
        self.validate_nodes(nodes, Some(parent_run_id), parent.identity.depth + 1)?;
        if self.launched + nodes.len() as u64 > self.limits.max_launches {
            return Err("Subagent tree launch budget exhausted.".to_string());
        }
        if self.queued + nodes.len() as u64 + 1 > self.limits.max_queued {
            return Err("Subagent tree queue budget exhausted.".to_string());
        }
        let parent = self.runs.get_mut(parent_run_id).expect("checked");
        parent.state = LedgerRunState::Waiting;
        self.active -= 1;
        self.queued += nodes.len() as u64 + 1;
        self.launched += nodes.len() as u64;
        for node in nodes {
            self.runs.insert(
                node.node.identity.run_id.clone(),
                LedgerRun {
                    identity: node.node.identity.clone(),
                    state: LedgerRunState::Queued,
                },
            );
        }
        Ok(self.reservation(nodes, Some(parent_run_id)))
    }

    pub fn activate(&mut self, run_id: &str) -> Result<(), String> {
        self.assert_live()?;
        let Some(run) = self.runs.get(run_id) else {
            return Err("Subagent tree run is not queued for activation.".to_string());
        };
        if !matches!(run.state, LedgerRunState::Queued | LedgerRunState::Waiting) {
            return Err("Subagent tree run is not queued for activation.".to_string());
        }
        if self.active >= self.limits.max_active {
            return Err("Subagent tree active budget exhausted.".to_string());
        }
        let run = self.runs.get_mut(run_id).expect("checked");
        run.state = LedgerRunState::Active;
        self.queued -= 1;
        self.active += 1;
        Ok(())
    }

    pub fn finish(&mut self, run_id: &str) {
        let Some(run) = self.runs.get_mut(run_id) else {
            return;
        };
        if run.state == LedgerRunState::Terminal {
            return;
        }
        if run.state == LedgerRunState::Active {
            self.active -= 1;
        } else {
            self.queued -= 1;
        }
        run.state = LedgerRunState::Terminal;
    }

    pub fn consume_usage(&mut self, value: &serde_json::Value) -> Result<(), String> {
        self.assert_live()?;
        let usage = parse_usage(value)?;
        let tokens = self.tokens + usage.tokens;
        let tool_calls = self.tool_calls + usage.tool_calls;
        let output_chars = self.output_chars + usage.output_chars;
        if tokens > self.limits.max_tokens
            || tool_calls > self.limits.max_tool_calls
            || output_chars > self.limits.max_output_chars
        {
            return Err("Subagent tree token, tool-call, or output budget exhausted.".to_string());
        }
        self.tokens = tokens;
        self.tool_calls = tool_calls;
        self.output_chars = output_chars;
        Ok(())
    }

    pub fn state_of(&self, run_id: &str) -> Option<LedgerRunState> {
        self.runs.get(run_id).map(|run| run.state)
    }

    pub fn snapshot(&self) -> SubagentTreeBudgetSnapshotV2 {
        let now = (self.clock)();
        let elapsed = now.saturating_sub(self.created_at);
        SubagentTreeBudgetSnapshotV2 {
            launched: self.launched,
            active: self.active,
            queued: self.queued,
            tokens: self.tokens,
            tool_calls: self.tool_calls,
            output_chars: self.output_chars,
            elapsed_wall_time_ms: elapsed,
            expired: now < self.created_at || elapsed > self.limits.max_wall_time_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capabilities() -> serde_json::Value {
        json!({
            "workspaceRead": true,
            "workspaceWrite": false,
            "shell": false,
            "web": false,
            "delegation": false,
            "mcp": [],
        })
    }

    fn root() -> MintedSubagentTree {
        create_subagent_tree_root_v2(&json!({
            "treeRootId": "tree-1",
            "runId": "tree-1",
            "fixedCeiling": {
                "workspace": {
                    "generationId": "generation-1",
                    "chatId": "chat-1",
                    "workspaceId": "workspace-1",
                    "workspaceRevision": "workspace-revision-1",
                    "ownerDocumentId": "document-1",
                },
                "runtime": {
                    "providerFingerprint": "provider-fingerprint",
                    "modelFingerprint": "model-fingerprint",
                    "execution": "foreground",
                    "thinkingLevel": "high",
                },
                "context": {
                    "mode": "fresh",
                    "revision": "context-revision",
                    "maxInputTokens": 100_000,
                },
            },
            "capabilities": capabilities(),
            "toolNames": ["read_file", "list_dir", "glob", "grep"],
        }))
        .unwrap()
    }

    fn child(parent: &MintedSubagentTree, run_id: &str, tool_names: &[&str]) -> MintedSubagentTree {
        create_subagent_tree_descendant_v2(
            parent,
            &json!({
                "runId": run_id,
                "capabilities": capabilities(),
                "toolNames": tool_names,
            }),
        )
        .unwrap()
    }

    fn limits() -> serde_json::Value {
        json!({
            "maxDepth": 2,
            "maxLaunches": 4,
            "maxActive": 2,
            "maxQueued": 4,
            "maxTokens": 100_000,
            "maxToolCalls": 64,
            "maxWallTimeMs": 60_000,
            "maxOutputChars": 120_000,
        })
    }

    #[test]
    fn root_must_identify_itself() {
        let mut value = json!({
            "treeRootId": "tree-1",
            "runId": "tree-2",
            "fixedCeiling": {},
            "capabilities": capabilities(),
            "toolNames": [],
        });
        // Provide a valid fixed ceiling so only identity fails.
        value["fixedCeiling"] = root_value_fixed_ceiling();
        assert!(create_subagent_tree_root_v2(&value).is_err());
    }

    fn root_value_fixed_ceiling() -> serde_json::Value {
        json!({
            "workspace": {
                "generationId": "generation-1",
                "chatId": "chat-1",
                "workspaceId": "workspace-1",
                "workspaceRevision": "workspace-revision-1",
                "ownerDocumentId": "document-1",
            },
            "runtime": {
                "providerFingerprint": "provider-fingerprint",
                "modelFingerprint": "model-fingerprint",
                "execution": "foreground",
                "thinkingLevel": "high",
            },
            "context": {
                "mode": "fresh",
                "revision": "context-revision",
                "maxInputTokens": 100_000,
            },
        })
    }

    #[test]
    fn descendants_cannot_widen_ceilings_or_exceed_depth() {
        let root = root();
        let child_node = child(&root, "run-1", &["read_file", "grep"]);
        assert_eq!(child_node.node.identity.depth, 1);
        assert_eq!(child_node.node.identity.parent_run_id, None);
        // Widen tool ceiling.
        assert!(create_subagent_tree_descendant_v2(
            &root,
            &json!({
                "runId": "run-2",
                "capabilities": capabilities(),
                "toolNames": ["read_file", "write_file"],
            }),
        )
        .is_err());
        // Depth-2 works; depth-3 fails.
        let grandchild = child(&child_node, "run-2", &["read_file"]);
        assert_eq!(grandchild.node.identity.depth, 2);
        assert_eq!(
            grandchild.node.identity.parent_run_id.as_deref(),
            Some("run-1")
        );
        assert!(create_subagent_tree_descendant_v2(
            &grandchild,
            &json!({
                "runId": "run-3",
                "capabilities": capabilities(),
                "toolNames": ["read_file"],
            }),
        )
        .is_err());
        // Fresh identity required.
        assert!(create_subagent_tree_descendant_v2(
            &root,
            &json!({
                "runId": "tree-1",
                "capabilities": capabilities(),
                "toolNames": ["read_file"],
            }),
        )
        .is_err());
    }

    #[test]
    fn ledger_reserves_all_or_nothing_and_tracks_usage() {
        let root = root();
        let children: Vec<MintedSubagentTree> = vec![
            child(&root, "run-1", &["read_file"]),
            child(&root, "run-2", &["read_file"]),
        ];
        let mut ledger =
            SubagentTreeBudgetLedgerV2::new("tree-1", &limits(), Box::new(|| 0)).unwrap();
        let child_refs: Vec<&MintedSubagentTree> = children.iter().collect();
        let reservation = ledger.reserve_launches(&child_refs).unwrap();
        assert_eq!(reservation.run_ids.len(), 2);
        ledger.activate("run-1").unwrap();
        assert_eq!(ledger.state_of("run-1"), Some(LedgerRunState::Active));
        // Activating a second exceeds maxActive=2 only at 2; ok.
        ledger.activate("run-2").unwrap();
        assert!(ledger.activate("run-1").is_err());
        ledger.finish("run-1");
        assert_eq!(ledger.state_of("run-1"), Some(LedgerRunState::Terminal));
        // Usage caps.
        ledger
            .consume_usage(&json!({ "tokens": 50_000, "toolCalls": 30, "outputChars": 1_000 }))
            .unwrap();
        assert!(ledger
            .consume_usage(&json!({ "tokens": 60_000, "toolCalls": 0, "outputChars": 0 }))
            .is_err());
        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.launched, 2);
        assert_eq!(snapshot.tokens, 50_000);
    }

    #[test]
    fn nested_reservation_suspends_the_parent() {
        let root = root();
        let parent = child(&root, "run-1", &["read_file"]);
        let grandchild = child(&parent, "run-2", &["read_file"]);
        let mut ledger =
            SubagentTreeBudgetLedgerV2::new("tree-1", &limits(), Box::new(|| 0)).unwrap();
        ledger.reserve_launches(&[&parent]).unwrap();
        ledger.activate("run-1").unwrap();
        ledger
            .reserve_descendants_and_suspend_parent("run-1", &[&grandchild])
            .unwrap();
        assert_eq!(ledger.state_of("run-1"), Some(LedgerRunState::Waiting));
        // A waiting parent cannot reserve again.
        assert!(ledger
            .reserve_descendants_and_suspend_parent("run-1", &[&grandchild])
            .is_err());
    }
}
