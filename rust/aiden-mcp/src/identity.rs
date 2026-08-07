//! Tool identity (port of `main/services/mcp-tool-identity.ts`).
//!
//! MCP tool names are namespaced per server so the model-facing agent tool set
//! never collides across servers: `mcpAgentToolName` binds the dispatch
//! identity to the stable server id and the raw remote tool name with a
//! truncated sha256 digest, and `assertUniqueMcpAgentToolNames` fails closed on
//! any collision.

use sha2::{Digest, Sha256};

use crate::McpError;

/// Maximum length of a namespaced agent tool name (TS `MCP_AGENT_TOOL_NAME_LIMIT`).
pub const MCP_AGENT_TOOL_NAME_LIMIT: usize = 64;

/// Collapse anything outside `[a-zA-Z0-9_-]` to `_`; an empty result becomes
/// the literal `"tool"` (TS `sanitize`).
pub fn sanitize_tool_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "tool".to_string()
    } else {
        sanitized
    }
}

/// Namespace a server's remote tool into the global agent tool name.
///
/// `server` may be any record carrying `id` + `name`; the digest binds the
/// *stable server id* (never the display name) so a renamed server cannot
/// silently remap tool dispatch.
pub fn mcp_agent_tool_name(server_id: &str, server_name: &str, tool_name: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(server_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(tool_name.as_bytes());
    let digest = format!("{:x}", hasher.finalize())[..12].to_string();
    let suffix = format!("_{digest}");
    let readable = format!(
        "{}__{}",
        sanitize_tool_name(if server_name.is_empty() {
            server_id
        } else {
            server_name
        }),
        sanitize_tool_name(tool_name)
    );
    let keep = MCP_AGENT_TOOL_NAME_LIMIT.saturating_sub(suffix.len());
    format!("{}{}", &readable[..readable.len().min(keep)], suffix)
}

/// Fail closed when two namespaced tools resolve to the same agent tool name.
pub fn assert_unique_mcp_agent_tool_names(tools: &[impl AsRef<str>]) -> Result<(), McpError> {
    let mut seen = std::collections::HashSet::new();
    for tool in tools {
        let name = tool.as_ref();
        if !seen.insert(name) {
            return Err(McpError::ToolIdentityCollision(name.to_string()));
        }
    }
    Ok(())
}

/// `isSafeSubagentIdentifier` from renderer/shared/subagent-runs.ts (regex +
/// length portion; the NFKC-normalization and encoding-slice checks are not
/// ported — identifiers accepted here are ASCII-only so they coincide).
pub fn is_safe_subagent_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespacing_matches_ts_format() {
        // Hand-computed against the TS implementation:
        //   digest = sha256("linear\0search_issues")[..12] = "fb4b3e0873c6"
        //   readable = "Linear__search_issues" (under the 64-char cap)
        let name = mcp_agent_tool_name("linear", "Linear", "search_issues");
        assert_eq!(name, "Linear__search_issues_fb4b3e0873c6");
        // Deterministic.
        assert_eq!(
            name,
            mcp_agent_tool_name("linear", "Linear", "search_issues")
        );
    }

    #[test]
    fn namespacing_binds_the_digest_to_the_server_id() {
        // Same display name + same tool, different server ids → the digest
        // differs even though the readable prefix is identical.
        let a = mcp_agent_tool_name("preset-linear", "Linear", "list_issues");
        let other = mcp_agent_tool_name("custom-linear", "Linear", "list_issues");
        assert_ne!(a, other);
        assert_eq!(a.len(), other.len());
        // The TS readable half uses the display name, so renaming the display
        // name does change the name (only the id stays stable in the digest).
        let renamed = mcp_agent_tool_name("preset-linear", "Linear Inc.", "list_issues");
        assert_ne!(a, renamed);
        assert!(renamed.starts_with("Linear_Inc___list_issues_"));
    }

    #[test]
    fn namespacing_sanitizes_unsafe_characters_and_limits_length() {
        let name = mcp_agent_tool_name("a b", "Fancy Tools!", "do.thing#1");
        assert!(!name.contains(' '));
        assert!(!name.contains('#'));
        assert!(!name.contains('.'));
        assert!(name.len() <= MCP_AGENT_TOOL_NAME_LIMIT);
        // A fully-unsafe tool name sanitizes to "___" (TS replaces every
        // character, then falls back to "tool" only when empty).
        let name = mcp_agent_tool_name("srv", "", "!!!");
        assert!(name.starts_with("srv_____"));
    }

    #[test]
    fn identical_readable_prefixes_stay_distinct_through_the_digest() {
        let a = mcp_agent_tool_name("server-one", "Docs", "get");
        let b = mcp_agent_tool_name("server-two", "Docs", "get");
        assert_ne!(a, b);
    }

    #[test]
    fn uniqueness_assertion_rejects_collisions() {
        assert!(assert_unique_mcp_agent_tool_names(&["a", "b"]).is_ok());
        let err = assert_unique_mcp_agent_tool_names(&["a", "a"]).unwrap_err();
        assert_eq!(err, McpError::ToolIdentityCollision("a".into()));
    }

    #[test]
    fn safe_identifier_accepts_dots_underscores_colons_dashes() {
        assert!(is_safe_subagent_identifier("preset-linear"));
        assert!(is_safe_subagent_identifier("a.b_c:d-1"));
        assert!(!is_safe_subagent_identifier(""));
        assert!(!is_safe_subagent_identifier("has space"));
        assert!(!is_safe_subagent_identifier(&"x".repeat(161)));
        assert!(!is_safe_subagent_identifier("emoji😀"));
    }

    #[test]
    fn sanitize_fallback_for_unprintable_input() {
        // Every unsafe char becomes "_" (TS regex replace); the "tool"
        // fallback applies only to the empty result.
        assert_eq!(sanitize_tool_name("!!!"), "___");
        assert_eq!(sanitize_tool_name(""), "tool");
        assert_eq!(sanitize_tool_name("a b"), "a_b");
        assert_eq!(sanitize_tool_name("café"), "caf_");
    }
}
