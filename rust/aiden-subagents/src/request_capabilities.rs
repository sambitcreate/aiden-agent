//! Port of `main/services/subagents/request-capabilities-v2.ts` — the
//! deterministic MCP inventory bounding (shared by exact authority availability
//! and the model projection) and the resolution of logical model requests to
//! exact host-owned authority scopes.

use serde_json::Value;

use crate::authority::{
    parse_subagent_mcp_tool_scope_v2, SubagentCapabilitySetV2, SubagentMcpScopeV2,
    SubagentMcpToolScopeV2, MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE,
};
use crate::contracts::{SubagentRequestedCapabilities, SubagentRequestedMcpScope};

pub const MAX_SUBAGENT_MODEL_MCP_TOOLS: usize = 64;
pub const MAX_SUBAGENT_MODEL_MCP_NAME_BYTES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentRequestableMcpInventoryV2 {
    pub server_id: String,
    pub tools: Vec<String>,
}

fn utf8_bytes(value: &str) -> usize {
    value.len()
}

/// Deterministic ceiling shared by exact read authority availability and model
/// projection (`boundSubagentMcpInventoryByEffectV2`).
fn bound_subagent_mcp_inventory_by_effect_v2(
    scopes: &[SubagentMcpScopeV2],
    effect_is_mutating: bool,
) -> Vec<SubagentMcpScopeV2> {
    let mut total_tools = 0usize;
    let mut total_name_bytes = 0usize;
    let mut sorted: Vec<&SubagentMcpScopeV2> = scopes.iter().collect();
    sorted.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    let mut bounded: Vec<SubagentMcpScopeV2> = Vec::new();
    for scope in sorted {
        let server_bytes = utf8_bytes(&scope.server_id);
        let mut tools: Vec<SubagentMcpToolScopeV2> = Vec::new();
        let mut candidates: Vec<&SubagentMcpToolScopeV2> = scope
            .tools
            .iter()
            .filter(|candidate| {
                candidate.effect() == crate::authority::SubagentMcpEffectV2::Read
                    && !effect_is_mutating
                    || candidate.effect() == crate::authority::SubagentMcpEffectV2::Mutating
                        && effect_is_mutating
            })
            .collect();
        candidates.sort_by(|left, right| left.tool_name().cmp(right.tool_name()));
        for tool in candidates {
            if tools.len() >= MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE
                || total_tools >= MAX_SUBAGENT_MODEL_MCP_TOOLS
            {
                break;
            }
            let name_bytes = utf8_bytes(tool.tool_name());
            let server_cost = if tools.is_empty() { server_bytes } else { 0 };
            if total_name_bytes + server_cost + name_bytes > MAX_SUBAGENT_MODEL_MCP_NAME_BYTES {
                continue;
            }
            total_name_bytes += server_cost + name_bytes;
            total_tools += 1;
            tools.push(tool.clone());
        }
        if !tools.is_empty() {
            bounded.push(SubagentMcpScopeV2 {
                server_id: scope.server_id.clone(),
                connection_fingerprint: scope.connection_fingerprint.clone(),
                tools,
            });
        }
        if total_tools >= MAX_SUBAGENT_MODEL_MCP_TOOLS {
            break;
        }
    }
    bounded
}

/// Read-lane inventory ceiling (`boundSubagentMcpInventoryV2`).
pub fn bound_subagent_mcp_inventory_v2(scopes: &[SubagentMcpScopeV2]) -> Vec<SubagentMcpScopeV2> {
    bound_subagent_mcp_inventory_by_effect_v2(scopes, false)
}

/// Safe model projection. Fingerprints, schema hashes, effects, and
/// credentials stay in main (`projectRequestableSubagentMcpInventoryV2`).
pub fn project_requestable_subagent_mcp_inventory_v2(
    scopes: &[SubagentMcpScopeV2],
) -> Vec<SubagentRequestableMcpInventoryV2> {
    let mut projected: Vec<SubagentRequestableMcpInventoryV2> =
        bound_subagent_mcp_inventory_v2(scopes)
            .iter()
            .map(|scope| {
                let mut tools: Vec<String> = scope
                    .tools
                    .iter()
                    .map(|tool| tool.tool_name().to_string())
                    .collect();
                tools.sort();
                SubagentRequestableMcpInventoryV2 {
                    server_id: scope.server_id.clone(),
                    tools,
                }
            })
            .filter(|scope| !scope.tools.is_empty())
            .collect();
    projected.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    projected
}

/// Mutation projection exposes only logical names; private effect facts stay in
/// main (`projectRequestableSubagentMcpMutationInventoryV2`).
pub fn project_requestable_subagent_mcp_mutation_inventory_v2(
    scopes: &[SubagentMcpScopeV2],
) -> Vec<SubagentRequestableMcpInventoryV2> {
    let mut projected: Vec<SubagentRequestableMcpInventoryV2> =
        bound_subagent_mcp_inventory_by_effect_v2(scopes, true)
            .iter()
            .map(|scope| {
                let mut tools: Vec<String> = scope
                    .tools
                    .iter()
                    .map(|tool| tool.tool_name().to_string())
                    .collect();
                tools.sort();
                SubagentRequestableMcpInventoryV2 {
                    server_id: scope.server_id.clone(),
                    tools,
                }
            })
            .filter(|scope| !scope.tools.is_empty())
            .collect();
    projected.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    projected
}

fn exact_requested_mcp_scopes(
    requested: &[SubagentRequestedMcpScope],
    inventory: &[SubagentMcpScopeV2],
    mutating: bool,
) -> Result<Vec<SubagentMcpScopeV2>, String> {
    let mut scopes = Vec::with_capacity(requested.len());
    for request in requested {
        let server = inventory
            .iter()
            .find(|scope| scope.server_id == request.server_id);
        let Some(server) = server else {
            return Err(format!(
                "Requested subagent MCP server {} is unavailable.",
                serde_json::to_string(&request.server_id).expect("json")
            ));
        };
        let mut tools = Vec::with_capacity(request.tools.len());
        for tool_name in &request.tools {
            let tool = server
                .tools
                .iter()
                .find(|tool| tool.tool_name() == tool_name);
            let Some(tool) = tool else {
                return Err(format!(
                    "Requested subagent MCP {} tool {} is stale, unavailable, or in the wrong lane.",
                    if mutating { "mutation" } else { "read" },
                    serde_json::to_string(&format!("{}:{}", request.server_id, tool_name))
                        .expect("json")
                ));
            };
            let is_mutating = tool.effect() == crate::authority::SubagentMcpEffectV2::Mutating;
            if is_mutating != mutating {
                return Err(format!(
                    "Requested subagent MCP {} tool {} is stale, unavailable, or in the wrong lane.",
                    if mutating { "mutation" } else { "read" },
                    serde_json::to_string(&format!("{}:{}", request.server_id, tool_name))
                        .expect("json")
                ));
            }
            tools.push(tool.clone());
        }
        scopes.push(SubagentMcpScopeV2 {
            server_id: server.server_id.clone(),
            connection_fingerprint: server.connection_fingerprint.clone(),
            tools,
        });
    }
    Ok(scopes)
}

/// Resolve logical model requests to exact host-owned authority scopes
/// (`resolveRequestedSubagentCapabilitiesV2`).
pub fn resolve_requested_subagent_capabilities_v2(
    requested: &SubagentRequestedCapabilities,
    mcp_inventory: &[SubagentMcpScopeV2],
) -> Result<SubagentCapabilitySetV2, String> {
    let requested_reads: std::collections::HashSet<String> = requested
        .mcp
        .iter()
        .flat_map(|scope| {
            scope
                .tools
                .iter()
                .map(move |tool| format!("{}\0{}", scope.server_id, tool))
        })
        .collect();
    if let Some(mutations) = &requested.mcp_mutations {
        if mutations.iter().any(|scope| {
            scope
                .tools
                .iter()
                .any(|tool| requested_reads.contains(&format!("{}\0{}", scope.server_id, tool)))
        }) {
            return Err("Subagent MCP read and mutation requests must be disjoint.".to_string());
        }
    }
    let exact_read = exact_requested_mcp_scopes(&requested.mcp, mcp_inventory, false)?;
    let exact_mutation = exact_requested_mcp_scopes(
        requested.mcp_mutations.as_deref().unwrap_or(&[]),
        mcp_inventory,
        true,
    )?;
    // Merge scopes per server; fingerprints must agree.
    let mut merged: Vec<SubagentMcpScopeV2> = Vec::new();
    for scope in exact_read.into_iter().chain(exact_mutation) {
        let existing = merged
            .iter_mut()
            .find(|existing| existing.server_id == scope.server_id);
        match existing {
            Some(existing) => {
                if existing.connection_fingerprint != scope.connection_fingerprint {
                    return Err(format!(
                        "Requested subagent MCP server {} changed.",
                        serde_json::to_string(&scope.server_id).expect("json")
                    ));
                }
                existing.tools.extend(scope.tools);
            }
            None => merged.push(scope),
        }
    }
    Ok(SubagentCapabilitySetV2 {
        workspace_read: requested.workspace_read,
        workspace_write: requested.workspace_write,
        shell: requested.shell == Some(true),
        web: requested.web,
        delegation: requested.delegate == Some(true),
        mcp: merged,
    })
}

/// Re-parse tool scope values (used by the tool-assembly surface).
pub fn parse_tool_scope(value: &Value) -> Result<SubagentMcpToolScopeV2, String> {
    parse_subagent_mcp_tool_scope_v2(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fingerprint(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn read_scope(server_id: &str, tool_names: &[&str]) -> Value {
        let tools: Vec<Value> = tool_names
            .iter()
            .map(|name| {
                json!({
                    "toolName": name,
                    "schemaHash": fingerprint(name.len() as u8),
                    "effect": "read",
                })
            })
            .collect();
        json!({
            "serverId": server_id,
            "connectionFingerprint": fingerprint(0xaa),
            "tools": tools,
        })
    }

    fn scopes_from(value: &Value) -> Vec<SubagentMcpScopeV2> {
        value
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| {
                let server_id = entry["serverId"].as_str().unwrap().to_string();
                let connection_fingerprint =
                    entry["connectionFingerprint"].as_str().unwrap().to_string();
                let tools = entry["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tool| parse_tool_scope(tool).unwrap())
                    .collect();
                SubagentMcpScopeV2 {
                    server_id,
                    connection_fingerprint,
                    tools,
                }
            })
            .collect()
    }

    fn requested(server_tools: &[(&str, &[&str])]) -> Vec<SubagentRequestedMcpScope> {
        server_tools
            .iter()
            .map(|(server_id, tools)| SubagentRequestedMcpScope {
                server_id: (*server_id).to_string(),
                tools: tools.iter().map(|tool| (*tool).to_string()).collect(),
            })
            .collect()
    }

    #[test]
    fn projection_sorts_and_bounds_by_server_and_name_bytes() {
        let inventory = scopes_from(&json!([
            read_scope("notion", &["get_page", "get_page2"]),
            read_scope("linear", &["get_issue", "get_issue2"]),
        ]));
        let projected = project_requestable_subagent_mcp_inventory_v2(&inventory);
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0].server_id, "linear");
        assert_eq!(projected[1].server_id, "notion");
        assert!(projected[0]
            .tools
            .iter()
            .all(|tool| tool.starts_with("get_")));
    }

    #[test]
    fn byte_budget_caps_total_name_bytes() {
        // A 4090-byte server id can never admit a tool (server cost + name
        // exceeds the 4096-byte budget), so only the linear scope survives.
        let long_server = "s".repeat(4_090);
        let inventory = scopes_from(&json!([
            read_scope(&long_server, &["tool_one", "tool_two"]),
            read_scope("linear", &["get_issue"]),
        ]));
        let projected = project_requestable_subagent_mcp_inventory_v2(&inventory);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].server_id, "linear");
    }

    #[test]
    fn exact_resolution_rejects_stale_or_wrong_lane_tools() {
        let inventory_value = json!([
            {
                "serverId": "linear",
                "connectionFingerprint": fingerprint(0xaa),
                "tools": [
                    json!({ "toolName": "get_issue", "schemaHash": fingerprint(0x01), "effect": "read" }),
                    json!({
                        "toolName": "update_issue",
                        "schemaHash": fingerprint(0x02),
                        "effect": "mutating",
                        "effectProfile": {
                            "classification": "declared_mutating",
                            "destructive": "unknown",
                            "idempotency": "not_declared",
                            "openWorld": "unknown",
                            "taskSupport": "forbidden",
                            "fingerprint": "x",
                        },
                    }),
                ],
            }
        ]);
        // Fix the effect profile fingerprint.
        let inventory_value = {
            let mut value = inventory_value;
            let profile = &mut value[0]["tools"][1]["effectProfile"];
            let classification = profile["classification"].as_str().unwrap();
            let destructive = profile["destructive"].as_str().unwrap();
            let idempotency = profile["idempotency"].as_str().unwrap();
            let open_world = profile["openWorld"].as_str().unwrap();
            let task_support = profile["taskSupport"].as_str().unwrap();
            profile["fingerprint"] = json!(
                crate::authority::subagent_mcp_effect_profile_fingerprint_v2(
                    match classification {
                        "declared_mutating" =>
                            crate::authority::SubagentMcpMutationClassificationV2::DeclaredMutating,
                        _ =>
                            crate::authority::SubagentMcpMutationClassificationV2::UnprovenMutating,
                    },
                    match destructive {
                        "destructive" =>
                            crate::authority::SubagentMcpDestructiveProfileV2::Destructive,
                        "additive" => crate::authority::SubagentMcpDestructiveProfileV2::Additive,
                        _ => crate::authority::SubagentMcpDestructiveProfileV2::Unknown,
                    },
                    match idempotency {
                        "idempotent" =>
                            crate::authority::SubagentMcpIdempotencyProfileV2::Idempotent,
                        _ => crate::authority::SubagentMcpIdempotencyProfileV2::NotDeclared,
                    },
                    match open_world {
                        "open" => crate::authority::SubagentMcpOpenWorldProfileV2::Open,
                        "closed" => crate::authority::SubagentMcpOpenWorldProfileV2::Closed,
                        _ => crate::authority::SubagentMcpOpenWorldProfileV2::Unknown,
                    },
                    match task_support {
                        "forbidden" => crate::authority::SubagentMcpTaskSupportV2::Forbidden,
                        _ => crate::authority::SubagentMcpTaskSupportV2::Optional,
                    },
                )
            );
            value
        };
        let inventory = scopes_from(&inventory_value);
        let request = SubagentRequestedCapabilities {
            workspace_read: true,
            workspace_write: false,
            shell: None,
            delegate: None,
            web: false,
            mcp: requested(&[("linear", &["get_issue"])]),
            mcp_mutations: Some(requested(&[("linear", &["update_issue"])])),
        };
        let resolved = resolve_requested_subagent_capabilities_v2(&request, &inventory).unwrap();
        assert_eq!(resolved.mcp.len(), 1);
        assert_eq!(resolved.mcp[0].tools.len(), 2);

        // Same tool in both lanes is rejected.
        let overlap = SubagentRequestedCapabilities {
            mcp: requested(&[("linear", &["get_issue"])]),
            mcp_mutations: Some(requested(&[("linear", &["get_issue"])])),
            ..request.clone()
        };
        assert!(resolve_requested_subagent_capabilities_v2(&overlap, &inventory).is_err());

        // Unavailable server is rejected.
        let missing = SubagentRequestedCapabilities {
            mcp: requested(&[("notion", &["get_page"])]),
            ..request.clone()
        };
        assert!(resolve_requested_subagent_capabilities_v2(&missing, &inventory).is_err());
    }
}
