//! Chat-generation MCP wiring: bounded tool collection for the provider
//! request plus the namespaced dispatch map used to execute model tool calls
//! against the connected MCP servers.
//!
//! Everything here is tokio-only (no GPUI types) so it runs on the background
//! driver thread: `collect_chat_mcp_tools` connects the enabled servers and
//! lists their tools under a per-server cap, projecting each into the
//! provider-facing `aiden_core::ToolDef` while recording the reverse mapping
//! from the namespaced agent tool name (what the model sees) to the
//! server/tool pair (what `McpClientManager::call_tool` needs). Servers that
//! fail to resolve or connect are skipped with a warning — chat generation
//! never fails closed on MCP.

use std::collections::HashMap;
use std::sync::Arc;

use aiden_core::ToolDef;
use aiden_data::portable_config::McpServer;
use aiden_mcp::{
    mcp_agent_tool_name, resolve_mcp_server, McpClientManager, McpConnectionLease, McpServerSpec,
};

/// Upper bounds for one chat turn's tool surface (bounded collection).
pub const MAX_CHAT_MCP_SERVERS: usize = 16;
pub const MAX_CHAT_MCP_TOOLS_PER_SERVER: usize = 32;
pub const MAX_CHAT_MCP_TOOLS: usize = 64;
/// Per-call timeout for MCP tools executed from the chat driver.
pub const CHAT_MCP_CALL_TIMEOUT_MS: u64 = 60_000;

/// Resolves a preset API-key secret id to its keychain value (background-safe).
pub type PresetKeyResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Where a namespaced tool name dispatches: the connected server + the raw
/// remote tool name.
#[derive(Debug, Clone)]
pub struct McpToolTarget {
    pub tool_name: String,
    pub connection: McpConnectionLease,
}

/// The collected tool surface for one turn: provider tool defs plus the
/// dispatch map keyed by namespaced agent tool name.
#[derive(Debug, Clone, Default)]
pub struct ChatMcpTools {
    pub defs: Vec<ToolDef>,
    pub dispatch: HashMap<String, McpToolTarget>,
}

/// Everything the background stream driver needs to connect + dispatch MCP
/// tools. Carried on [`TurnSnapshot`](crate::services::provider_kit::TurnSnapshot).
#[derive(Clone)]
pub struct McpStreamContext {
    pub manager: Arc<McpClientManager>,
    /// Enabled servers from the portable config (already filtered).
    pub servers: Vec<McpServer>,
    /// Optional keychain resolver for preset API-key servers
    /// (`mcp:{server_id}` secret id). Runs on the background driver thread.
    pub preset_key: Option<PresetKeyResolver>,
}

impl std::fmt::Debug for McpStreamContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpStreamContext")
            .field("servers", &self.servers)
            .field("preset_key", &self.preset_key.is_some())
            .finish()
    }
}

/// Collect tools from the enabled servers, skipping servers that fail to
/// resolve, authenticate, or connect. Never panics and never fails the turn.
pub async fn collect_chat_mcp_tools(
    manager: &McpClientManager,
    servers: &[McpServer],
    preset_key: &Option<PresetKeyResolver>,
) -> ChatMcpTools {
    let mut tools = ChatMcpTools::default();
    for server in servers
        .iter()
        .filter(|server| server.enabled)
        .take(MAX_CHAT_MCP_SERVERS)
    {
        let Some(spec) = resolve_mcp_server(server).ok() else {
            tracing::warn!(server = %server.id, "Skipping MCP server: unresolvable");
            continue;
        };
        let spec = match inject_preset_key(spec, preset_key) {
            Ok(spec) => spec,
            Err(error) => {
                tracing::warn!(server = %server.id, %error, "Skipping MCP server: auth");
                continue;
            }
        };
        if let Err(error) = manager.ensure_connected(&spec).await {
            tracing::warn!(server = %server.id, %error, "Skipping MCP server: connect");
            continue;
        }
        let connection = match manager.connection_lease(&server.id).await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(server = %server.id, %error, "Skipping MCP server: lease");
                continue;
            }
        };
        let listed = match manager.list_tools_for_lease(&connection).await {
            Ok(listed) => listed,
            Err(error) => {
                tracing::warn!(server = %server.id, %error, "Skipping MCP server: tools/list");
                continue;
            }
        };
        for tool in listed.into_iter().take(MAX_CHAT_MCP_TOOLS_PER_SERVER) {
            if tools.defs.len() >= MAX_CHAT_MCP_TOOLS {
                break;
            }
            let agent_name = mcp_agent_tool_name(&server.id, &server.name, &tool.name);
            if tools.dispatch.contains_key(&agent_name) {
                continue;
            }
            let agent = tool.to_tool_def(server, &tool.name);
            tools.dispatch.insert(
                agent_name,
                McpToolTarget {
                    tool_name: tool.name.clone(),
                    connection: connection.clone(),
                },
            );
            tools.defs.push(agent.to_tool_def());
        }
    }
    tools
}

fn inject_preset_key(
    spec: McpServerSpec,
    preset_key: &Option<PresetKeyResolver>,
) -> Result<McpServerSpec, String> {
    if !spec.requires_preset_api_key() {
        return Ok(spec);
    }
    let key = preset_key
        .as_ref()
        .and_then(|resolve| resolve(&spec.server.id))
        .ok_or_else(|| "missing preset API key".to_string())?;
    spec.with_preset_api_key(key)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::McpTransport;

    fn server(id: &str, name: &str, enabled: bool) -> McpServer {
        McpServer {
            id: id.into(),
            name: name.into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some(format!("https://{id}.test/mcp")),
            headers: None,
            oauth: None,
            preset_id: None,
            enabled,
        }
    }

    /// A valid composio preset record (API-key auth, allowed origin).
    fn composio_server() -> McpServer {
        McpServer {
            id: "preset-composio".into(),
            name: "Composio".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://connect.composio.dev/mcp".into()),
            headers: None,
            oauth: None,
            preset_id: Some("composio".into()),
            enabled: true,
        }
    }

    #[test]
    fn namespaced_names_map_back_to_the_server_and_remote_tool() {
        // The projection used by `collect_chat_mcp_tools` must round-trip:
        // the model-facing name (namespaced) resolves to the exact server +
        // remote tool pair needed by `McpClientManager::call_tool`.
        let docs = server("docs", "Docs", true);
        let raw_name = "lookup";
        let agent_name = mcp_agent_tool_name(&docs.id, &docs.name, raw_name);
        assert!(agent_name.starts_with("Docs__lookup_"));
        assert!(agent_name.len() <= 64);

        // A different server id yields a distinct agent name (digest-bound).
        let other = server("docs-clone", "Docs", true);
        let other_name = mcp_agent_tool_name(&other.id, &other.name, raw_name);
        assert_ne!(other_name, agent_name);
    }

    #[tokio::test]
    async fn collection_skips_disabled_and_unreachable_servers_without_failing() {
        let manager = McpClientManager::new();
        let servers = vec![
            server("off", "Off", false),
            server("offline", "Offline", true),
        ];
        // Disabled servers never connect; unreachable servers are skipped
        // rather than failing the turn.
        let tools = collect_chat_mcp_tools(&manager, &servers, &None).await;
        assert!(tools.defs.is_empty());
        assert!(tools.dispatch.is_empty());
    }

    #[test]
    fn preset_key_injection_requires_a_resolved_key() {
        let spec = resolve_mcp_server(&composio_server()).expect("resolves");
        // Missing key fails closed (the collector skips the server).
        assert!(inject_preset_key(spec.clone(), &None).is_err());
        // A resolved key is injected into the preset auth header.
        let keyed: Option<PresetKeyResolver> = Some(Arc::new(|_| Some("secret".to_string())));
        let injected = inject_preset_key(spec, &keyed).unwrap();
        let remote = injected.remote.as_ref().expect("remote spec");
        assert_eq!(
            remote.headers.get("x-consumer-api-key").map(String::as_str),
            Some("secret")
        );
    }
}
