//! Aiden MCP (Model Context Protocol) — port of `main/services/mcp-*.ts`.
//!
//! Module map (each module documents the TS files it ports):
//!
//! - [`config`] — portable config resolution, the Composio/Notion/Linear
//!   preset catalog, and the per-chat/global selection policy
//!   (`mcp-presets.ts`, `mcp-selection.ts`, `makeTransport`/`resolveAuth` of
//!   `mcp.ts`).
//! - [`client`] — rmcp-based [`client::McpClientManager`]: stdio child
//!   processes and streamable-HTTP connections, the `initialize` handshake,
//!   `tools/list` / `resources/list` / `prompts/list`, `tools/call` with
//!   timeouts, and namespaced agent-tool projection (`mcp.ts`,
//!   `mcp-tool-result.ts`).
//! - [`identity`] — `mcp_agent_tool_name` namespacing + collision assertion
//!   (`mcp-tool-identity.ts`).
//! - [`inventory`] — tool inventory snapshots + diffs and the bounded
//!   credential-aware discovery with exponential failure backoff
//!   (`subagent-mcp-inventory-core.ts`, `subagent-mcp-read.ts`).
//! - [`oauth`] — OAuth session/operation state machines, PKCE S256, the RFC
//!   8252 loopback listener on port 41390, and the interactive flow driver
//!   (`mcp-oauth-session.ts`, `mcp-oauth-operation.ts`, `mcp-oauth.ts`).
//! - [`error`] — thiserror taxonomy mirroring the TS error surfaces.
//!
//! The on-disk `McpServer` record shape is part of the byte-compatible
//! config.json contract and lives in `aiden_data::portable_config`; it is
//! re-exported here.

pub mod client;
pub mod config;
pub mod connection_cache;
pub mod credential_cleanup;
pub mod error;
pub mod identity;
pub mod inventory;
pub mod oauth;

pub use aiden_data::portable_config::{McpServer, McpTransport};
pub use client::{
    collect_mcp_agent_tools, McpClient, McpClientManager, McpConnectionLease, McpStatus,
    McpToolTextResult,
};
pub use config::{
    get_mcp_preset, get_mcp_preset_for_server_id, preset_secret_id, preset_server_id,
    resolve_mcp_server, selected_mcp_servers, server_from_preset, McpPreset, McpPresetAuth,
    McpServerSpec, RemoteSpec, StdioSpec, MCP_PRESETS,
};
pub use error::{McpError, McpReadError, McpReadErrorCode};
pub use identity::{assert_unique_mcp_agent_tool_names, mcp_agent_tool_name};
pub use inventory::{McpToolInfo, SubagentMcpScope};

/// The agent-facing tool record for a namespaced MCP tool. Aligns with
/// `aiden_core::ToolDef` (`name` + `description` + raw JSON Schema
/// `parameters`) plus pi's `label`, and serializes to the same camelCase wire
/// shape the renderer expects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentTool {
    pub name: String,
    pub label: String,
    pub description: String,
    /// Raw JSON Schema (replaces typebox `Type.Unsafe`).
    pub parameters: serde_json::Value,
}

impl McpAgentTool {
    /// Project into the provider-facing tool definition used by the agent
    /// loop (`pi` `AgentTool` minus the execute closure).
    pub fn to_tool_def(&self) -> aiden_core::ToolDef {
        aiden_core::ToolDef {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        }
    }
}

use serde::{Deserialize, Serialize};

// ===========================================================================
// Shared helpers (hashing, base64url, randomness)
// ===========================================================================

pub(crate) mod util {
    use crate::McpError;

    /// Unpadded base64url (RFC 4648 §5) encoding.
    pub fn base64url_encode(bytes: &[u8]) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;
        URL_SAFE_NO_PAD.encode(bytes)
    }

    /// Cryptographically random bytes (used for PKCE verifiers).
    pub fn random_bytes(len: usize) -> Result<Vec<u8>, McpError> {
        let mut buffer = vec![0u8; len];
        getrandom::getrandom(&mut buffer)
            .map_err(|err| McpError::OAuthRequest(format!("failed to gather randomness: {err}")))?;
        Ok(buffer)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn base64url_is_unpadded_and_url_safe() {
            assert_eq!(base64url_encode(b""), "");
            assert_eq!(base64url_encode(b"f"), "Zg");
            assert_eq!(base64url_encode(b"fo"), "Zm8");
            assert_eq!(base64url_encode(b"foo"), "Zm9v");
            // Standard base64 would end in '='; the URL-safe alphabet swaps +/.
            assert_eq!(base64url_encode(&[0xfb, 0xff, 0xff]), "-___");
        }

        #[test]
        fn random_bytes_produces_distinct_values() {
            let a = random_bytes(32).unwrap();
            let b = random_bytes(32).unwrap();
            assert_ne!(a, b);
        }
    }
}
