use serde_json::{Map, Value};
use std::collections::HashSet;

pub(crate) const MAX_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_DRIVER_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub(crate) const ALLOWED_TOOLS: &[&str] = &[
    "start_session",
    "end_session",
    "health_report",
    "check_permissions",
    "list_apps",
    "list_windows",
    "get_screen_size",
    "get_accessibility_tree",
    "get_desktop_state",
    "get_window_state",
    "bring_to_front",
    "click",
    "double_click",
    "right_click",
    "drag",
    "scroll",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
];

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ClientMessage {
    Forward(Vec<u8>),
    Respond(Vec<u8>),
    Drop,
}

fn parse_object(input: &[u8]) -> Result<Map<String, Value>, String> {
    let value: Value =
        serde_json::from_slice(input).map_err(|_| "malformed JSON-RPC message".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "JSON-RPC message must be an object".to_owned())?;
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
        return Err("unsupported JSON-RPC version".to_owned());
    }
    Ok(object.clone())
}

fn valid_id(value: &Value) -> bool {
    value.is_string() || value.is_number() || value.is_null()
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

pub(crate) fn process_client_message(
    input: &[u8],
    pending_tool_lists: &mut HashSet<String>,
) -> Result<ClientMessage, String> {
    let object = parse_object(input)?;
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "client JSON-RPC message is missing a method".to_owned())?;
    let request_id = object.get("id");
    if request_id.is_some_and(|id| !valid_id(id)) {
        return Err("invalid JSON-RPC request id".to_owned());
    }
    if object
        .get("params")
        .is_some_and(|params| !params.is_object() && !params.is_array())
    {
        return Err("invalid JSON-RPC params".to_owned());
    }

    let structurally_allowed = match method {
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
        return match request_id {
            Some(id) => Ok(ClientMessage::Respond(local_denial(id)?)),
            None => Ok(ClientMessage::Drop),
        };
    }

    if method == "tools/list" {
        let id = request_id.expect("tools/list was checked as a request");
        pending_tool_lists.insert(request_id_key(id)?);
    }
    Ok(ClientMessage::Forward(canonical_line(&Value::Object(
        object,
    ))?))
}

pub(crate) fn process_driver_message(
    input: &[u8],
    pending_tool_lists: &mut HashSet<String>,
) -> Result<Vec<u8>, String> {
    let mut object = parse_object(input)?;
    let has_method = object.get("method").is_some_and(Value::is_string);
    let has_id = object.contains_key("id");
    if object.get("id").is_some_and(|id| !valid_id(id)) {
        return Err("invalid driver JSON-RPC id".to_owned());
    }

    if has_method {
        if object.contains_key("result") || object.contains_key("error") {
            return Err("invalid driver JSON-RPC message shape".to_owned());
        }
    } else {
        let has_result = object.contains_key("result");
        let has_error = object.contains_key("error");
        if !has_id || has_result == has_error {
            return Err("invalid driver JSON-RPC response shape".to_owned());
        }
    }

    if !has_method {
        let id = object.get("id").expect("response id was checked");
        if pending_tool_lists.remove(&request_id_key(id)?) {
            if let Some(tools) = object
                .get_mut("result")
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

    canonical_line(&Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn allowlist_is_exact_and_has_no_cursor_or_persistence_surface() {
        assert_eq!(ALLOWED_TOOLS.len(), 20);
        for forbidden in [
            "move_cursor",
            "launch_app",
            "kill_app",
            "start_recording",
            "replay_recording",
            "check_for_update",
            "config_set",
        ] {
            assert!(!ALLOWED_TOOLS.contains(&forbidden));
        }
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
    fn driver_messages_are_shape_checked_and_canonically_reserialized() {
        let output = process_driver_message(
            br#"{ "result" : {"ok":true}, "id":1, "jsonrpc":"2.0" }"#,
            &mut pending(),
        )
        .unwrap();
        assert_eq!(
            output,
            br#"{"id":1,"jsonrpc":"2.0","result":{"ok":true}}
"#
        );
        assert!(process_driver_message(
            br#"{"jsonrpc":"2.0","id":1,"result":{},"error":{}}"#,
            &mut pending(),
        )
        .is_err());
    }
}
