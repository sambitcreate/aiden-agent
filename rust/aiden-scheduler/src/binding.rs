//! Port of `main/services/schedule-mcp-binding.ts` and
//! `main/services/schedule-provider-binding.ts` — exact connection fingerprints
//! that pin an approved automation to the connection properties that choose the
//! inference recipient.
//!
//! Fingerprints are sha256 hex digests over a canonical JSON snapshot whose key
//! order matches `JSON.stringify` insertion order (not serde's default
//! alphabetical `Map` order), so digests stay byte-identical to the Electron
//! app's persisted `mcpServerBindings` / `providerFingerprint` values.

use aiden_data::schedule_store::ScheduledMcpServerBinding;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::tool::ToolError;

/// `McpTransport`
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// The `McpServer` record subset the runtime fingerprint uses
/// (`main/services/types.ts` `McpServer`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub enabled: bool,
}

/// The `StoredProvider` fields the provider fingerprint uses
/// (`main/services/types.ts` `StoredProvider`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProviderLike {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
}

/// `SCHEDULED_PROVIDER_FINGERPRINT` — 64 lowercase hex chars.
pub fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `secretMapHash` — sha256 of the canonical JSON of a sorted string map.
fn secret_map_hash(map: &std::collections::BTreeMap<String, String>) -> String {
    let sorted: std::collections::BTreeMap<&String, &String> = map.iter().collect();
    let mut json = String::from("{");
    for (index, (key, value)) in sorted.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str(&serde_json::to_string(key).unwrap_or_default());
        json.push(':');
        json.push_str(&serde_json::to_string(value).unwrap_or_default());
    }
    json.push('}');
    sha256_hex(&json)
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The connection snapshot that participates in the runtime fingerprint
/// (`mcpRuntimeConnectionSnapshot`), rendered as the exact `JSON.stringify`
/// key order.
fn mcp_runtime_connection_snapshot_json(server: &McpServer) -> String {
    let mut json = String::from("{");
    let mut first = true;
    let mut push = |json: &mut String, key: &str, value: String| {
        if !first {
            json.push(',');
        }
        first = false;
        json.push_str(&quoted(key));
        json.push(':');
        json.push_str(&value);
    };
    push(&mut json, "id", quoted(&server.id));
    push(
        &mut json,
        "transport",
        quoted(match server.transport {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
            McpTransport::Sse => "sse",
        }),
    );
    if let Some(url) = &server.url {
        push(&mut json, "url", quoted(url));
    }
    if let Some(command) = &server.command {
        push(&mut json, "command", quoted(command));
    }
    if let Some(args) = &server.args {
        push(
            &mut json,
            "args",
            serde_json::to_string(args).unwrap_or_default(),
        );
    }
    if let Some(env) = &server.env {
        push(&mut json, "envHash", quoted(&secret_map_hash(env)));
    }
    if let Some(headers) = &server.headers {
        push(&mut json, "headersHash", quoted(&secret_map_hash(headers)));
    }
    if let Some(oauth) = server.oauth {
        push(
            &mut json,
            "oauth",
            if oauth { "true" } else { "false" }.to_string(),
        );
    }
    if let Some(preset_id) = &server.preset_id {
        push(&mut json, "presetId", quoted(preset_id));
    }
    push(&mut json, "name", quoted(&server.name));
    push(
        &mut json,
        "enabled",
        if server.enabled { "true" } else { "false" }.to_string(),
    );
    json.push('}');
    json
}

/// `scheduledMcpServerBinding` — the exact immutable binding for a server.
pub fn scheduled_mcp_server_binding(server: &McpServer) -> ScheduledMcpServerBinding {
    ScheduledMcpServerBinding {
        id: server.id.clone(),
        fingerprint: sha256_hex(&mcp_runtime_connection_snapshot_json(server)),
    }
}

/// `validateScheduledMcpServerBindings` — shape-only validation of the
/// persisted/approved binding array. (Re-exported here so the tool module has
/// one validation entry point; the storage-side validation lives in
/// `aiden-data::schedule_store`.)
pub fn validate_scheduled_mcp_server_bindings(
    value: Option<&Value>,
) -> Result<Option<Vec<ScheduledMcpServerBinding>>, ToolError> {
    aiden_data::schedule_store::validate_scheduled_mcp_server_bindings(value)
        .map_err(|error| ToolError::message(error.to_string()))
}

/// `assertScheduledMcpServerBindings` — the currently computed bindings must
/// match the ones approved when the automation was confirmed.
pub fn assert_scheduled_mcp_server_bindings(
    servers: &[McpServer],
    bindings: &[ScheduledMcpServerBinding],
) -> Result<(), ToolError> {
    let mismatch = servers.len() != bindings.len()
        || servers.iter().enumerate().any(|(index, server)| {
            let actual = scheduled_mcp_server_binding(server);
            bindings
                .get(index)
                .map(|expected| {
                    expected.id != actual.id || expected.fingerprint != actual.fingerprint
                })
                .unwrap_or(true)
        });
    if mismatch {
        return Err(ToolError::message(
            "An approved MCP server changed after this automation was confirmed. Review and approve its connector scope again.",
        ));
    }
    Ok(())
}

/// `scheduledProviderFingerprint` — the provider connection properties that
/// choose the inference recipient.
pub fn scheduled_provider_fingerprint(provider: &StoredProviderLike) -> String {
    let mut json = String::from("{");
    json.push_str(&quoted("id"));
    json.push(':');
    json.push_str(&quoted(&provider.id));
    json.push(',');
    json.push_str(&quoted("kind"));
    json.push(':');
    json.push_str(&quoted(&provider.kind));
    json.push(',');
    json.push_str(&quoted("label"));
    json.push(':');
    json.push_str(&quoted(&provider.label));
    json.push(',');
    json.push_str(&quoted("baseUrl"));
    json.push(':');
    json.push_str(&quoted(&provider.base_url));
    json.push(',');
    json.push_str(&quoted("needsKey"));
    json.push(':');
    json.push_str(if provider.needs_key { "true" } else { "false" });
    json.push(',');
    json.push_str(&quoted("deployment"));
    json.push(':');
    match &provider.deployment {
        Some(deployment) => json.push_str(&quoted(deployment)),
        None => json.push_str("null"),
    }
    json.push(',');
    json.push_str(&quoted("isBuiltin"));
    json.push(':');
    json.push_str(if provider.is_builtin == Some(true) {
        "true"
    } else {
        "false"
    });
    json.push('}');
    sha256_hex(&json)
}

/// `assertScheduledProviderFingerprint` — fail closed when the approved
/// provider connection changed.
pub fn assert_scheduled_provider_fingerprint(
    provider: &StoredProviderLike,
    expected: Option<&str>,
) -> Result<(), ToolError> {
    match expected {
        Some(expected) if scheduled_provider_fingerprint(provider) == expected => Ok(()),
        _ => Err(ToolError::message(
            "The approved provider connection changed after this automation was confirmed. Review and approve its provider and model again.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn gmail_server() -> McpServer {
        McpServer {
            id: "gmail".into(),
            name: "Gmail".into(),
            transport: McpTransport::Http,
            url: Some("https://example.test/mcp".into()),
            command: None,
            args: None,
            env: None,
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        }
    }

    #[test]
    fn binding_is_sha256_hex_and_stable() {
        let binding = scheduled_mcp_server_binding(&gmail_server());
        assert_eq!(binding.id, "gmail");
        assert!(is_hex64(&binding.fingerprint));
        assert_eq!(
            binding,
            scheduled_mcp_server_binding(&gmail_server()),
            "same record yields the same fingerprint"
        );
    }

    #[test]
    fn binding_changes_when_the_connection_changes() {
        let original = scheduled_mcp_server_binding(&gmail_server());
        let moved = scheduled_mcp_server_binding(&McpServer {
            url: Some("https://replacement.test/mcp".into()),
            ..gmail_server()
        });
        assert_ne!(original.fingerprint, moved.fingerprint);
        let renamed = scheduled_mcp_server_binding(&McpServer {
            name: "Gmail (secondary)".into(),
            ..gmail_server()
        });
        assert_ne!(original.fingerprint, renamed.fingerprint);
        let disabled = scheduled_mcp_server_binding(&McpServer {
            enabled: false,
            ..gmail_server()
        });
        assert_ne!(original.fingerprint, disabled.fingerprint);
    }

    #[test]
    fn env_hash_is_order_independent() {
        let mut first = BTreeMap::new();
        first.insert("a".into(), "1".into());
        first.insert("b".into(), "2".into());
        let mut second = BTreeMap::new();
        second.insert("b".into(), "2".into());
        second.insert("a".into(), "1".into());
        let left = scheduled_mcp_server_binding(&McpServer {
            env: Some(first),
            ..gmail_server()
        });
        let right = scheduled_mcp_server_binding(&McpServer {
            env: Some(second),
            ..gmail_server()
        });
        assert_eq!(left.fingerprint, right.fingerprint);
    }

    #[test]
    fn assert_bindings_rejects_changed_servers() {
        let server = gmail_server();
        let binding = scheduled_mcp_server_binding(&server);
        assert!(assert_scheduled_mcp_server_bindings(
            std::slice::from_ref(&server),
            std::slice::from_ref(&binding)
        )
        .is_ok());
        let changed = McpServer {
            url: Some("https://replacement.test/mcp".into()),
            ..server.clone()
        };
        let error = assert_scheduled_mcp_server_bindings(&[changed], &[binding]).unwrap_err();
        assert!(error.message.contains("changed after this automation"));
    }

    #[test]
    fn provider_fingerprint_covers_connection_properties() {
        let provider = StoredProviderLike {
            id: "anthropic".into(),
            kind: "anthropic".into(),
            label: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            needs_key: true,
            deployment: None,
            is_builtin: Some(true),
        };
        let fingerprint = scheduled_provider_fingerprint(&provider);
        assert!(is_hex64(&fingerprint));
        let changed_url = StoredProviderLike {
            base_url: "https://example.test/v1".into(),
            ..provider.clone()
        };
        assert_ne!(fingerprint, scheduled_provider_fingerprint(&changed_url));
        let changed_builtin = StoredProviderLike {
            is_builtin: None,
            ..provider.clone()
        };
        assert_ne!(
            fingerprint,
            scheduled_provider_fingerprint(&changed_builtin)
        );
    }

    #[test]
    fn provider_fingerprint_omits_models_and_labels_beyond_contract() {
        let provider = StoredProviderLike {
            id: "x".into(),
            kind: "k".into(),
            label: "X".into(),
            base_url: "https://x.test".into(),
            needs_key: false,
            deployment: Some("local".into()),
            is_builtin: None,
        };
        let without_deployment = StoredProviderLike {
            deployment: None,
            ..provider.clone()
        };
        assert_ne!(
            scheduled_provider_fingerprint(&provider),
            scheduled_provider_fingerprint(&without_deployment)
        );
    }
}
