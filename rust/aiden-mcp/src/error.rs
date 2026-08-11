//! MCP error taxonomy (port of the error surfaces in `main/services/mcp-*.ts`).
//!
//! Every `McpError` message matches the user-facing text the TypeScript code
//! produced, so a later UI pass can reuse the strings verbatim. The two
//! non-overlapping surfaces are:
//!
//! - [`McpError`] — configuration, selection, preset, connection lifecycle,
//!   tool calls, and the OAuth store/operation gate.
//! - [`McpReadError`] — the bounded subagent MCP read proxy
//!   (`subagent-mcp-read.ts` `SubagentMcpReadError`, codes
//!   `invalid_binding | authority_drift | input_too_large | result_too_large |
//!   timed_out | call_failed`).

use thiserror::Error;

/// Umbrella error for the MCP subsystem.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum McpError {
    // --- Selection policy (mcp-selection.ts) ---
    #[error("The approved MCP server \"{0}\" no longer exists.")]
    ApprovedServerMissing(String),
    #[error("MCP server \"{name}\" is disabled.")]
    ApprovedServerDisabled { id: String, name: String },

    // --- Server resolution (mcp.ts makeTransport) ---
    #[error("This MCP server needs a command to run.")]
    MissingCommand,
    #[error("This MCP server needs a URL.")]
    MissingUrl,
    #[error("OAuth applies only to remote (HTTP/SSE) MCP servers.")]
    OAuthOnStdio,
    #[error("Add the server URL before authorizing.")]
    MissingUrlForAuth,

    // --- Presets (mcp-presets.ts assertMcpPresetServer) ---
    #[error("This MCP preset has an invalid identity.")]
    PresetInvalidIdentity,
    #[error("{0} must use its secure HTTP connection.")]
    PresetSecureConnection(String),
    #[error("{0} has an invalid authentication mode.")]
    PresetInvalidAuthMode(String),
    #[error("{0} needs a valid server address.")]
    PresetInvalidUrl(String),
    #[error("{0} credentials can only be sent to its official secure server.")]
    PresetOriginDenied(String),
    #[error("{0} needs an API key — add one in Settings → MCP Servers.")]
    PresetApiKeyMissing(String),

    // --- Connection lifecycle (mcp.ts) ---
    #[error("MCP server \"{name}\" is unavailable: {cause}")]
    Unavailable { name: String, cause: String },
    #[error("The approved MCP servers did not provide any tools.")]
    NoTools,
    #[error("The MCP connection was superseded.")]
    Superseded,
    #[error("The renderer document is no longer active.")]
    DocumentInactive,

    // --- Tool identity + calls (mcp-tool-identity.ts, mcp-tool-result.ts) ---
    #[error("MCP tool identity collision for \"{0}\".")]
    ToolIdentityCollision(String),
    #[error("MCP tool \"{tool}\" on server \"{server}\" timed out after {ms}ms.")]
    ToolTimeout {
        server: String,
        tool: String,
        ms: u64,
    },
    #[error("MCP tool \"{tool}\" on server \"{server}\" failed: {message}")]
    ToolFailed {
        server: String,
        tool: String,
        message: String,
    },
    #[error("MCP read cancelled.")]
    Cancelled,
    #[error("MCP operation {0} timed out after {1}ms.")]
    Timeout(String, u64),

    // --- Config lease epoch fencing (mcp-config-lease.ts) ---
    // A config change reconnects the server and advances the manager's
    // generation; any call/list that started before the change and returned
    // after it is fenced off so a result from a superseded server process can
    // never feed a new-config generation.
    #[error("MCP server configuration changed; the result is stale.")]
    StaleGeneration,

    // --- OAuth store / operation gate (mcp-oauth-operation.ts) ---
    #[error("Authorization is already in progress for this MCP server.")]
    OAuthInProgress,
    #[error("MCP credentials are being updated. Try again in a moment.")]
    OAuthUpdating,
    #[error("MCP authorization is in progress. Try the request again after sign-in.")]
    OAuthStale,
    #[error("MCP authorization was superseded by a config change.")]
    OAuthSuperseded,
    #[error("This MCP server needs sign-in. Open Settings → MCP and click Authorize.")]
    OAuthNeedsSignIn,
    #[error("Sign-in timed out.")]
    OAuthTimeout,
    #[error("Port {0} is busy — close whatever is using it and try again.")]
    OAuthPortBusy(u16),
    #[error("Authorization denied: {0}")]
    OAuthDenied(String),
    #[error("No authorization code was returned.")]
    OAuthNoCode,
    #[error("Missing PKCE code verifier — restart the sign-in.")]
    OAuthMissingVerifier,
    #[error("MCP OAuth session is malformed: {0}")]
    OAuthSessionMalformed(String),
    #[error("MCP OAuth store error: {0}")]
    OAuthStore(String),
    #[error("MCP OAuth request failed: {0}")]
    OAuthRequest(String),

    // --- Transports (rmcp + reqwest) ---
    #[error("MCP transport error: {0}")]
    Transport(String),
    #[error("MCP protocol error: {0}")]
    Protocol(String),
    #[error("MCP HTTP error: {0}")]
    Http(String),
}

impl McpError {
    /// The `SubagentMcpReadError("invalid_binding", ...)` helper.
    pub fn invalid_binding(message: impl Into<String>) -> Self {
        McpError::OAuthSessionMalformed(message.into())
    }
}

/// Bounded read-lane error, mirroring `SubagentMcpReadError` codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpReadErrorCode {
    InvalidBinding,
    AuthorityDrift,
    InputTooLarge,
    ResultTooLarge,
    TimedOut,
    CallFailed,
}

impl McpReadErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            McpReadErrorCode::InvalidBinding => "invalid_binding",
            McpReadErrorCode::AuthorityDrift => "authority_drift",
            McpReadErrorCode::InputTooLarge => "input_too_large",
            McpReadErrorCode::ResultTooLarge => "result_too_large",
            McpReadErrorCode::TimedOut => "timed_out",
            McpReadErrorCode::CallFailed => "call_failed",
        }
    }
}

impl std::fmt::Display for McpReadErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A bounded MCP read failure carrying the machine-readable code the TS side
/// used for authority decisions.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct McpReadError {
    pub code: McpReadErrorCode,
    pub message: String,
}

impl McpReadError {
    pub fn new(code: McpReadErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl McpReadError {
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_errors_preserve_ts_wording() {
        let missing = McpError::ApprovedServerMissing("docs".into());
        assert_eq!(
            missing.to_string(),
            "The approved MCP server \"docs\" no longer exists."
        );
        let disabled = McpError::ApprovedServerDisabled {
            id: "notion".into(),
            name: "Notion".into(),
        };
        assert_eq!(disabled.to_string(), "MCP server \"Notion\" is disabled.");
    }

    #[test]
    fn read_error_codes_match_ts_strings() {
        let err = McpReadError::new(McpReadErrorCode::TimedOut, "approved MCP read timed out");
        assert_eq!(err.code_str(), "timed_out");
        assert_eq!(err.to_string(), "timed_out: approved MCP read timed out");
    }
}
