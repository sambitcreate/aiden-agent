//! Aiden MCP (Model Context Protocol) — scaffold.
//!
//! Phase 3 placeholder. This crate will port `main/services/mcp-*.ts`:
//!
//! - **Server records** — `McpServer` (stdio/http/sse transports, env, headers,
//!   OAuth flag, presets) persisted in the portable `~/.aiden/config.json`.
//! - **Clients** — `rmcp`-based (or hand-rolled JSON-RPC over
//!   `tokio::process` / reqwest) matching the SDK client Aiden uses today:
//!   `StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport`.
//! - **OAuth** — PKCE + dynamic client registration, RFC 8252 loopback redirect
//!   on the fixed port `41390`, 5-minute auth timeout, sessions persisted
//!   encrypted in `<userData>/mcp-oauth.json`.
//! - **Tool inventory** — server → namespaced `AgentTool` mapping with raw JSON
//!   Schema parameters (`Type.Unsafe` escape hatch), uniqueness across servers,
//!   and `GenerationBoundConnectionCache` semantics.
//! - **Presets** — Composio / Notion / Linear catalog entries.
//!
//! The on-disk `McpServer` shape is part of the byte-compatible config.json
//! contract, so the record type is defined here now.

use serde::{Deserialize, Serialize};

/// Transport selector for an MCP server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// A configured MCP server record (portable config.json, hand-editable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    /// stdio transports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<serde_json::Map<String, serde_json::Value>>,
    /// http/sse transports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<serde_json::Map<String, serde_json::Value>>,
    /// Remote only: browser sign-in flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub enabled: bool,
}

/// The fixed loopback redirect port for MCP OAuth (RFC 8252).
pub const MCP_OAUTH_REDIRECT_PORT: u16 = 41390;

/// Namespaces a server's tool into a global tool name.
pub fn mcp_agent_tool_name(server_id: &str, tool_name: &str) -> String {
    format!("{server_id}_{tool_name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_roundtrips_with_camel_case_keys() {
        let server = McpServer {
            id: "preset-linear".into(),
            name: "Linear".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://mcp.linear.app/mcp".into()),
            headers: None,
            oauth: Some(true),
            preset_id: Some("linear".into()),
            enabled: true,
        };
        let json = serde_json::to_value(&server).unwrap();
        assert_eq!(json["transport"], "http");
        assert_eq!(json["presetId"], "linear");
        assert_eq!(json["url"], "https://mcp.linear.app/mcp");
        let back: McpServer = serde_json::from_value(json).unwrap();
        assert_eq!(back, server);
    }

    #[test]
    fn tool_names_are_namespaced_per_server() {
        assert_eq!(
            mcp_agent_tool_name("linear", "search_issues"),
            "linear_search_issues"
        );
    }
}
