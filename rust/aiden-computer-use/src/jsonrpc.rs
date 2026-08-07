//! JSON-RPC 2.0 message shapes and the broker guard protocol.
//!
//! This is a faithful port of the wire protocol defined by
//! `native/computer-use-broker/src/jsonrpc.rs` (the guard sits between the
//! bridge and the cua-driver). Aiden's client side speaks the same
//! line-delimited framing, and the guard classification is replicated here so
//! the in-process mock broker used by integration tests enforces exactly the
//! same allow-list and shape rules the real broker does.

use std::collections::HashSet;

use serde_json::{Map, Value};

pub const MAX_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_DRIVER_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub use crate::contract::CUA_DRIVER_ALLOWED_TOOLS as ALLOWED_TOOLS;

/// A JSON-RPC request id: string, number, or null.
pub type JsonRpcId = Value;

/// JSON-RPC error object (`{code, message, data?}`).
#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcErrorObject {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

/// A parsed JSON-RPC 2.0 message as exchanged on the MCP channel.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonRpcMessage {
    Request {
        id: JsonRpcId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Response {
        id: JsonRpcId,
        result: Option<Value>,
        error: Option<JsonRpcErrorObject>,
    },
}

/// Recursively sort object keys so the serialized form is canonical regardless
/// of serde_json's `preserve_order` feature (enabled transitively under
/// workspace feature unification, which would otherwise leak insertion order).
fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut sorted = Map::new();
            for (key, entry) in entries {
                sorted.insert(key.clone(), sort_keys(entry));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

impl JsonRpcMessage {
    /// Serialize the message to one canonical newline-terminated line.
    pub fn to_line(&self) -> Result<Vec<u8>, String> {
        let mut output = serde_json::to_vec(&sort_keys(&self.to_value()))
            .map_err(|_| "could not serialize canonical JSON-RPC message".to_owned())?;
        output.push(b'\n');
        Ok(output)
    }

    pub fn to_value(&self) -> Value {
        match self {
            JsonRpcMessage::Request { id, method, params } => {
                let mut object = Map::new();
                object.insert("jsonrpc".into(), Value::String("2.0".into()));
                object.insert("id".into(), id.clone());
                object.insert("method".into(), Value::String(method.clone()));
                if let Some(params) = params {
                    object.insert("params".into(), params.clone());
                }
                Value::Object(object)
            }
            JsonRpcMessage::Notification { method, params } => {
                let mut object = Map::new();
                object.insert("jsonrpc".into(), Value::String("2.0".into()));
                object.insert("method".into(), Value::String(method.clone()));
                if let Some(params) = params {
                    object.insert("params".into(), params.clone());
                }
                Value::Object(object)
            }
            JsonRpcMessage::Response { id, result, error } => {
                let mut object = Map::new();
                object.insert("jsonrpc".into(), Value::String("2.0".into()));
                object.insert("id".into(), id.clone());
                if let Some(error) = error {
                    let mut error_object = Map::new();
                    error_object.insert("code".into(), Value::from(error.code));
                    error_object.insert("message".into(), Value::String(error.message.clone()));
                    if let Some(data) = &error.data {
                        error_object.insert("data".into(), data.clone());
                    }
                    object.insert("error".into(), Value::Object(error_object));
                } else if let Some(result) = result {
                    object.insert("result".into(), result.clone());
                }
                Value::Object(object)
            }
        }
    }

    /// Parse one message from a single line (no trailing newline).
    pub fn from_line(input: &[u8]) -> Result<JsonRpcMessage, String> {
        let value: Value =
            serde_json::from_slice(input).map_err(|_| "malformed JSON-RPC message".to_owned())?;
        Self::from_value(&value)
    }

    pub fn from_value(value: &Value) -> Result<JsonRpcMessage, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "JSON-RPC message must be an object".to_owned())?;
        if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
            return Err("unsupported JSON-RPC version".to_owned());
        }
        let has_method = object.get("method").is_some_and(Value::is_string);
        let has_id = object.contains_key("id");
        if object.get("id").is_some_and(|id| !valid_id(id)) {
            return Err("invalid JSON-RPC id".to_owned());
        }
        if has_method {
            if object.contains_key("result") || object.contains_key("error") {
                return Err("invalid JSON-RPC message shape".to_owned());
            }
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let params = object.get("params").cloned();
            if params
                .as_ref()
                .is_some_and(|params| !params.is_object() && !params.is_array())
            {
                return Err("invalid JSON-RPC params".to_owned());
            }
            return Ok(if has_id {
                JsonRpcMessage::Request {
                    id: object.get("id").cloned().unwrap_or(Value::Null),
                    method,
                    params,
                }
            } else {
                JsonRpcMessage::Notification { method, params }
            });
        }
        let has_result = object.contains_key("result");
        let has_error = object.contains_key("error");
        if !has_id || has_result == has_error {
            return Err("invalid JSON-RPC response shape".to_owned());
        }
        let error = match object.get("error") {
            Some(error) => {
                let error = error
                    .as_object()
                    .ok_or_else(|| "invalid JSON-RPC error".to_owned())?;
                Some(JsonRpcErrorObject {
                    code: error
                        .get("code")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| "invalid JSON-RPC error code".to_owned())?,
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    data: error.get("data").cloned(),
                })
            }
            None => None,
        };
        Ok(JsonRpcMessage::Response {
            id: object.get("id").cloned().unwrap_or(Value::Null),
            result: object.get("result").cloned(),
            error,
        })
    }
}

fn valid_id(value: &Value) -> bool {
    value.is_string() || value.is_number() || value.is_null()
}

/// Client→driver message classification (mirror of the broker's
/// `process_client_message`). The mock broker and any future direct socket
/// client share this exact allow-list behavior.
#[derive(Debug, Eq, PartialEq)]
pub enum ClientMessage {
    Forward(Vec<u8>),
    RequestHostPermissions(Vec<u8>),
    Respond(Vec<u8>),
    Drop,
}

fn canonical_line(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = serde_json::to_vec(value)
        .map_err(|_| "could not serialize canonical JSON-RPC message".to_owned())?;
    output.push(b'\n');
    Ok(output)
}

fn request_id_key(id: &Value) -> Result<String, String> {
    serde_json::to_string(id).map_err(|_| "invalid JSON-RPC request id".to_owned())
}

fn local_denial(id: &Value) -> Result<Vec<u8>, String> {
    canonical_line(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": "Method not allowed"
        }
    }))
}

fn is_allowed_tool(name: &str) -> bool {
    ALLOWED_TOOLS.contains(&name)
}

fn is_exact_host_permission_request(object: &Map<String, Value>) -> bool {
    if object.get("method") != Some(&Value::String("tools/call".to_owned())) {
        return false;
    }
    let Some(params) = object.get("params").and_then(Value::as_object) else {
        return false;
    };
    let Some(arguments) = params.get("arguments").and_then(Value::as_object) else {
        return false;
    };
    params.len() == 2
        && params.get("name") == Some(&Value::String("check_permissions".to_owned()))
        && arguments.len() == 1
        && arguments.get("prompt") == Some(&Value::Bool(true))
}

fn replace_permission_prompt_with_recheck(object: &mut Map<String, Value>) {
    object
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .and_then(|params| params.get_mut("arguments"))
        .and_then(Value::as_object_mut)
        .expect("exact permission request was validated")
        .insert("prompt".to_owned(), Value::Bool(false));
}

/// Classify one client message the way the broker guard does. `pending_tool_lists`
/// records `tools/list` request ids so the corresponding driver response can be
/// filtered down to the allow-list.
pub fn process_client_message(
    input: &[u8],
    pending_tool_lists: &mut HashSet<String>,
) -> Result<ClientMessage, String> {
    let value: Value =
        serde_json::from_slice(input).map_err(|_| "malformed JSON-RPC message".to_owned())?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| "JSON-RPC message must be an object".to_owned())?;
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
        return Err("unsupported JSON-RPC version".to_owned());
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "client JSON-RPC message is missing a method".to_owned())?
        .to_string();
    let request_id = object.get("id").cloned();
    if request_id.as_ref().is_some_and(|id| !valid_id(id)) {
        return Err("invalid JSON-RPC request id".to_owned());
    }
    if object
        .get("params")
        .is_some_and(|params| !params.is_object() && !params.is_array())
    {
        return Err("invalid JSON-RPC params".to_owned());
    }

    let structurally_allowed = match method.as_str() {
        "initialize" | "ping" | "tools/list" => request_id.is_some(),
        "notifications/initialized" => request_id.is_none(),
        "tools/call" => {
            let name = object
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .ok_or_else(|| "tools/call is missing its tool name".to_owned())?;
            request_id.is_some() && is_allowed_tool(name)
        }
        _ => false,
    };

    if !structurally_allowed {
        return match &request_id {
            Some(id) => Ok(ClientMessage::Respond(local_denial(id)?)),
            None => Ok(ClientMessage::Drop),
        };
    }

    if method == "tools/list" {
        let id = request_id
            .as_ref()
            .expect("tools/list was checked as a request");
        pending_tool_lists.insert(request_id_key(id)?);
    }
    if is_exact_host_permission_request(&object) {
        replace_permission_prompt_with_recheck(&mut object);
        return Ok(ClientMessage::RequestHostPermissions(canonical_line(
            &Value::Object(object),
        )?));
    }
    Ok(ClientMessage::Forward(canonical_line(&Value::Object(
        object,
    ))?))
}

/// Classify and filter one driver message (mirror of the broker's
/// `process_driver_message`): responses to recorded `tools/list` requests have
/// their tool arrays trimmed to the allow-list before they reach Aiden.
pub fn process_driver_message(
    input: &[u8],
    pending_tool_lists: &mut HashSet<String>,
) -> Result<Vec<u8>, String> {
    let mut message = JsonRpcMessage::from_line(input)?;
    if let JsonRpcMessage::Response { id, result, .. } = &mut message {
        if pending_tool_lists.remove(&request_id_key(id).ok().unwrap_or_default()) {
            if let Some(tools) = result
                .as_mut()
                .and_then(Value::as_object_mut)
                .and_then(|result| result.get_mut("tools"))
                .and_then(Value::as_array_mut)
            {
                tools.retain(|tool| {
                    tool.as_object()
                        .and_then(|entry| entry.get("name"))
                        .and_then(Value::as_str)
                        .is_some_and(is_allowed_tool)
                });
            }
        }
    }
    let mut output = serde_json::to_vec(&message.to_value())
        .map_err(|_| "could not serialize canonical JSON-RPC message".to_owned())?;
    output.push(b'\n');
    Ok(output)
}

/// The exact internal control frames of the broker/bridge handshake
/// (`runtime.rs`), replicated so the client host can validate the bridge's
/// readiness channel byte-for-byte.
pub const READINESS_FRAME: &[u8] = b"{\"type\":\"ready\",\"protocolVersion\":2}\n";
pub const BROKER_SUPERVISION_ACK: &[u8] =
    b"{\"type\":\"broker-supervision-armed\",\"protocolVersion\":2}\n";
pub const CONTAINMENT_GUARD_ARMED: &[u8] =
    b"{\"type\":\"containment-guard-armed\",\"protocolVersion\":2}\n";
pub const SUPERVISION_ACK: &[u8] = b"{\"type\":\"supervision-armed\",\"protocolVersion\":2}\n";
pub const BROKER_READY: &[u8] = b"{\"type\":\"broker-ready\",\"protocolVersion\":2}\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn message_round_trips_through_canonical_lines() {
        let message = JsonRpcMessage::Request {
            id: Value::from(1),
            method: "ping".to_string(),
            params: Some(serde_json::json!({})),
        };
        let line = message.to_line().unwrap();
        // serde_json's default Map serializes keys sorted (no preserve_order),
        // exactly like the native broker's canonical_line.
        assert_eq!(
            line,
            b"{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"ping\",\"params\":{}}\n"
        );
        assert_eq!(JsonRpcMessage::from_line(&line).unwrap(), message);

        let response = JsonRpcMessage::Response {
            id: Value::String("p".into()),
            result: Some(serde_json::json!({"ok": true})),
            error: None,
        };
        let line = response.to_line().unwrap();
        assert_eq!(
            JsonRpcMessage::from_line(&line).unwrap(),
            JsonRpcMessage::Response {
                id: Value::String("p".into()),
                result: Some(serde_json::json!({"ok": true})),
                error: None,
            }
        );
    }

    #[test]
    fn allows_only_mcp_bootstrap_and_allowlisted_tool_calls() {
        for message in [
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click","arguments":{"x":1,"y":2}}}"#,
        ] {
            assert!(matches!(
                process_client_message(message.as_bytes(), &mut pending()).unwrap(),
                ClientMessage::Forward(_)
            ));
        }
    }

    #[test]
    fn exact_permission_prompt_is_host_owned_and_driver_receives_only_a_recheck() {
        let message = process_client_message(
            br#"{"jsonrpc":"2.0","id":"permissions","method":"tools/call","params":{"name":"check_permissions","arguments":{"prompt":true}}}"#,
            &mut pending(),
        )
        .unwrap();
        let ClientMessage::RequestHostPermissions(forwarded) = message else {
            panic!("expected host-owned permission request");
        };
        let forwarded: Value = serde_json::from_slice(&forwarded).unwrap();
        assert!(!forwarded["params"]["arguments"]["prompt"]
            .as_bool()
            .unwrap());
        assert_eq!(forwarded["id"], "permissions");
    }

    #[test]
    fn malformed_or_expanded_permission_calls_never_gain_host_prompt_authority() {
        for message in [
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_permissions","arguments":{"prompt":false}}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_permissions","arguments":{"prompt":true,"extra":true}}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_permissions","arguments":{"prompt":"true"}}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_permissions","arguments":{"prompt":true},"_meta":{}}}"#.as_slice(),
        ] {
            assert!(matches!(
                process_client_message(message, &mut pending()).unwrap(),
                ClientMessage::Forward(_)
            ));
        }
    }

    #[test]
    fn denied_requests_get_local_errors_and_denied_notifications_are_dropped() {
        let denied = process_client_message(
            br#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"move_cursor"}}"#,
            &mut pending(),
        )
        .unwrap();
        let ClientMessage::Respond(response) = denied else {
            panic!("expected local denial");
        };
        let response: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(response["id"], 9);
        assert_eq!(response["error"]["code"], -32601);

        assert_eq!(
            process_client_message(
                br#"{"jsonrpc":"2.0","method":"notifications/progress"}"#,
                &mut pending(),
            )
            .unwrap(),
            ClientMessage::Drop
        );
    }

    #[test]
    fn malformed_messages_fail_closed() {
        for message in [
            "not json",
            "[]",
            r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#,
        ] {
            assert!(
                process_client_message(message.as_bytes(), &mut pending()).is_err(),
                "accepted {message}"
            );
        }
    }

    #[test]
    fn tool_listing_is_filtered_before_it_reaches_aiden() {
        let mut pending = pending();
        process_client_message(
            br#"{"jsonrpc":"2.0","id":"list","method":"tools/list"}"#,
            &mut pending,
        )
        .unwrap();
        let output = process_driver_message(
            br#"{"jsonrpc":"2.0","id":"list","result":{"schema_version":"1","tools":[{"name":"click"},{"name":"move_cursor"},{"name":"start_recording"}]}}"#,
            &mut pending,
        )
        .unwrap();
        let output: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(output["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(output["result"]["tools"][0]["name"], "click");
    }

    #[test]
    fn readiness_frame_is_the_exact_native_string() {
        assert_eq!(
            READINESS_FRAME,
            b"{\"type\":\"ready\",\"protocolVersion\":2}\n"
        );
        assert_eq!(
            BROKER_READY,
            b"{\"type\":\"broker-ready\",\"protocolVersion\":2}\n"
        );
    }
}
