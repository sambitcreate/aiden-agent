//! Transactional MCP credential cleanup — port of
//! `main/services/mcp-credential-cleanup-core.ts`.
//!
//! Preset-key replacement and OAuth-token removal are journaled so a crash
//! between "config landed" and "credentials cleared" can be reconciled at
//! startup. Every rule here is pure: snapshots hash secret maps (never the
//! secrets), journals are strict/bounded, and the cleanup decision is derived
//! from the *current* portable config inside mutation admission.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use aiden_data::portable_config::{McpServer, McpTransport};

/// `McpCredentialConnectionSnapshot` — every field that can affect credential
/// admission (URLs, commands, secret-map digests, auth mode, preset origin).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCredentialConnectionSnapshot {
    pub id: String,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}

/// `McpRuntimeConnectionSnapshot` — the credential snapshot plus the
/// non-secret fields that affect runtime admission and the tool surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeConnectionSnapshot {
    #[serde(flatten)]
    pub connection: McpCredentialConnectionSnapshot,
    pub name: String,
    pub enabled: bool,
}

/// `PendingMcpCredentialCleanupV1` — the journal record written before a
/// credential-affecting MCP config mutation lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMcpCredentialCleanupV1 {
    pub version: u8,
    pub kind: McpCredentialCleanupKind,
    pub server_id: String,
    pub previous: Option<McpCredentialConnectionSnapshot>,
    pub target: Option<McpCredentialConnectionSnapshot>,
}

/// The journaled mutation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpCredentialCleanupKind {
    Remove,
    #[serde(rename = "disable-oauth")]
    DisableOauth,
    Replace,
}

/// `McpCredentialCleanupResolution` — what a reconciliation must clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCredentialCleanupResolution {
    NotResolved,
    Resolved {
        clear_oauth: bool,
        clear_preset_key: bool,
    },
}

/// Strict validation failure for a pending-cleanup journal or snapshot.
#[derive(Debug, thiserror::Error)]
#[error("Invalid pending MCP credential cleanup.")]
pub struct InvalidPendingMcpCredentialCleanup;

/// `secretMapHash` — sha-256 over the canonical (sorted-key) JSON of a secret
/// map. Secrets never leave the keychain; only the digest lands in journals.
pub fn secret_map_hash(value: &BTreeMap<String, String>) -> String {
    let canonical = serde_json::to_string(value).unwrap_or_default();
    hex_sha256(canonical.as_bytes())
}

fn hex_sha256(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

/// `mcpCredentialConnectionSnapshot` — project a server record into its
/// credential-affecting identity.
pub fn mcp_credential_connection_snapshot(server: &McpServer) -> McpCredentialConnectionSnapshot {
    McpCredentialConnectionSnapshot {
        id: server.id.clone(),
        transport: server.transport,
        url: server.url.clone(),
        command: server.command.clone(),
        args: server.args.clone(),
        env_hash: server.env.as_ref().map(secret_map_hash),
        headers_hash: server.headers.as_ref().map(secret_map_hash),
        oauth: server.oauth,
        preset_id: server.preset_id.clone(),
    }
}

/// `mcpRuntimeConnectionSnapshot` — the credential snapshot plus name/enabled.
pub fn mcp_runtime_connection_snapshot(server: &McpServer) -> McpRuntimeConnectionSnapshot {
    McpRuntimeConnectionSnapshot {
        connection: mcp_credential_connection_snapshot(server),
        name: server.name.clone(),
        enabled: server.enabled,
    }
}

/// `sameMcpCredentialConnection` — structural equality of two snapshots
/// (both absent compares equal).
pub fn same_mcp_credential_connection(
    left: Option<&McpCredentialConnectionSnapshot>,
    right: Option<&McpCredentialConnectionSnapshot>,
) -> bool {
    left == right
}

/// `sameMcpRuntimeConnection` — runtime-admission equality.
pub fn same_mcp_runtime_connection(
    left: Option<&McpRuntimeConnectionSnapshot>,
    right: Option<&McpRuntimeConnectionSnapshot>,
) -> bool {
    left == right
}

/// `replaceMcpCredentialAfterDisconnect` — preset-key replacement must wait for
/// connection invalidation, then mutate.
pub async fn replace_mcp_credential_after_disconnect<R>(
    disconnect: impl std::future::Future<Output = ()>,
    replace: impl std::future::Future<Output = R>,
) -> R {
    disconnect.await;
    replace.await
}

fn is_snapshot_record(value: &Value) -> Result<(), InvalidPendingMcpCredentialCleanup> {
    if value.is_null() {
        return Ok(());
    }
    let Some(record) = value.as_object() else {
        return Err(InvalidPendingMcpCredentialCleanup);
    };
    const ALLOWED: &[&str] = &[
        "id",
        "transport",
        "url",
        "command",
        "args",
        "envHash",
        "headersHash",
        "oauth",
        "presetId",
    ];
    for key in record.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            return Err(InvalidPendingMcpCredentialCleanup);
        }
    }
    let valid_transport = matches!(
        record.get("transport").and_then(Value::as_str),
        Some("stdio" | "http" | "sse")
    );
    let valid_url = record
        .get("url")
        .map(|value| {
            value
                .as_str()
                .is_some_and(|value| value.len() <= 4096 && !value.chars().any(char::is_control))
        })
        .unwrap_or(true);
    let valid_command = record
        .get("command")
        .map(|value| {
            value
                .as_str()
                .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
        })
        .unwrap_or(true);
    let valid_args = record
        .get("args")
        .map(|value| {
            value.as_array().is_some_and(|entries| {
                entries.len() <= 128
                    && entries.iter().all(|entry| {
                        entry
                            .as_str()
                            .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
                    })
            })
        })
        .unwrap_or(true);
    let valid_env_hash = record
        .get("envHash")
        .map(|value| value.as_str().is_some_and(is_hex64))
        .unwrap_or(true);
    let valid_headers_hash = record
        .get("headersHash")
        .map(|value| value.as_str().is_some_and(is_hex64))
        .unwrap_or(true);
    let valid_oauth = record
        .get("oauth")
        .map(|value| value.is_boolean())
        .unwrap_or(true);
    let valid_preset_id = record
        .get("presetId")
        .map(|value| {
            value
                .as_str()
                .is_some_and(|value| value.len() <= 256 && !value.chars().any(char::is_control))
        })
        .unwrap_or(true);
    let valid_id = record
        .get("id")
        .map(|value| {
            value.as_str().is_some_and(|value| {
                !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
            })
        })
        .unwrap_or(false);
    if !(valid_transport
        && valid_url
        && valid_command
        && valid_args
        && valid_env_hash
        && valid_headers_hash
        && valid_oauth
        && valid_preset_id
        && valid_id)
    {
        return Err(InvalidPendingMcpCredentialCleanup);
    }
    Ok(())
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `parseSnapshot` — strict journal-side snapshot parsing; `null` maps to
/// `None`, anything else must be a bounded well-formed record.
pub fn parse_snapshot(
    value: &Value,
) -> Result<Option<McpCredentialConnectionSnapshot>, InvalidPendingMcpCredentialCleanup> {
    is_snapshot_record(value)?;
    if value.is_null() {
        return Ok(None);
    }
    let record = value
        .as_object()
        .ok_or(InvalidPendingMcpCredentialCleanup)?;
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .ok_or(InvalidPendingMcpCredentialCleanup)?;
    let transport = record
        .get("transport")
        .and_then(Value::as_str)
        .ok_or(InvalidPendingMcpCredentialCleanup)?;
    let args = match record.get("args") {
        Some(Value::Array(entries)) => Some(
            entries
                .iter()
                .map(|entry| {
                    entry
                        .as_str()
                        .map(str::to_string)
                        .ok_or(InvalidPendingMcpCredentialCleanup)
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
        Some(_) => return Err(InvalidPendingMcpCredentialCleanup),
    };
    Ok(Some(McpCredentialConnectionSnapshot {
        id: id.to_string(),
        transport: match transport {
            "stdio" => McpTransport::Stdio,
            "http" => McpTransport::Http,
            "sse" => McpTransport::Sse,
            _ => return Err(InvalidPendingMcpCredentialCleanup),
        },
        url: record
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        command: record
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        args,
        env_hash: record
            .get("envHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        headers_hash: record
            .get("headersHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        oauth: record.get("oauth").and_then(Value::as_bool),
        preset_id: record
            .get("presetId")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

/// `pendingMcpCredentialCleanupForSave` — derive the journal intent for a save
/// mutation. `None` when the mutation does not touch credentials.
pub fn pending_mcp_credential_cleanup_for_save(
    current: Option<&McpServer>,
    target_server: &McpServer,
) -> Option<PendingMcpCredentialCleanupV1> {
    let current = current?;
    let previous = mcp_credential_connection_snapshot(current);
    let target = mcp_credential_connection_snapshot(target_server);
    if same_mcp_credential_connection(Some(&previous), Some(&target)) {
        return None;
    }
    Some(PendingMcpCredentialCleanupV1 {
        version: 1,
        kind: if current.oauth == Some(true) && target_server.oauth != Some(true) {
            McpCredentialCleanupKind::DisableOauth
        } else {
            McpCredentialCleanupKind::Replace
        },
        server_id: target_server.id.clone(),
        previous: Some(previous),
        target: Some(target),
    })
}

/// `pendingMcpCredentialCleanupForRemove` — the journal intent for a removal.
pub fn pending_mcp_credential_cleanup_for_remove(
    current: Option<&McpServer>,
    server_id: &str,
) -> Option<PendingMcpCredentialCleanupV1> {
    let current = current?;
    Some(PendingMcpCredentialCleanupV1 {
        version: 1,
        kind: McpCredentialCleanupKind::Remove,
        server_id: server_id.to_string(),
        previous: Some(mcp_credential_connection_snapshot(current)),
        target: None,
    })
}

/// `parsePendingMcpCredentialCleanup` — strict, bounded journal parsing.
pub fn parse_pending_mcp_credential_cleanup(
    value: &Value,
) -> Result<PendingMcpCredentialCleanupV1, InvalidPendingMcpCredentialCleanup> {
    let Some(record) = value.as_object() else {
        return Err(InvalidPendingMcpCredentialCleanup);
    };
    const ALLOWED: &[&str] = &["version", "kind", "serverId", "previous", "target"];
    if record.len() != ALLOWED.len()
        || record.keys().any(|key| !ALLOWED.contains(&key.as_str()))
        || !ALLOWED.iter().all(|key| record.contains_key(*key))
    {
        return Err(InvalidPendingMcpCredentialCleanup);
    }
    let valid_kind = matches!(
        record.get("kind").and_then(Value::as_str),
        Some("remove" | "disable-oauth" | "replace")
    );
    let valid_server_id = record
        .get("serverId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control));
    if record.get("version").and_then(Value::as_u64) != Some(1) || !valid_kind || !valid_server_id {
        return Err(InvalidPendingMcpCredentialCleanup);
    }
    let previous = parse_snapshot(
        record
            .get("previous")
            .ok_or(InvalidPendingMcpCredentialCleanup)?,
    )?;
    let target = parse_snapshot(
        record
            .get("target")
            .ok_or(InvalidPendingMcpCredentialCleanup)?,
    )?;
    let server_id = record
        .get("serverId")
        .and_then(Value::as_str)
        .ok_or(InvalidPendingMcpCredentialCleanup)?
        .to_string();
    let ids_match = previous
        .as_ref()
        .map(|snapshot| snapshot.id == server_id)
        .unwrap_or(true)
        && target
            .as_ref()
            .map(|snapshot| snapshot.id == server_id)
            .unwrap_or(true);
    if !ids_match {
        return Err(InvalidPendingMcpCredentialCleanup);
    }
    Ok(PendingMcpCredentialCleanupV1 {
        version: 1,
        kind: match record
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(InvalidPendingMcpCredentialCleanup)?
        {
            "remove" => McpCredentialCleanupKind::Remove,
            "disable-oauth" => McpCredentialCleanupKind::DisableOauth,
            _ => McpCredentialCleanupKind::Replace,
        },
        server_id,
        previous,
        target,
    })
}

/// `mcpCredentialCleanupAfterConfig` — the reconciliation decision once the
/// portable file's current state is known.
pub fn mcp_credential_cleanup_after_config(
    pending: &PendingMcpCredentialCleanupV1,
    current: Option<&McpServer>,
) -> McpCredentialCleanupResolution {
    let snapshot = current.map(mcp_credential_connection_snapshot);
    let snapshot = snapshot.as_ref();
    if same_mcp_credential_connection(snapshot, pending.previous.as_ref()) {
        return McpCredentialCleanupResolution::Resolved {
            clear_oauth: false,
            clear_preset_key: false,
        };
    }
    let reached_intended_target = same_mcp_credential_connection(snapshot, pending.target.as_ref());
    McpCredentialCleanupResolution::Resolved {
        clear_oauth: true,
        // Disabling OAuth alone preserves an API-key preset only at the exact
        // intended target. If the file advanced again while the journal was
        // pending, fail closed and clear every credential from the old identity.
        clear_preset_key: pending.kind != McpCredentialCleanupKind::DisableOauth
            || !reached_intended_target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(url: &str) -> McpServer {
        McpServer {
            id: "mcp-server".to_string(),
            name: "MCP".to_string(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some(url.to_string()),
            headers: None,
            oauth: Some(true),
            preset_id: None,
            enabled: true,
        }
    }

    #[tokio::test]
    async fn preset_credential_replacement_waits_for_connection_invalidation() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let events: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_for_task = events.clone();
        let replacement = tokio::spawn(async move {
            let disconnect = async {
                events_for_task
                    .lock()
                    .unwrap()
                    .push("disconnect-start".into());
                rx.recv().await;
                events_for_task
                    .lock()
                    .unwrap()
                    .push("disconnect-end".into());
            };
            let replace = async {
                events_for_task.lock().unwrap().push("replace".into());
                "done".to_string()
            };
            replace_mcp_credential_after_disconnect(disconnect, replace).await
        });

        // Give the disconnect future a chance to start.
        for _ in 0..100 {
            if events
                .lock()
                .unwrap()
                .contains(&"disconnect-start".to_string())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(events
            .lock()
            .unwrap()
            .contains(&"disconnect-start".to_string()));
        let _ = tx.send(());
        assert_eq!(replacement.await.unwrap(), "done");
        assert_eq!(
            *events.lock().unwrap(),
            vec!["disconnect-start", "disconnect-end", "replace"]
        );
    }

    #[test]
    fn removal_clears_credentials_only_after_the_intended_server_is_absent() {
        let pending = PendingMcpCredentialCleanupV1 {
            version: 1,
            kind: McpCredentialCleanupKind::Remove,
            server_id: "mcp-server".to_string(),
            previous: Some(mcp_credential_connection_snapshot(&server(
                "https://mcp.example",
            ))),
            target: None,
        };
        assert_eq!(
            mcp_credential_cleanup_after_config(&pending, Some(&server("https://mcp.example"))),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: false,
                clear_preset_key: false,
            }
        );
        assert_eq!(
            mcp_credential_cleanup_after_config(&pending, None),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: true,
                clear_preset_key: true,
            }
        );
    }

    #[test]
    fn same_id_replacement_after_removal_resolves_by_clearing_old_credentials() {
        let pending = PendingMcpCredentialCleanupV1 {
            version: 1,
            kind: McpCredentialCleanupKind::Remove,
            server_id: "mcp-server".to_string(),
            previous: Some(mcp_credential_connection_snapshot(&server(
                "https://mcp.example",
            ))),
            target: None,
        };
        assert_eq!(
            mcp_credential_cleanup_after_config(&pending, Some(&server("https://other.example"))),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: true,
                clear_preset_key: true,
            }
        );
    }

    #[test]
    fn oauth_disable_clears_tokens_only_after_the_exact_new_config_is_visible() {
        let mut disabled = server("https://mcp.example");
        disabled.oauth = Some(false);
        let pending = PendingMcpCredentialCleanupV1 {
            version: 1,
            kind: McpCredentialCleanupKind::DisableOauth,
            server_id: "mcp-server".to_string(),
            previous: Some(mcp_credential_connection_snapshot(&server(
                "https://mcp.example",
            ))),
            target: Some(mcp_credential_connection_snapshot(&disabled)),
        };
        assert!(matches!(
            mcp_credential_cleanup_after_config(&pending, Some(&server("https://mcp.example"))),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: false,
                ..
            }
        ));
        assert!(matches!(
            mcp_credential_cleanup_after_config(&pending, Some(&disabled)),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: true,
                ..
            }
        ));
        // A second endpoint edit clears stale API-key credentials instead of
        // wedging the journal.
        let advanced = server("https://other.example");
        assert!(matches!(
            mcp_credential_cleanup_after_config(&pending, Some(&advanced)),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: true,
                clear_preset_key: true,
                ..
            }
        ));
    }

    #[test]
    fn cleanup_journal_resolves_safely_when_the_portable_file_skips_past_its_target() {
        let pending = PendingMcpCredentialCleanupV1 {
            version: 1,
            kind: McpCredentialCleanupKind::Replace,
            server_id: "mcp-server".to_string(),
            previous: Some(mcp_credential_connection_snapshot(&server(
                "https://mcp.example",
            ))),
            target: Some(mcp_credential_connection_snapshot(&server(
                "https://target.example",
            ))),
        };
        assert_eq!(
            mcp_credential_cleanup_after_config(
                &pending,
                Some(&server("https://advanced.example"))
            ),
            McpCredentialCleanupResolution::Resolved {
                clear_oauth: true,
                clear_preset_key: true,
            }
        );
    }

    #[test]
    fn pending_cleanup_records_are_strict_bounded_and_carry_both_snapshots() {
        let pending = PendingMcpCredentialCleanupV1 {
            version: 1,
            kind: McpCredentialCleanupKind::Remove,
            server_id: "mcp-server".to_string(),
            previous: Some(mcp_credential_connection_snapshot(&server(
                "https://mcp.example",
            ))),
            target: None,
        };
        let value = serde_json::to_value(&pending).unwrap();
        assert_eq!(
            parse_pending_mcp_credential_cleanup(&value).unwrap(),
            pending
        );
        let mut wrong_version = value.clone();
        wrong_version["version"] = serde_json::json!(2);
        assert!(parse_pending_mcp_credential_cleanup(&wrong_version).is_err());
        let mut wrong_previous = value.clone();
        wrong_previous["previous"]["id"] = serde_json::json!("different");
        assert!(parse_pending_mcp_credential_cleanup(&wrong_previous).is_err());
        for missing in ["kind", "serverId", "previous", "target"] {
            let mut malformed = value.clone();
            malformed.as_object_mut().unwrap().remove(missing);
            assert!(parse_pending_mcp_credential_cleanup(&malformed).is_err());
        }
        let mut unknown = value.clone();
        unknown["future"] = serde_json::json!(true);
        assert!(parse_pending_mcp_credential_cleanup(&unknown).is_err());
        let mut controlled = value;
        controlled["serverId"] = serde_json::json!("mcp\nserver");
        assert!(parse_pending_mcp_credential_cleanup(&controlled).is_err());
        let mut oversized = serde_json::to_value(&pending).unwrap();
        oversized["previous"]["args"] = serde_json::json!(vec!["x"; 129]);
        assert!(parse_pending_mcp_credential_cleanup(&oversized).is_err());
        let mut oversized = serde_json::to_value(&pending).unwrap();
        oversized["previous"]["url"] = serde_json::json!("x".repeat(4097));
        assert!(parse_pending_mcp_credential_cleanup(&oversized).is_err());
    }

    #[test]
    fn cleanup_intent_is_derived_from_the_configuration_current_inside_mutation_admission() {
        let first_target = server("https://first.example");
        let second_target = server("https://second.example");
        let after_first_commit =
            pending_mcp_credential_cleanup_for_save(Some(&first_target), &second_target).unwrap();
        assert_eq!(after_first_commit.version, 1);
        assert_eq!(after_first_commit.kind, McpCredentialCleanupKind::Replace);
        assert_eq!(after_first_commit.server_id, "mcp-server");
        assert_eq!(
            after_first_commit.previous,
            Some(mcp_credential_connection_snapshot(&first_target))
        );
        assert_eq!(
            after_first_commit.target,
            Some(mcp_credential_connection_snapshot(&second_target))
        );
        assert!(
            pending_mcp_credential_cleanup_for_save(Some(&second_target), &second_target).is_none()
        );
        assert!(pending_mcp_credential_cleanup_for_remove(None, "mcp-server").is_none());
        let removal = pending_mcp_credential_cleanup_for_remove(Some(&first_target), "mcp-server");
        assert_eq!(removal.unwrap().kind, McpCredentialCleanupKind::Remove);
    }

    #[test]
    fn runtime_admission_includes_non_secret_name_and_enabled_changes() {
        let credential_snapshot =
            mcp_credential_connection_snapshot(&server("https://mcp.example"));
        let mut renamed = server("https://mcp.example");
        renamed.name = "Renamed MCP".to_string();
        let mut disabled = server("https://mcp.example");
        disabled.enabled = false;

        assert!(
            same_mcp_credential_connection(
                Some(&credential_snapshot),
                Some(&mcp_credential_connection_snapshot(&renamed))
            ),
            "display-only changes do not trigger credential deletion"
        );
        assert!(!same_mcp_runtime_connection(
            Some(&mcp_runtime_connection_snapshot(&server(
                "https://mcp.example"
            ))),
            Some(&mcp_runtime_connection_snapshot(&renamed))
        ));
        assert!(!same_mcp_runtime_connection(
            Some(&mcp_runtime_connection_snapshot(&server(
                "https://mcp.example"
            ))),
            Some(&mcp_runtime_connection_snapshot(&disabled))
        ));
    }

    #[test]
    fn secret_map_hashes_are_canonical_and_sha256() {
        let mut map = BTreeMap::new();
        map.insert("z".to_string(), "1".to_string());
        map.insert("a".to_string(), "2".to_string());
        let digest = secret_map_hash(&map);
        assert_eq!(digest.len(), 64);
        let mut other = BTreeMap::new();
        other.insert("a".to_string(), "2".to_string());
        other.insert("z".to_string(), "1".to_string());
        assert_eq!(digest, secret_map_hash(&other));
        assert_ne!(digest, secret_map_hash(&BTreeMap::new()));
    }
}
