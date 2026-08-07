//! MCP tool inventory (port of `main/services/subagents/subagent-mcp-inventory-core.ts`
//! plus the namespaced agent-tool projection of `mcp.ts`).
//!
//! Three pieces:
//!
//! - **Snapshots + diffs** — [`ToolInventorySnapshot`] / [`InventoryDiff`] for
//!   per-server namespaced tool sets (aligned with the `aiden-core::ToolDef`
//!   shape: `name` + `description` + raw JSON Schema `parameters`).
//! - **`SubagentMcpInventoryCache`** — exact credential-aware cache with
//!   exponential failure backoff.
//! - **`resolve_bounded_subagent_mcp_inventory`** — one aggregate discovery
//!   deadline for configuration loading + per-server inspection, stdio
//!   servers skipped, partial success kept.

use std::collections::{HashMap, VecDeque};

use aiden_data::portable_config::{McpServer, McpTransport};
use futures::future::BoxFuture;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::config::{credential_connection_snapshot, runtime_connection_snapshot};
use crate::error::{McpError, McpReadError, McpReadErrorCode};
use crate::identity::{is_safe_subagent_identifier, mcp_agent_tool_name};

// ===========================================================================
// Constants (subagent-mcp-read.ts / subagent-mcp-inventory-core.ts)
// ===========================================================================

pub const SUBAGENT_MCP_DISCOVERY_DEADLINE_MS: u64 = 3_000;
pub const SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS: u64 = 5 * 60_000;
pub const SUBAGENT_MCP_FAILURE_BACKOFF_INITIAL_MS: u64 = 30_000;
pub const MAX_SUBAGENT_MCP_SCOPES: usize = 16;
pub const MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE: usize = 32;
pub const MAX_SUBAGENT_MCP_INVENTORY_TOOLS: usize = 256;
pub const MAX_SUBAGENT_MCP_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_CACHE_ENTRIES: usize = 32;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 16_384;

// ===========================================================================
// Raw tool record + snapshots
// ===========================================================================

/// One remote MCP tool as reported by `tools/list`.
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    /// Raw JSON Schema (TS `Type.Unsafe(inputSchema)` escape hatch).
    pub input_schema: serde_json::Value,
    pub output_schema: Option<serde_json::Value>,
    /// Only an explicit, non-conflicting MCP read-only hint qualifies for the
    /// read-only lane.
    pub annotations: Option<serde_json::Value>,
}

impl McpToolInfo {
    /// The agent-facing tool definition for a namespaced tool.
    pub fn to_tool_def(&self, server: &McpServer, label: &str) -> crate::McpAgentTool {
        crate::McpAgentTool {
            name: mcp_agent_tool_name(&server.id, &server.name, &self.name),
            label: label.to_string(),
            description: self
                .description
                .clone()
                .unwrap_or_else(|| self.name.clone()),
            parameters: normalize_input_schema(&self.input_schema),
        }
    }
}

/// Fall back to `{type: "object", properties: {}}` when a server omits the
/// input schema (TS `(t.inputSchema as object) ?? {type:"object",...}`).
pub fn normalize_input_schema(input: &serde_json::Value) -> serde_json::Value {
    if input.is_object() {
        input.clone()
    } else {
        serde_json::json!({ "type": "object", "properties": {} })
    }
}

/// A namespaced agent tool for one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespacedMcpTool {
    /// `mcp_agent_tool_name(server, tool)` — the model-facing dispatch name.
    pub agent_name: String,
    /// The raw remote tool name (label).
    pub label: String,
}

/// One server's tool set at a point in time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolInventorySnapshot {
    pub server_id: String,
    pub tools: Vec<NamespacedMcpTool>,
    pub captured_at: u64,
}

/// Added/removed agent tool names between two snapshots of the same server.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InventoryDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// `diff_inventories` — set difference on agent tool names (order-insensitive,
/// deterministic output).
pub fn diff_inventories(
    previous: &ToolInventorySnapshot,
    next: &ToolInventorySnapshot,
) -> InventoryDiff {
    let before: std::collections::HashSet<&str> = previous
        .tools
        .iter()
        .map(|tool| tool.agent_name.as_str())
        .collect();
    let after: std::collections::HashSet<&str> = next
        .tools
        .iter()
        .map(|tool| tool.agent_name.as_str())
        .collect();
    let mut added: Vec<String> = after
        .difference(&before)
        .map(|name| (*name).to_string())
        .collect();
    let mut removed: Vec<String> = before
        .difference(&after)
        .map(|name| (*name).to_string())
        .collect();
    added.sort();
    removed.sort();
    InventoryDiff { added, removed }
}

// ===========================================================================
// Connection fingerprint (subagent-mcp-read.ts)
// ===========================================================================

/// sha256 over the canonical (sorted-key) runtime connection snapshot and the
/// credential revision — the identity authority for approved scopes.
pub fn subagent_mcp_connection_fingerprint(
    server: &McpServer,
    credential_revision: &str,
) -> Result<String, McpReadError> {
    if !is_exact_hash(credential_revision) {
        return Err(McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP credential revision was invalid.",
        ));
    }
    let snapshot = runtime_connection_snapshot(server);
    let mut hasher = Sha256::new();
    hasher.update(canonical_json(&snapshot, MAX_SUBAGENT_MCP_SCHEMA_BYTES)?.as_bytes());
    hasher.update(b"\0");
    hasher.update(credential_revision.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

/// The credential-revision part of the fingerprint input (TS
/// `mcpCredentialConnectionSnapshot`, `env`/`headers` reduced to hashes).
pub fn credential_revision_input(server: &McpServer) -> String {
    canonical_json(
        &credential_connection_snapshot(server),
        MAX_SUBAGENT_MCP_SCHEMA_BYTES,
    )
    .unwrap_or_default()
}

fn is_exact_hash(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

// ===========================================================================
// Canonical JSON (subagent-mcp-read.ts canonicalJson)
// ===========================================================================

/// Sort-key canonical JSON with depth/node limits. Mirrors
/// `canonicalJsonValue` (rejects non-finite numbers, enforces byte limits).
pub fn canonical_json(
    value: &serde_json::Value,
    maximum_bytes: usize,
) -> Result<String, McpReadError> {
    let mut state = JsonState { nodes: 0 };
    let canonical = canonical_value(value, &mut state, 0).map_err(|_| {
        McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP data exceeded structural limits.",
        )
    })?;
    let text = serde_json::to_string(&canonical).map_err(|_| {
        McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP data was not valid JSON.",
        )
    })?;
    if text.len() > maximum_bytes {
        return Err(McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP data exceeded its byte limit.",
        ));
    }
    Ok(text)
}

struct JsonState {
    nodes: usize,
}

fn canonical_value(
    value: &serde_json::Value,
    state: &mut JsonState,
    depth: usize,
) -> Result<serde_json::Value, ()> {
    state.nodes += 1;
    if depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES {
        return Err(());
    }
    match value {
        serde_json::Value::Null => Ok(serde_json::Value::Null),
        serde_json::Value::Bool(_) => Ok(value.clone()),
        serde_json::Value::Number(number) => {
            if number.as_f64().is_some_and(|value| value.is_finite()) {
                Ok(value.clone())
            } else {
                Err(())
            }
        }
        serde_json::Value::String(_) => Ok(value.clone()),
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| canonical_value(item, state, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(serde_json::Value::Array),
        serde_json::Value::Object(entries) => {
            let mut canonical = serde_json::Map::new();
            for (key, entry) in entries {
                if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
                    return Err(());
                }
                canonical.insert(key.clone(), canonical_value(entry, state, depth + 1)?);
            }
            Ok(serde_json::Value::Object(canonical))
        }
    }
}

// ===========================================================================
// Normalized inventory (normalizeSubagentMcpInventoryV2 subset)
// ===========================================================================

/// Classification of a remote tool for the read-only subagent lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolEffect {
    Read,
    /// Unknown/absent/malformed/conflicting hints fail closed as mutating.
    Mutating,
}

/// A normalized inventory entry: identity + schema hash + effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedSubagentMcpTool {
    pub tool_name: String,
    pub schema_hash: String,
    pub effect: McpToolEffect,
}

/// One inspected server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedSubagentMcpServer {
    pub server_id: String,
    pub connection_fingerprint: String,
    pub tools: Vec<InspectedSubagentMcpTool>,
}

/// Approved-scope projection (`SubagentMcpScopeV2`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentMcpScope {
    pub server_id: String,
    pub connection_fingerprint: String,
    pub tools: Vec<InspectedSubagentMcpTool>,
}

/// `classifySubagentMcpToolEffect` — only an explicit, non-conflicting
/// `readOnlyHint: true` (with `destructiveHint !== true`) is read-only.
pub fn classify_subagent_mcp_tool_effect(annotations: Option<&serde_json::Value>) -> McpToolEffect {
    let Some(annotations) = annotations else {
        return McpToolEffect::Mutating;
    };
    let Some(record) = annotations.as_object() else {
        return McpToolEffect::Mutating;
    };
    let hint = |key: &str| record.get(key).and_then(serde_json::Value::as_bool);
    let read_only = hint("readOnlyHint");
    if read_only != Some(true) {
        return McpToolEffect::Mutating;
    }
    if record.contains_key("destructiveHint") && hint("destructiveHint") != Some(false) {
        return McpToolEffect::Mutating;
    }
    McpToolEffect::Read
}

/// Normalize a remote tool inventory: validate identities, classify effects,
/// and compute the schema hash over canonical input + output schemas (TS
/// `normalizeSubagentMcpInventoryV2` + `schemaFor`).
pub fn normalize_subagent_mcp_inventory(
    tools: &[McpToolInfo],
    redact_credential_text: &dyn Fn(&str) -> String,
) -> Result<Vec<InspectedSubagentMcpTool>, McpReadError> {
    if tools.len() > MAX_SUBAGENT_MCP_INVENTORY_TOOLS {
        return Err(McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP tool inventory exceeded its limit.",
        ));
    }
    let mut names = std::collections::HashSet::new();
    let mut result = Vec::new();
    for tool in tools {
        if !is_safe_subagent_identifier(&tool.name)
            || redact_credential_text(&tool.name) != tool.name
        {
            return Err(McpReadError::new(
                McpReadErrorCode::InvalidBinding,
                "MCP tool inventory was invalid.",
            ));
        }
        if !names.insert(tool.name.clone()) {
            return Err(McpReadError::new(
                McpReadErrorCode::InvalidBinding,
                "MCP tool inventory was invalid.",
            ));
        }
        let effect = classify_subagent_mcp_tool_effect(tool.annotations.as_ref());
        if effect == McpToolEffect::Mutating {
            // The mutating lane is out of scope for the read-only inventory
            // (TS `classifySubagentMcpToolV2` returns undefined for
            // `taskSupport: "required"`; effect profiles land in a later
            // phase). Mutating tools are still recorded so the scope carries
            // the full tool surface.
        }
        let input = if tool.input_schema.is_object() {
            &tool.input_schema
        } else {
            &serde_json::json!({ "type": "object", "properties": {} })
        };
        if !input.is_object() {
            return Err(McpReadError::new(
                McpReadErrorCode::InvalidBinding,
                "MCP tool schema was invalid.",
            ));
        }
        let canonical_input = canonical_schema(input, redact_credential_text)?;
        let canonical_output = canonical_schema(
            tool.output_schema
                .as_ref()
                .unwrap_or(&serde_json::Value::Null),
            redact_credential_text,
        )?;
        if canonical_input.len() + canonical_output.len() > MAX_SUBAGENT_MCP_SCHEMA_BYTES {
            return Err(McpReadError::new(
                McpReadErrorCode::InvalidBinding,
                "MCP tool schema exceeded its byte limit.",
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(canonical_input.as_bytes());
        hasher.update(b"\0");
        hasher.update(canonical_output.as_bytes());
        result.push(InspectedSubagentMcpTool {
            tool_name: tool.name.clone(),
            schema_hash: format!("{:x}", hasher.finalize()),
            effect,
        });
    }
    Ok(result)
}

/// Structural-schema projection (TS `projectStructuralSchema`): keep only the
/// spec's structural keys, reject credential material anywhere, and reject
/// unsafe property identities.
fn canonical_schema(
    value: &serde_json::Value,
    redact: &dyn Fn(&str) -> String,
) -> Result<String, McpReadError> {
    let projected = project_structural_schema(value, redact, None).map_err(|_| {
        McpReadError::new(
            McpReadErrorCode::InvalidBinding,
            "MCP tool schema was invalid.",
        )
    })?;
    canonical_json(&projected, MAX_SUBAGENT_MCP_SCHEMA_BYTES)
}

fn project_structural_schema(
    value: &serde_json::Value,
    redact: &dyn Fn(&str) -> String,
    parent_key: Option<&str>,
) -> Result<serde_json::Value, ()> {
    match value {
        serde_json::Value::String(text) => {
            if redact(text) != *text {
                return Err(());
            }
            Ok(value.clone())
        }
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| project_structural_schema(item, redact, parent_key))
            .collect::<Result<Vec<_>, _>>()
            .map(serde_json::Value::Array),
        serde_json::Value::Object(entries) => {
            if parent_key == Some("properties") {
                let mut projected = serde_json::Map::new();
                for (key, entry) in entries {
                    if !is_safe_subagent_identifier(key) || redact(key) != *key {
                        return Err(());
                    }
                    projected.insert(key.clone(), project_structural_schema(entry, redact, None)?);
                }
                return Ok(serde_json::Value::Object(projected));
            }
            const STRUCTURAL_SCHEMA_KEYS: &[&str] = &[
                "type",
                "properties",
                "required",
                "additionalProperties",
                "items",
                "minItems",
                "maxItems",
                "uniqueItems",
                "minLength",
                "maxLength",
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
                "minProperties",
                "maxProperties",
                "enum",
                "const",
                "oneOf",
                "anyOf",
                "allOf",
                "not",
            ];
            let mut projected = serde_json::Map::new();
            for (key, entry) in entries {
                if redact(key) != *key {
                    return Err(());
                }
                if !STRUCTURAL_SCHEMA_KEYS.contains(&key.as_str()) {
                    continue;
                }
                if key == "required" {
                    let Some(required) = entry.as_array() else {
                        return Err(());
                    };
                    for candidate in required {
                        let Some(name) = candidate.as_str() else {
                            return Err(());
                        };
                        if !is_safe_subagent_identifier(name) || redact(name) != *name {
                            return Err(());
                        }
                    }
                    projected.insert(key.clone(), entry.clone());
                    continue;
                }
                projected.insert(
                    key.clone(),
                    project_structural_schema(entry, redact, Some(key.as_str()))?,
                );
            }
            Ok(serde_json::Value::Object(projected))
        }
        _ => Ok(value.clone()),
    }
}

// ===========================================================================
// Inventory cache (SubagentMcpInventoryCache)
// ===========================================================================

enum CacheEntry {
    /// A successful inspection, keyed to its fingerprint.
    Hit {
        fingerprint: String,
        expires_at: u64,
        inspected: InspectedSubagentMcpServer,
    },
    /// A recorded failure; retained past expiry so the next attempt advances
    /// exponential backoff (TS retains expired failure metadata).
    Failure {
        fingerprint: String,
        expires_at: u64,
        failures: u32,
    },
}

/// A `get` result: no entry, a negative (failure) marker, or an inspected
/// server.
#[derive(Debug, Clone, PartialEq)]
pub enum CacheLookup {
    Miss,
    Negative,
    Hit(InspectedSubagentMcpServer),
}

/// Credential-aware inventory cache with exponential failure backoff.
pub struct SubagentMcpInventoryCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
}

impl Default for SubagentMcpInventoryCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentMcpInventoryCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn get(&mut self, server_id: &str, fingerprint: &str, now: u64) -> CacheLookup {
        let Some(entry) = self.entries.remove(server_id) else {
            return CacheLookup::Miss;
        };
        match entry {
            CacheEntry::Hit {
                fingerprint: cached_fingerprint,
                expires_at,
                inspected,
            } => {
                if cached_fingerprint != fingerprint {
                    self.order.retain(|id| id != server_id);
                    return CacheLookup::Miss;
                }
                if expires_at <= now {
                    return CacheLookup::Miss;
                }
                self.entries.insert(
                    server_id.to_string(),
                    CacheEntry::Hit {
                        fingerprint: cached_fingerprint,
                        expires_at,
                        inspected: inspected.clone(),
                    },
                );
                CacheLookup::Hit(inspected)
            }
            CacheEntry::Failure {
                fingerprint: cached_fingerprint,
                expires_at,
                failures,
            } => {
                if cached_fingerprint != fingerprint {
                    self.order.retain(|id| id != server_id);
                    return CacheLookup::Miss;
                }
                if expires_at <= now {
                    // Expired failures stay in the map to advance backoff but
                    // report a miss to callers.
                    self.entries.insert(
                        server_id.to_string(),
                        CacheEntry::Failure {
                            fingerprint: cached_fingerprint,
                            expires_at,
                            failures,
                        },
                    );
                    self.order.push_back(server_id.to_string());
                    return CacheLookup::Miss;
                }
                self.entries.insert(
                    server_id.to_string(),
                    CacheEntry::Failure {
                        fingerprint: cached_fingerprint,
                        expires_at,
                        failures,
                    },
                );
                self.order.push_back(server_id.to_string());
                CacheLookup::Negative
            }
        }
    }

    pub fn set(&mut self, inspected: &InspectedSubagentMcpServer, now: u64, ttl_ms: Option<u64>) {
        self.entries.remove(&inspected.server_id);
        self.order.retain(|id| id != &inspected.server_id);
        self.evict_if_needed();
        self.entries.insert(
            inspected.server_id.clone(),
            CacheEntry::Hit {
                fingerprint: inspected.connection_fingerprint.clone(),
                expires_at: now + ttl_ms.unwrap_or(SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS),
                inspected: inspected.clone(),
            },
        );
        self.order.push_back(inspected.server_id.clone());
    }

    pub fn set_failure(&mut self, server_id: &str, fingerprint: &str, now: u64) {
        let failures = match self.entries.get(server_id) {
            Some(CacheEntry::Failure {
                fingerprint: cached,
                failures,
                ..
            }) if cached == fingerprint => failures + 1,
            _ => 1,
        };
        let backoff = (SUBAGENT_MCP_FAILURE_BACKOFF_INITIAL_MS as u128 * 2u128.pow(failures - 1))
            .min(SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS as u128) as u64;
        self.entries.remove(server_id);
        self.order.retain(|id| id != server_id);
        self.evict_if_needed();
        self.entries.insert(
            server_id.to_string(),
            CacheEntry::Failure {
                fingerprint: fingerprint.to_string(),
                expires_at: now + backoff,
                failures,
            },
        );
        self.order.push_back(server_id.to_string());
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    fn evict_if_needed(&mut self) {
        while self.entries.len() >= MAX_CACHE_ENTRIES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if self.entries.remove(&oldest).is_some() {
                break;
            }
        }
    }
}

// ===========================================================================
// Bounded discovery (resolveBoundedSubagentMcpInventory)
// ===========================================================================

/// The read-only client port subagent discovery drives.
pub trait SubagentMcpClientPort: Send + Sync {
    fn credential_revision(&self) -> &str;
    fn credential_revision_is_current(&self, cancel: &CancellationToken) -> BoxFuture<'_, bool>;
    fn redact_credential_text(&self, text: &str) -> String;
    fn list_tools(
        &self,
        cancel: &CancellationToken,
    ) -> BoxFuture<'_, Result<Vec<McpToolInfo>, McpError>>;
}

/// One bounded inspection of a fresh client: receives the client port and
/// returns the inspected server. The returned future borrows the port for the
/// duration of the inspection.
pub type InspectionOperation = Box<
    dyn for<'a> FnOnce(
            &'a dyn SubagentMcpClientPort,
        ) -> BoxFuture<'a, Result<InspectedSubagentMcpServer, McpError>>
        + Send,
>;

/// The cache is shared across the concurrent per-server inspections.
pub type SharedInventoryCache = std::sync::Arc<std::sync::Mutex<SubagentMcpInventoryCache>>;

/// Lists the configured servers (the config-store read).
pub type ListServersFn = Box<dyn Fn() -> BoxFuture<'static, Vec<McpServer>> + Send + Sync>;
/// Runs a bounded operation against a freshly resolved client for one server.
pub type WithClientFn = Box<
    dyn Fn(
            McpServer,
            CancellationToken,
            InspectionOperation,
        ) -> BoxFuture<'static, Result<InspectedSubagentMcpServer, McpError>>
        + Send
        + Sync,
>;
/// Resolves the non-secret credential revision for a server.
pub type ResolveCredentialRevisionFn =
    Box<dyn Fn(&McpServer, CancellationToken) -> BoxFuture<'static, String> + Send + Sync>;
/// Wall-clock now in milliseconds.
pub type NowFn = Box<dyn Fn() -> u64 + Send + Sync>;

/// `SubagentMcpInventoryCoreDependencies`.
pub struct SubagentMcpInventoryDependencies {
    pub list_servers: ListServersFn,
    pub with_client: WithClientFn,
    pub resolve_credential_revision: ResolveCredentialRevisionFn,
    pub cache: SharedInventoryCache,
    pub now: NowFn,
    pub discovery_deadline_ms: Option<u64>,
}

/// The bounded-discovery entry point (TS `resolveBoundedSubagentMcpInventory`):
/// configuration loading and every per-server inspection share one aggregate
/// deadline; stdio servers are never inspected; completed servers are returned
/// even when others exceed the deadline.
pub async fn resolve_bounded_subagent_mcp_inventory(
    parent_signal: CancellationToken,
    dependencies: &SubagentMcpInventoryDependencies,
) -> Result<Vec<SubagentMcpScope>, McpError> {
    if parent_signal.is_cancelled() {
        return Err(McpError::Cancelled);
    }
    let deadline_ms = dependencies
        .discovery_deadline_ms
        .unwrap_or(SUBAGENT_MCP_DISCOVERY_DEADLINE_MS);
    if !(1..=30_000).contains(&deadline_ms) {
        return Err(McpError::OAuthRequest(
            "Invalid subagent MCP discovery deadline.".into(),
        ));
    }

    // One shared deadline: cancels the inspection controller and wins both
    // the config-load race and the settlement race (TS `deadline` promise).
    let controller = CancellationToken::new();
    let deadline_token = CancellationToken::new();
    let deadline_handle = tokio::spawn({
        let controller = controller.clone();
        let deadline_token = deadline_token.clone();
        async move {
            tokio::time::sleep(std::time::Duration::from_millis(deadline_ms)).await;
            controller.cancel();
            deadline_token.cancel();
        }
    });

    let outcome = tokio::select! {
        _ = deadline_token.cancelled() => {
            Ok(Vec::new())
        }
        _ = parent_signal.cancelled() => {
            Err(McpError::Cancelled)
        }
        listed = (dependencies.list_servers)() => {
            let servers: Vec<McpServer> = listed
                .into_iter()
                .filter(|server| server.enabled && server.transport != McpTransport::Stdio)
                .take(MAX_SUBAGENT_MCP_SCOPES)
                .collect();
            let cache = dependencies.cache.clone();
            let now = &dependencies.now;
            let (completed_tx, mut completed_rx) =
                tokio::sync::mpsc::channel::<InspectedSubagentMcpServer>(servers.len().max(1));
            let tasks = servers.into_iter().map(|server| {
                let server_id = server.id.clone();
                let cache = cache.clone();
                let controller = controller.clone();
                let parent_signal = parent_signal.clone();
                let completed_tx = completed_tx.clone();
                async move {
                    let credential_revision = (dependencies.resolve_credential_revision)(&server, controller.clone()).await;
                    let fingerprint = match subagent_mcp_connection_fingerprint(&server, &credential_revision) {
                        Ok(fingerprint) => fingerprint,
                        Err(error) => {
                            tracing::debug!(server = %server_id, %error, "MCP inventory fingerprint failed");
                            return;
                        }
                    };
                    let inspected = async {
                        {
                            let mut cache = cache.lock().unwrap();
                            match cache.get(&server_id, &fingerprint, now()) {
                                CacheLookup::Negative => return Ok(None),
                                CacheLookup::Hit(cached) => return Ok(Some(cached)),
                                CacheLookup::Miss => {}
                            }
                        }
                        let operation: InspectionOperation = Box::new({
                            let server = server.clone();
                            let expected = fingerprint.clone();
                            let controller = controller.clone();
                            move |client: &dyn SubagentMcpClientPort| {
                                let server = server.clone();
                                let expected = expected.clone();
                                let controller = controller.clone();
                                Box::pin(async move {
                                    if !client.credential_revision_is_current(&controller).await {
                                        return Err(McpError::Protocol(
                                            "MCP read authority changed during discovery.".into(),
                                        ));
                                    }
                                    let tools = client.list_tools(&controller).await?;
                                    let normalized = normalize_subagent_mcp_inventory(&tools, &|text| {
                                        client.redact_credential_text(text)
                                    })
                                    .map_err(|err| McpError::Protocol(err.to_string()))?;
                                    let connection_fingerprint = subagent_mcp_connection_fingerprint(&server, client.credential_revision())
                                        .map_err(|err| McpError::Protocol(err.to_string()))?;
                                    if connection_fingerprint != expected {
                                        return Err(McpError::Protocol(
                                            "MCP credential revision changed during discovery.".into(),
                                        ));
                                    }
                                    Ok(InspectedSubagentMcpServer {
                                        server_id: server.id.clone(),
                                        connection_fingerprint,
                                        tools: normalized,
                                    })
                                })
                            }
                        });
                        let inspected = (dependencies.with_client)(server.clone(), controller.clone(), operation).await?;
                        if inspected.connection_fingerprint != fingerprint {
                            return Err(McpError::Protocol(
                                "MCP credential revision changed during discovery.".into(),
                            ));
                        }
                        cache.lock().unwrap().set(&inspected, now(), None);
                        Ok(Some(inspected))
                    }
                    .await;
                    match inspected {
                        Ok(Some(inspected)) => {
                            let _ = completed_tx.send(inspected).await;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            if !parent_signal.is_cancelled() {
                                cache.lock().unwrap().set_failure(&server_id, &fingerprint, now());
                            }
                            tracing::debug!(server = %server_id, %error, "MCP inventory inspection failed");
                        }
                    }
                }
            });
            let all = futures::future::join_all(tasks);
            tokio::pin!(all);
            tokio::select! {
                _ = &mut all => {}
                _ = deadline_token.cancelled() => { controller.cancel(); }
                _ = parent_signal.cancelled() => { return Err(McpError::Cancelled); }
            }
            let mut completed = Vec::new();
            while let Ok(inspected) = completed_rx.try_recv() {
                completed.push(inspected);
            }
            Ok(project_inventory(&completed))
        }
    };

    deadline_handle.abort();
    let _ = deadline_handle.await;
    outcome
}

/// `projectInventory` — sorted, bounded scope projection.
pub fn project_inventory(completed: &[InspectedSubagentMcpServer]) -> Vec<SubagentMcpScope> {
    let mut servers: Vec<&InspectedSubagentMcpServer> = completed.iter().collect();
    servers.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    servers
        .into_iter()
        .take(MAX_SUBAGENT_MCP_SCOPES)
        .filter_map(|server| {
            let mut tools: Vec<InspectedSubagentMcpTool> = server.tools.clone();
            tools.sort_by(|left, right| left.tool_name.cmp(&right.tool_name));
            tools.truncate(MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE);
            if tools.is_empty() {
                None
            } else {
                Some(SubagentMcpScope {
                    server_id: server.server_id.clone(),
                    connection_fingerprint: server.connection_fingerprint.clone(),
                    tools,
                })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::mcp_agent_tool_name;

    fn server(id: &str) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.to_string(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some(format!("https://{id}.test/mcp")),
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        }
    }

    fn tool(name: &str) -> McpToolInfo {
        McpToolInfo {
            name: name.into(),
            description: None,
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
            output_schema: None,
            annotations: Some(serde_json::json!({ "readOnlyHint": true })),
        }
    }

    fn inspect(
        server: &McpServer,
        tools: Vec<McpToolInfo>,
    ) -> Result<InspectedSubagentMcpServer, McpError> {
        let revision = "a".repeat(64);
        let fingerprint = subagent_mcp_connection_fingerprint(server, &revision)
            .map_err(|err| McpError::Protocol(err.to_string()))?;
        let normalized = normalize_subagent_mcp_inventory(&tools, &|text| text.to_string())
            .map_err(|err| McpError::Protocol(err.to_string()))?;
        Ok(InspectedSubagentMcpServer {
            server_id: server.id.clone(),
            connection_fingerprint: fingerprint,
            tools: normalized,
        })
    }

    #[test]
    fn inventory_diff_reports_added_and_removed() {
        let before = ToolInventorySnapshot {
            server_id: "docs".into(),
            tools: vec![
                NamespacedMcpTool {
                    agent_name: mcp_agent_tool_name("docs", "Docs", "lookup"),
                    label: "lookup".into(),
                },
                NamespacedMcpTool {
                    agent_name: mcp_agent_tool_name("docs", "Docs", "write"),
                    label: "write".into(),
                },
            ],
            captured_at: 1,
        };
        let after = ToolInventorySnapshot {
            server_id: "docs".into(),
            tools: vec![
                NamespacedMcpTool {
                    agent_name: mcp_agent_tool_name("docs", "Docs", "lookup"),
                    label: "lookup".into(),
                },
                NamespacedMcpTool {
                    agent_name: mcp_agent_tool_name("docs", "Docs", "search"),
                    label: "search".into(),
                },
            ],
            captured_at: 2,
        };
        let diff = diff_inventories(&before, &after);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.added[0], mcp_agent_tool_name("docs", "Docs", "search"));
        assert_eq!(
            diff.removed[0],
            mcp_agent_tool_name("docs", "Docs", "write")
        );
        assert_eq!(diff_inventories(&before, &before), InventoryDiff::default());
    }

    #[test]
    fn tool_info_projects_agent_definitions() {
        let server = server("docs");
        let info = tool("lookup");
        let def = info.to_tool_def(&server, "lookup");
        assert_eq!(def.name, mcp_agent_tool_name("docs", "docs", "lookup"));
        assert_eq!(def.label, "lookup");
        assert_eq!(def.description, "lookup");
        assert_eq!(
            def.parameters,
            serde_json::json!({ "type": "object", "properties": {} })
        );
        // Missing schema falls back to the object shape.
        let bare = McpToolInfo {
            name: "bare".into(),
            description: Some("desc".into()),
            input_schema: serde_json::Value::Null,
            output_schema: None,
            annotations: None,
        };
        assert_eq!(
            bare.to_tool_def(&server, "bare").parameters,
            serde_json::json!({ "type": "object", "properties": {} })
        );
    }

    #[test]
    fn cache_avoids_repeat_connections_and_invalidates_on_rotation() {
        let mut cache = SubagentMcpInventoryCache::new();
        let server = server("docs");
        let inspected = inspect(&server, vec![tool("lookup")]).unwrap();
        let revision_a = "a".repeat(64);
        let fingerprint_a = subagent_mcp_connection_fingerprint(&server, &revision_a).unwrap();

        cache.set(&inspected, 1_000, None);
        assert!(matches!(
            cache.get("docs", &fingerprint_a, 1_000),
            CacheLookup::Hit(_)
        ));
        assert!(matches!(
            cache.get("docs", &fingerprint_a, 2_000),
            CacheLookup::Hit(_)
        ));

        // Credential rotation invalidates the entry.
        let revision_b = "b".repeat(64);
        let fingerprint_b = subagent_mcp_connection_fingerprint(&server, &revision_b).unwrap();
        assert!(matches!(
            cache.get("docs", &fingerprint_b, 3_000),
            CacheLookup::Miss
        ));
    }

    #[test]
    fn negative_cache_advances_exponential_backoff_across_retries() {
        let mut cache = SubagentMcpInventoryCache::new();
        let fingerprint = "f".repeat(64);
        cache.set_failure("offline", &fingerprint, 0);
        assert!(matches!(
            cache.get("offline", &fingerprint, 29_999),
            CacheLookup::Negative
        ));
        assert!(matches!(
            cache.get("offline", &fingerprint, 30_000),
            CacheLookup::Miss
        ));
        cache.set_failure("offline", &fingerprint, 30_000);
        assert!(matches!(
            cache.get("offline", &fingerprint, 89_999),
            CacheLookup::Negative
        ));
        assert!(matches!(
            cache.get("offline", &fingerprint, 90_000),
            CacheLookup::Miss
        ));
        cache.set_failure("offline", &fingerprint, 90_000);
        assert!(matches!(
            cache.get("offline", &fingerprint, 209_999),
            CacheLookup::Negative
        ));
    }

    #[test]
    fn connection_fingerprint_is_credential_aware() {
        let server = server("docs");
        let a = subagent_mcp_connection_fingerprint(&server, &"a".repeat(64)).unwrap();
        let b = subagent_mcp_connection_fingerprint(&server, &"b".repeat(64)).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(subagent_mcp_connection_fingerprint(&server, "not-a-hash").is_err());

        // Endpoint changes also rotate the fingerprint.
        let mut moved = server.clone();
        moved.url = Some("https://docs2.test/mcp".into());
        let moved_hash = subagent_mcp_connection_fingerprint(&moved, &"a".repeat(64)).unwrap();
        assert_ne!(a, moved_hash);
    }

    #[test]
    fn normalization_classifies_read_only_and_mutating_tools() {
        let mut tools = vec![tool("read_only")];
        tools.push(McpToolInfo {
            name: "mutating".into(),
            description: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: None,
            annotations: None,
        });
        tools.push(McpToolInfo {
            name: "declared_mutating".into(),
            description: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: None,
            annotations: Some(
                serde_json::json!({ "readOnlyHint": false, "destructiveHint": true }),
            ),
        });
        let normalized =
            normalize_subagent_mcp_inventory(&tools, &|text| text.to_string()).unwrap();
        assert_eq!(normalized.len(), 3);
        assert_eq!(normalized[0].effect, McpToolEffect::Read);
        assert_eq!(normalized[1].effect, McpToolEffect::Mutating);
        assert_eq!(normalized[2].effect, McpToolEffect::Mutating);
        // Schema hashes are stable.
        let again = normalize_subagent_mcp_inventory(&tools, &|text| text.to_string()).unwrap();
        assert_eq!(normalized[0].schema_hash, again[0].schema_hash);
    }

    #[test]
    fn normalization_rejects_unsafe_identities_and_duplicates() {
        let bad_name = vec![McpToolInfo {
            name: "has space".into(),
            description: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: None,
            annotations: None,
        }];
        assert!(normalize_subagent_mcp_inventory(&bad_name, &|text| text.to_string()).is_err());

        let duplicated = vec![tool("same"), tool("same")];
        assert!(normalize_subagent_mcp_inventory(&duplicated, &|text| text.to_string()).is_err());
    }

    #[test]
    fn canonical_json_sorts_keys_and_enforces_limits() {
        let value = serde_json::json!({ "b": 1, "a": { "z": 2, "y": [3, 4] } });
        assert_eq!(
            canonical_json(&value, 10_000).unwrap(),
            r#"{"a":{"y":[3,4],"z":2},"b":1}"#
        );
        let err = canonical_json(&value, 4).unwrap_err();
        assert_eq!(err.code, McpReadErrorCode::InvalidBinding);
    }

    #[test]
    fn canonical_json_rejects_unsafe_keys() {
        let value = serde_json::json!({ "constructor": 1 });
        assert!(canonical_json(&value, 10_000).is_err());
    }

    #[tokio::test]
    async fn bounded_discovery_skips_stdio_and_keeps_completed_servers_at_one_deadline() {
        let fast = server("fast");
        let slow = server("slow");
        let mut stdio = server("local");
        stdio.transport = McpTransport::Stdio;
        stdio.command = Some("unsafe".into());
        let client_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let client_calls_inner = client_calls.clone();

        let dependencies = SubagentMcpInventoryDependencies {
            list_servers: Box::new(move || {
                let servers = vec![fast.clone(), slow.clone(), stdio.clone()];
                Box::pin(async move { servers })
            }),
            with_client: Box::new(move |current, cancel, operation| {
                let current = current.clone();
                let cancel = cancel.clone();
                let calls = client_calls_inner.clone();
                Box::pin(async move {
                    if current.id == "slow" {
                        // Respect the aggregate deadline like the TS test fake.
                        cancel.cancelled().await;
                        Err(McpError::Cancelled)
                    } else {
                        calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let port = FakePort::new("a".repeat(64));
                        operation(&port).await
                    }
                })
            }),
            resolve_credential_revision: Box::new(|_server, _cancel| {
                Box::pin(async move { "a".repeat(64) })
            }),
            cache: std::sync::Arc::new(std::sync::Mutex::new(SubagentMcpInventoryCache::new())),
            now: Box::new(|| 1_000),
            discovery_deadline_ms: Some(20),
        };
        let scopes =
            resolve_bounded_subagent_mcp_inventory(CancellationToken::new(), &dependencies)
                .await
                .unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].server_id, "fast");
        assert_eq!(
            client_calls.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "stdio must never be inspected"
        );
    }

    #[tokio::test]
    async fn bounded_discovery_returns_early_when_config_loading_hangs() {
        let started = std::time::Instant::now();
        let dependencies = SubagentMcpInventoryDependencies {
            list_servers: Box::new(|| Box::pin(std::future::pending())),
            with_client: Box::new(|_server, _cancel, _operation| Box::pin(std::future::pending())),
            resolve_credential_revision: Box::new(|_server, _cancel| {
                Box::pin(async move { "a".repeat(64) })
            }),
            cache: std::sync::Arc::new(std::sync::Mutex::new(SubagentMcpInventoryCache::new())),
            now: Box::new(|| 1_000),
            discovery_deadline_ms: Some(20),
        };
        let scopes =
            resolve_bounded_subagent_mcp_inventory(CancellationToken::new(), &dependencies)
                .await
                .unwrap();
        assert!(scopes.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
    }

    #[tokio::test]
    async fn bounded_discovery_is_cancelled_by_the_parent_signal() {
        let token = CancellationToken::new();
        let dependencies = SubagentMcpInventoryDependencies {
            list_servers: Box::new(|| Box::pin(std::future::pending())),
            with_client: Box::new(|_server, _cancel, _operation| Box::pin(std::future::pending())),
            resolve_credential_revision: Box::new(|_server, _cancel| {
                Box::pin(async move { "a".repeat(64) })
            }),
            cache: std::sync::Arc::new(std::sync::Mutex::new(SubagentMcpInventoryCache::new())),
            now: Box::new(|| 1_000),
            discovery_deadline_ms: Some(60_000),
        };
        token.cancel();
        let result = resolve_bounded_subagent_mcp_inventory(token, &dependencies).await;
        assert!(matches!(result, Err(McpError::Cancelled)));
    }

    struct FakePort {
        revision: String,
    }

    impl FakePort {
        fn new(revision: String) -> Self {
            Self { revision }
        }
    }

    impl SubagentMcpClientPort for FakePort {
        fn credential_revision(&self) -> &str {
            &self.revision
        }

        fn credential_revision_is_current(
            &self,
            _cancel: &CancellationToken,
        ) -> BoxFuture<'_, bool> {
            Box::pin(async { true })
        }

        fn redact_credential_text(&self, text: &str) -> String {
            text.to_string()
        }

        fn list_tools(
            &self,
            _cancel: &CancellationToken,
        ) -> BoxFuture<'_, Result<Vec<McpToolInfo>, McpError>> {
            Box::pin(async {
                Ok(vec![McpToolInfo {
                    name: "lookup".into(),
                    description: None,
                    input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                    output_schema: None,
                    annotations: Some(serde_json::json!({ "readOnlyHint": true })),
                }])
            })
        }
    }
}
