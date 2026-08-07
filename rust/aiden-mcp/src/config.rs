//! MCP server configuration (port of `main/services/mcp-presets.ts`,
//! `mcp-selection.ts`, and the `makeTransport`/`resolveAuth` halves of
//! `mcp.ts`).
//!
//! This module is pure: resolving a [`McpServer`] record into a
//! connection-ready [`McpServerSpec`] never touches the keychain or the
//! network. The API-key header for preset servers is injected afterwards via
//! [`McpServerSpec::with_preset_api_key`] by the caller that owns secrets
//! (mirroring `resolveAuth` in `mcp.ts`).

use aiden_data::portable_config::{McpServer, McpTransport};
use sha2::{Digest, Sha256};

use crate::McpError;

// ===========================================================================
// Built-in catalog (mcp-presets.ts MCP_PRESETS)
// ===========================================================================

/// Authentication mode for a preset connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpPresetAuth {
    /// Key lives in the encrypted secrets store and is injected as a custom
    /// header at connect time (never in config.json).
    ApiKey {
        header_name: &'static str,
        key_label: &'static str,
        key_help_url: &'static str,
    },
    /// Browser sign-in (PKCE + dynamic client registration).
    OAuth,
}

impl McpPresetAuth {
    pub fn is_oauth(&self) -> bool {
        matches!(self, McpPresetAuth::OAuth)
    }
}

/// One entry of the built-in MCP provider catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub tagline: &'static str,
    pub vendor: &'static str,
    pub transport: McpTransport,
    pub url: &'static str,
    pub auth: McpPresetAuth,
    pub docs_url: &'static str,
}

pub const MCP_PRESETS: [McpPreset; 3] = [
    McpPreset {
        id: "composio",
        name: "Composio",
        tagline: "One key unlocks 500+ app integrations — GitHub, Gmail, Slack, and more.",
        vendor: "By Composio",
        transport: McpTransport::Http,
        url: "https://connect.composio.dev/mcp",
        auth: McpPresetAuth::ApiKey {
            header_name: "x-consumer-api-key",
            key_label: "Composio API key",
            key_help_url: "https://dashboard.composio.dev",
        },
        docs_url: "https://docs.composio.dev",
    },
    McpPreset {
        id: "notion",
        name: "Notion",
        tagline: "Search, read, and update pages and databases in your workspace.",
        vendor: "By Notion",
        transport: McpTransport::Http,
        url: "https://mcp.notion.com/mcp",
        auth: McpPresetAuth::OAuth,
        docs_url: "https://developers.notion.com/docs/get-started-with-mcp",
    },
    McpPreset {
        id: "linear",
        name: "Linear",
        tagline: "Find, create, and update issues, projects, and comments.",
        vendor: "By Linear",
        transport: McpTransport::Http,
        url: "https://mcp.linear.app/mcp",
        auth: McpPresetAuth::OAuth,
        docs_url: "https://linear.app/docs/mcp",
    },
];

/// Origins a preset's credentials may be sent to (TS
/// `MCP_PRESET_ALLOWED_ORIGINS`). Credentials never cross the catalog's exact
/// HTTPS origins.
const MCP_PRESET_ALLOWED_ORIGINS: &[(&str, &[&str])] = &[
    ("composio", &["https://connect.composio.dev"]),
    ("notion", &["https://mcp.notion.com"]),
    ("linear", &["https://mcp.linear.app"]),
];

/// Deterministic server id for a preset, so re-setup maps to the same record
/// and secret.
pub fn preset_server_id(preset_id: &str) -> String {
    format!("preset-{preset_id}")
}

/// Keychain secret id holding a preset's API key (TS `presetSecretId`).
pub fn preset_secret_id(server_id: &str) -> String {
    format!("mcp:{server_id}")
}

pub fn get_mcp_preset(preset_id: &str) -> Option<&'static McpPreset> {
    MCP_PRESETS.iter().find(|preset| preset.id == preset_id)
}

pub fn get_mcp_preset_for_server_id(server_id: &str) -> Option<&'static McpPreset> {
    MCP_PRESETS
        .iter()
        .find(|preset| preset_server_id(preset.id) == server_id)
}

/// The origin of an `http(s)` URL: `scheme://host`, plus whether the URL
/// carried userinfo. Mirrors `new URL(...)` for the fields `assertMcpPresetServer`
/// inspects (protocol, userinfo, origin). `None` = unparseable.
fn url_origin(url: &str) -> Option<UrlOrigin> {
    let (scheme, rest) = url
        .strip_prefix("https://")
        .map(|rest| ("https", rest))
        .or_else(|| url.strip_prefix("http://").map(|rest| ("http", rest)))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    let has_userinfo = authority.contains('@');
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = host.to_ascii_lowercase();
    let host = host.trim_end_matches(':');
    if host.is_empty() {
        return None;
    }
    Some(UrlOrigin {
        scheme: scheme.to_string(),
        host: host.to_string(),
        has_userinfo,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UrlOrigin {
    scheme: String,
    host: String,
    has_userinfo: bool,
}

/// Validate the renderer-authored identity and endpoint before credentials
/// are resolved (TS `assertMcpPresetServer`). Returns the declared preset, or
/// `None` for ordinary custom servers.
pub fn assert_mcp_preset_server(
    server: &McpServer,
) -> Result<Option<&'static McpPreset>, McpError> {
    let id_preset = get_mcp_preset_for_server_id(&server.id);
    let declared_preset = server.preset_id.as_deref().and_then(get_mcp_preset);
    if id_preset.is_none() && server.preset_id.is_none() {
        return Ok(None);
    }
    let (Some(id_preset), Some(declared_preset)) = (id_preset, declared_preset) else {
        return Err(McpError::PresetInvalidIdentity);
    };
    if id_preset.id != declared_preset.id {
        return Err(McpError::PresetInvalidIdentity);
    }
    if server.transport != declared_preset.transport || server.url.is_none() {
        return Err(McpError::PresetSecureConnection(
            declared_preset.name.to_string(),
        ));
    }
    if declared_preset.auth.is_oauth() != server.oauth.unwrap_or(false) {
        return Err(McpError::PresetInvalidAuthMode(
            declared_preset.name.to_string(),
        ));
    }
    let Some(url) = &server.url else {
        return Err(McpError::PresetInvalidUrl(declared_preset.name.to_string()));
    };
    let Some(origin) = url_origin(url) else {
        return Err(McpError::PresetInvalidUrl(declared_preset.name.to_string()));
    };
    let allowed = MCP_PRESET_ALLOWED_ORIGINS
        .iter()
        .find(|(id, _)| *id == declared_preset.id)
        .map(|(_, origins)| *origins)
        .unwrap_or(&[]);
    let origin_string = format!("{}://{}", origin.scheme, origin.host);
    if origin.scheme != "https" || origin.has_userinfo || !allowed.contains(&origin_string.as_str())
    {
        return Err(McpError::PresetOriginDenied(
            declared_preset.name.to_string(),
        ));
    }
    Ok(Some(declared_preset))
}

/// Build the [`McpServer`] record for a preset connection (TS
/// `serverFromPreset`).
pub fn server_from_preset(preset: &McpPreset, url: Option<&str>) -> Result<McpServer, McpError> {
    let trimmed = url.map(str::trim).filter(|u| !u.is_empty());
    let server = McpServer {
        id: preset_server_id(preset.id),
        name: preset.name.to_string(),
        transport: preset.transport,
        command: None,
        args: None,
        env: None,
        url: Some(trimmed.unwrap_or(preset.url).to_string()),
        headers: None,
        oauth: preset.auth.is_oauth().then_some(true),
        preset_id: Some(preset.id.to_string()),
        enabled: true,
    };
    assert_mcp_preset_server(&server)?;
    Ok(server)
}

/// True when the record identifies an API-key preset (`presetId` with an
/// `apiKey` auth mode) — the only case that reads a stored secret.
pub fn preset_requires_api_key(server: &McpServer) -> Result<bool, McpError> {
    Ok(matches!(
        assert_mcp_preset_server(server)?,
        Some(preset) if !preset.auth.is_oauth()
    ))
}

// ===========================================================================
// Selection policy (mcp-selection.ts)
// ===========================================================================

/// Resolve an exact persisted MCP scope against the current configured
/// identities. `None` selects every enabled server (legacy all-server access);
/// an exact list fails closed instead of silently dropping a server.
pub fn selected_mcp_servers<'a>(
    configured: &'a [McpServer],
    server_ids: Option<&[String]>,
) -> Result<Vec<&'a McpServer>, McpError> {
    match server_ids {
        None => Ok(configured.iter().filter(|server| server.enabled).collect()),
        Some(server_ids) => {
            let mut by_id = std::collections::HashMap::new();
            for server in configured {
                by_id.insert(server.id.as_str(), server);
            }
            server_ids
                .iter()
                .map(|id| {
                    let server = by_id
                        .get(id.as_str())
                        .ok_or_else(|| McpError::ApprovedServerMissing(id.clone()))?;
                    if !server.enabled {
                        return Err(McpError::ApprovedServerDisabled {
                            id: server.id.clone(),
                            name: server.name.clone(),
                        });
                    }
                    Ok(*server)
                })
                .collect()
        }
    }
}

// ===========================================================================
// Connection-ready resolution (mcp.ts makeTransport + resolveAuth shape)
// ===========================================================================

/// stdio spawn parameters (command/args/env merged later over the parent env).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioSpec {
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
}

/// Remote (http/sse) connection parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSpec {
    pub url: String,
    pub headers: std::collections::BTreeMap<String, String>,
}

/// A fully validated, connection-ready MCP server.
#[derive(Debug, Clone)]
pub struct McpServerSpec {
    /// The original portable record (unmodified).
    pub server: McpServer,
    pub transport: McpTransport,
    pub stdio: Option<StdioSpec>,
    pub remote: Option<RemoteSpec>,
    /// Present only for built-in preset records.
    pub preset: Option<&'static McpPreset>,
}

impl McpServerSpec {
    /// Inject a preset API key as its auth header (TS `resolveAuth`). Callers
    /// resolve the key from the encrypted secrets store by
    /// [`preset_secret_id`] and bind it to the server id.
    pub fn with_preset_api_key(mut self, key: String) -> Result<Self, McpError> {
        let preset = self.preset.ok_or(McpError::PresetInvalidIdentity)?;
        let header = match preset.auth {
            McpPresetAuth::ApiKey { header_name, .. } => header_name,
            McpPresetAuth::OAuth => {
                return Err(McpError::PresetInvalidAuthMode(preset.name.to_string()));
            }
        };
        let remote = self
            .remote
            .as_mut()
            .ok_or(McpError::PresetOriginDenied(preset.name.to_string()))?;
        remote.headers.insert(header.to_string(), key);
        Ok(self)
    }

    /// Whether this spec needs a keychain-held API key before connecting.
    pub fn requires_preset_api_key(&self) -> bool {
        matches!(
            self.preset,
            Some(preset) if !preset.auth.is_oauth()
        )
    }

    /// The authorization binding for OAuth sessions (normalized resource URL).
    pub fn authorization_binding(&self) -> Option<String> {
        self.remote
            .as_ref()
            .map(|remote| crate::oauth::mcp_authorization_binding(&remote.url))
    }
}

/// Validate a portable record into connection-ready form. Preset identity is
/// asserted here; the preset API key (if any) is injected later.
pub fn resolve_mcp_server(server: &McpServer) -> Result<McpServerSpec, McpError> {
    let preset = assert_mcp_preset_server(server)?;
    match server.transport {
        McpTransport::Stdio => {
            let Some(command) = server.command.clone() else {
                return Err(McpError::MissingCommand);
            };
            Ok(McpServerSpec {
                server: server.clone(),
                transport: McpTransport::Stdio,
                stdio: Some(StdioSpec {
                    command,
                    args: server.args.clone().unwrap_or_default(),
                    env: server.env.clone().unwrap_or_default(),
                }),
                remote: None,
                preset,
            })
        }
        McpTransport::Http | McpTransport::Sse => {
            let Some(url) = server.url.clone() else {
                return Err(McpError::MissingUrl);
            };
            Ok(McpServerSpec {
                server: server.clone(),
                transport: server.transport,
                stdio: None,
                remote: Some(RemoteSpec {
                    url,
                    headers: server.headers.clone().unwrap_or_default(),
                }),
                preset,
            })
        }
    }
}

// ===========================================================================
// Connection snapshots (mcp-credential-cleanup-core.ts)
// ===========================================================================

/// sha256 of the canonical (sorted-key) JSON of a string map — the
/// `secretMapHash` used for env/headers so snapshots never embed secrets.
pub fn secret_map_hash(entries: &std::collections::BTreeMap<String, String>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        serde_json::to_string(entries)
            .unwrap_or_default()
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

/// `mcpCredentialConnectionSnapshot` — every field that can affect runtime
/// admission or the resulting tool surface, with secret maps reduced to
/// hashes. Serialized with sorted keys for canonical comparison.
pub fn credential_connection_snapshot(server: &McpServer) -> serde_json::Value {
    let mut record = serde_json::Map::new();
    record.insert("id".into(), serde_json::Value::String(server.id.clone()));
    record.insert(
        "transport".into(),
        serde_json::Value::String(
            match server.transport {
                McpTransport::Stdio => "stdio",
                McpTransport::Http => "http",
                McpTransport::Sse => "sse",
            }
            .into(),
        ),
    );
    let mut insert_if = |key: &str, value: Option<serde_json::Value>| {
        if let Some(value) = value {
            record.insert(key.into(), value);
        }
    };
    insert_if("url", server.url.clone().map(serde_json::Value::String));
    insert_if(
        "command",
        server.command.clone().map(serde_json::Value::String),
    );
    insert_if(
        "args",
        server.args.clone().map(|args| {
            serde_json::Value::Array(args.into_iter().map(serde_json::Value::String).collect())
        }),
    );
    insert_if(
        "envHash",
        server
            .env
            .as_ref()
            .map(|env| serde_json::Value::String(secret_map_hash(env))),
    );
    insert_if(
        "headersHash",
        server
            .headers
            .as_ref()
            .map(|headers| serde_json::Value::String(secret_map_hash(headers))),
    );
    insert_if("oauth", server.oauth.map(serde_json::Value::Bool));
    insert_if(
        "presetId",
        server.preset_id.clone().map(serde_json::Value::String),
    );
    serde_json::Value::Object(record)
}

/// `mcpRuntimeConnectionSnapshot` — credential snapshot plus the display
/// identity, which also participates in the connection fingerprint.
pub fn runtime_connection_snapshot(server: &McpServer) -> serde_json::Value {
    let mut record = match credential_connection_snapshot(server) {
        serde_json::Value::Object(record) => record,
        _ => serde_json::Map::new(),
    };
    record.insert(
        "name".into(),
        serde_json::Value::String(server.name.clone()),
    );
    record.insert("enabled".into(), serde_json::Value::Bool(server.enabled));
    serde_json::Value::Object(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, transport: McpTransport, enabled: bool) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.to_string(),
            transport,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
            oauth: None,
            preset_id: None,
            enabled,
        }
    }

    #[test]
    fn catalog_entries_are_well_formed() {
        assert!(MCP_PRESETS.len() >= 3, "expected composio, notion, linear");
        let ids: std::collections::HashSet<_> = MCP_PRESETS.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), MCP_PRESETS.len(), "preset ids must be unique");
        for preset in &MCP_PRESETS {
            assert!(preset
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
            assert!(!preset.name.is_empty());
            assert!(!preset.tagline.is_empty());
            assert!(preset.vendor.starts_with("By "));
            assert_eq!(preset.transport, McpTransport::Http);
            assert!(preset.url.starts_with("https://"));
            assert!(preset.docs_url.starts_with("https://"));
            if let McpPresetAuth::ApiKey {
                header_name,
                key_label,
                key_help_url,
            } = preset.auth
            {
                assert!(!header_name.is_empty());
                assert!(!key_label.is_empty());
                assert!(key_help_url.starts_with("https://"));
            }
        }
    }

    #[test]
    fn catalog_includes_composio_api_key_and_oauth_pair() {
        let composio = get_mcp_preset("composio").unwrap();
        assert!(!composio.auth.is_oauth());
        assert_eq!(
            composio.auth,
            McpPresetAuth::ApiKey {
                header_name: "x-consumer-api-key",
                key_label: "Composio API key",
                key_help_url: "https://dashboard.composio.dev",
            }
        );
        assert!(get_mcp_preset("notion").unwrap().auth.is_oauth());
        assert!(get_mcp_preset("linear").unwrap().auth.is_oauth());
        assert_eq!(get_mcp_preset("nope"), None);
    }

    #[test]
    fn preset_ids_and_secret_ids_are_deterministic() {
        assert_eq!(preset_server_id("composio"), "preset-composio");
        assert_eq!(preset_secret_id("preset-composio"), "mcp:preset-composio");
        assert_eq!(
            get_mcp_preset_for_server_id("preset-notion").unwrap().id,
            "notion"
        );
        assert_eq!(get_mcp_preset_for_server_id("notion"), None);
    }

    #[test]
    fn server_from_preset_builds_an_enabled_http_server() {
        let composio = get_mcp_preset("composio").unwrap();
        let built = server_from_preset(composio, None).unwrap();
        assert_eq!(built.id, "preset-composio");
        assert_eq!(built.name, "Composio");
        assert_eq!(built.transport, McpTransport::Http);
        assert_eq!(
            built.url.as_deref(),
            Some("https://connect.composio.dev/mcp")
        );
        assert_eq!(built.oauth, None);
        assert_eq!(built.preset_id.as_deref(), Some("composio"));
        assert!(built.enabled);
    }

    #[test]
    fn server_from_preset_sets_oauth_and_trim() {
        let notion = get_mcp_preset("notion").unwrap();
        let server =
            server_from_preset(notion, Some("  https://mcp.notion.com/mcp/session/abc  ")).unwrap();
        assert_eq!(server.oauth, Some(true));
        assert_eq!(
            server.url.as_deref(),
            Some("https://mcp.notion.com/mcp/session/abc")
        );
        // Blank url falls back to the preset default.
        let fallback = server_from_preset(notion, Some("   ")).unwrap();
        assert_eq!(fallback.url.as_deref(), Some(notion.url));
        // Origin outside the allow-list is rejected.
        let err = server_from_preset(notion, Some("https://attacker.invalid/mcp")).unwrap_err();
        assert!(matches!(err, McpError::PresetOriginDenied(_)));
    }

    #[test]
    fn preset_validation_binds_credentials_to_exact_identities() {
        let composio = get_mcp_preset("composio").unwrap();
        let valid = server_from_preset(
            composio,
            Some("https://connect.composio.dev/mcp/session/abc"),
        )
        .unwrap();
        assert_eq!(
            assert_mcp_preset_server(&valid).unwrap().unwrap().id,
            "composio"
        );

        // Custom servers are untouched.
        let custom = server("custom", McpTransport::Http, true);
        assert_eq!(assert_mcp_preset_server(&custom).unwrap(), None);

        let mut tampered = valid.clone();
        tampered.id = "preset-notion".into();
        assert_eq!(
            assert_mcp_preset_server(&tampered).unwrap_err(),
            McpError::PresetInvalidIdentity
        );

        let mut missing_declaration = valid.clone();
        missing_declaration.preset_id = None;
        assert_eq!(
            assert_mcp_preset_server(&missing_declaration).unwrap_err(),
            McpError::PresetInvalidIdentity
        );

        let mut unknown_preset = valid.clone();
        unknown_preset.preset_id = Some("unknown".into());
        assert_eq!(
            assert_mcp_preset_server(&unknown_preset).unwrap_err(),
            McpError::PresetInvalidIdentity
        );

        let mut http_url = valid.clone();
        http_url.url = Some("http://connect.composio.dev/mcp".into());
        assert_eq!(
            assert_mcp_preset_server(&http_url).unwrap_err(),
            McpError::PresetOriginDenied("Composio".into())
        );

        let mut evil = valid.clone();
        evil.url = Some("https://connect.composio.dev.evil.test/mcp".into());
        assert_eq!(
            assert_mcp_preset_server(&evil).unwrap_err(),
            McpError::PresetOriginDenied("Composio".into())
        );

        let mut userinfo = valid.clone();
        userinfo.url = Some("https://user:pass@connect.composio.dev/mcp".into());
        assert_eq!(
            assert_mcp_preset_server(&userinfo).unwrap_err(),
            McpError::PresetOriginDenied("Composio".into())
        );

        let mut wrong_transport = valid.clone();
        wrong_transport.transport = McpTransport::Sse;
        assert_eq!(
            assert_mcp_preset_server(&wrong_transport).unwrap_err(),
            McpError::PresetSecureConnection("Composio".into())
        );

        let mut wrong_auth = valid.clone();
        wrong_auth.oauth = Some(true);
        assert_eq!(
            assert_mcp_preset_server(&wrong_auth).unwrap_err(),
            McpError::PresetInvalidAuthMode("Composio".into())
        );
    }

    #[test]
    fn oauth_presets_require_oauth_and_api_key_presets_reject_it() {
        let notion = get_mcp_preset("notion").unwrap();
        let notion_server = server_from_preset(notion, None).unwrap();
        assert_eq!(
            assert_mcp_preset_server(&notion_server)
                .unwrap()
                .unwrap()
                .auth,
            McpPresetAuth::OAuth
        );
        let mut no_oauth = notion_server.clone();
        no_oauth.oauth = None;
        assert_eq!(
            assert_mcp_preset_server(&no_oauth).unwrap_err(),
            McpError::PresetInvalidAuthMode("Notion".into())
        );
    }

    #[test]
    fn selection_exact_scope_never_inherits_later_enabled_servers() {
        let gmail = McpServer {
            url: Some("https://example.test".into()),
            ..server("gmail", McpTransport::Http, true)
        };
        let notion = McpServer {
            url: Some("https://example.test".into()),
            ..server("notion", McpTransport::Http, false)
        };
        let configured = vec![gmail.clone(), notion.clone()];

        let selected = selected_mcp_servers(&configured, Some(&["gmail".into()])).unwrap();
        let ids: Vec<_> = selected.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["gmail"]);

        let more = vec![
            gmail.clone(),
            McpServer {
                id: "slack".into(),
                name: "Slack".into(),
                ..gmail.clone()
            },
        ];
        let selected = selected_mcp_servers(&more, Some(&["gmail".into()])).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "gmail");

        assert!(selected_mcp_servers(&configured, Some(&[]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn selection_legacy_all_server_access_stays_enabled_only_and_fails_closed() {
        let gmail = McpServer {
            url: Some("https://example.test".into()),
            ..server("gmail", McpTransport::Http, true)
        };
        let notion = McpServer {
            url: Some("https://example.test".into()),
            ..server("notion", McpTransport::Http, false)
        };
        let configured = vec![gmail, notion];

        let ids: Vec<_> = selected_mcp_servers(&configured, None)
            .unwrap()
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(ids, ["gmail"]);

        let err = selected_mcp_servers(&configured, Some(&["notion".into()])).unwrap_err();
        assert!(matches!(err, McpError::ApprovedServerDisabled { .. }));

        let err = selected_mcp_servers(&configured, Some(&["missing".into()])).unwrap_err();
        assert!(matches!(err, McpError::ApprovedServerMissing(_)));
    }

    #[test]
    fn resolution_requires_command_for_stdio_and_url_for_remote() {
        let mut stdio = server("local", McpTransport::Stdio, true);
        assert_eq!(
            resolve_mcp_server(&stdio).unwrap_err(),
            McpError::MissingCommand
        );
        stdio.command = Some("npx".into());
        stdio.args = Some(vec!["-y".into(), "server".into()]);
        let spec = resolve_mcp_server(&stdio).unwrap();
        assert_eq!(spec.stdio.as_ref().unwrap().command, "npx");
        assert_eq!(spec.stdio.as_ref().unwrap().args, vec!["-y", "server"]);

        let http = server("remote", McpTransport::Http, true);
        assert_eq!(resolve_mcp_server(&http).unwrap_err(), McpError::MissingUrl);
    }

    #[test]
    fn resolution_injects_preset_api_key_into_the_header_map() {
        let composio = get_mcp_preset("composio").unwrap();
        let server = server_from_preset(composio, None).unwrap();
        let spec = resolve_mcp_server(&server).unwrap();
        assert!(spec.requires_preset_api_key());
        let spec = spec.with_preset_api_key("secret-key".into()).unwrap();
        assert_eq!(
            spec.remote
                .as_ref()
                .unwrap()
                .headers
                .get("x-consumer-api-key")
                .map(String::as_str),
            Some("secret-key")
        );

        // OAuth presets refuse key injection.
        let notion = get_mcp_preset("notion").unwrap();
        let notion_server = server_from_preset(notion, None).unwrap();
        let spec = resolve_mcp_server(&notion_server).unwrap();
        assert!(!spec.requires_preset_api_key());
        assert!(spec.with_preset_api_key("k".into()).is_err());
    }

    #[test]
    fn connection_snapshots_hash_secret_maps() {
        let mut stdio = server("local", McpTransport::Stdio, true);
        stdio.command = Some("run".into());
        stdio.args = Some(vec!["--flag".into()]);
        let mut env = std::collections::BTreeMap::new();
        env.insert("TOKEN".into(), "super-secret".into());
        env.insert("A".into(), "1".into());
        stdio.env = Some(env.clone());

        let snapshot = credential_connection_snapshot(&stdio);
        assert_eq!(snapshot["id"], "local");
        assert_eq!(snapshot["command"], "run");
        assert_eq!(snapshot["args"][0], "--flag");
        assert_eq!(
            snapshot["envHash"],
            secret_map_hash(&env).as_str(),
            "env must be reduced to a hash, never inline"
        );
        assert!(snapshot.get("url").is_none());

        // Deterministic: same input, same hash.
        let again = credential_connection_snapshot(&stdio);
        assert_eq!(snapshot, again);

        let runtime = runtime_connection_snapshot(&stdio);
        assert_eq!(runtime["name"], "local");
        assert_eq!(runtime["enabled"], true);
    }
}
