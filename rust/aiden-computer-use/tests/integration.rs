//! Integration tests: `CuaDriverSession` against an in-process mock broker on
//! a tempdir Unix socket. The mock speaks the exact MCP JSON-RPC line protocol
//! and enforces the broker's guard rules via `process_client_message`, so the
//! client round-trips through the same wire contract the real broker enforces.
//! No real broker or cua-driver is ever launched.

use std::collections::HashSet;
use std::sync::Arc;

use aiden_computer_use::jsonrpc::{process_client_message, ClientMessage};
use aiden_computer_use::session::{
    CuaDriverCallOptions, CuaDriverSession, CuaDriverSessionOptions, SessionTransportConfig,
};
use aiden_computer_use::CUA_DRIVER_ALLOWED_TOOLS;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

/// Tools whose pinned schemas do NOT declare the generation `session` field
/// (mirrors `SESSION_LESS_TOOLS` from computer-use-foundation.test.ts).
const SESSION_LESS_TOOLS: &[&str] = &[
    "health_report",
    "check_permissions",
    "list_apps",
    "list_windows",
    "get_screen_size",
    "get_accessibility_tree",
    "bring_to_front",
];

fn catalog_tools() -> Value {
    let tools: Vec<Value> = CUA_DRIVER_ALLOWED_TOOLS
        .iter()
        .map(|name| {
            let mut properties = serde_json::Map::new();
            if !SESSION_LESS_TOOLS.contains(name) {
                properties.insert("session".into(), json!({ "type": "string" }));
            }
            json!({
                "name": name,
                "description": format!("tool {name}"),
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": true,
                    "properties": properties,
                },
                "capabilities": ["accessibility.element_tokens"],
            })
        })
        .collect();
    json!({
        "schema_version": "1",
        "capability_version": "1",
        "tools": tools,
    })
}

fn response_for(message: &Value, pending_tool_lists: &mut HashSet<String>) -> Option<Value> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = message.get("id").cloned();
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let error_reply = |code: i64, text: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } });
    match method {
        "initialize" => Some(reply(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "serverInfo": { "name": "mock-cua-driver", "version": "0.8.3" },
        }))),
        "ping" => Some(reply(json!({}))),
        "tools/list" => {
            let result = catalog_tools();
            let id_key = id
                .as_ref()
                .map(serde_json::to_string)
                .map(Result::unwrap)
                .unwrap_or_else(|| "null".into());
            pending_tool_lists.insert(id_key);
            Some(reply(result))
        }
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            match name {
                "start_session" | "end_session" | "click" => Some(reply(json!({
                    "content": [{ "type": "text", "text": "ok" }],
                    "structuredContent": { "ok": true },
                }))),
                _ => Some(error_reply(-32601, "Method not allowed")),
            }
        }
        _ => Some(error_reply(-32601, "Method not allowed")),
    }
}

/// Run the mock broker on one accepted connection until EOF, applying the
/// broker guard to every client message first (denials are answered locally).
async fn serve_connection(stream: UnixStream) {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let mut pending_tool_lists: HashSet<String> = HashSet::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let bytes = line.trim_end().as_bytes().to_vec();
        let classified = match process_client_message(&bytes, &mut pending_tool_lists) {
            Ok(classified) => classified,
            Err(_) => continue,
        };
        let reply = match classified {
            ClientMessage::Forward(bytes) => {
                let message: Value = serde_json::from_slice(&bytes).expect("valid line");
                response_for(&message, &mut pending_tool_lists)
            }
            ClientMessage::Respond(bytes) => Some(serde_json::from_slice(&bytes).expect("denial")),
            ClientMessage::RequestHostPermissions(bytes) => {
                let message: Value = serde_json::from_slice(&bytes).expect("valid line");
                response_for(&message, &mut pending_tool_lists)
            }
            ClientMessage::Drop => None,
        };
        if let Some(reply) = reply {
            let mut encoded = serde_json::to_vec(&reply).expect("serialize");
            encoded.push(b'\n');
            if writer.write_all(&encoded).await.is_err() {
                break;
            }
        }
    }
}

async fn mock_broker() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    Arc<tokio::sync::Notify>,
) {
    let directory = tempfile::TempDir::new().expect("tempdir");
    let socket_path = directory.path().join("control.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind");
    let accepted = Arc::new(tokio::sync::Notify::new());
    let accepted_for_task = Arc::clone(&accepted);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            accepted_for_task.notify_one();
            tokio::spawn(serve_connection(stream));
        }
    });
    (directory, socket_path, accepted)
}

async fn connect_session(socket_path: &std::path::Path) -> Arc<CuaDriverSession> {
    let stream = UnixStream::connect(socket_path).await.expect("connect");
    let (read_half, write_half) = tokio::io::split(stream);
    let session = CuaDriverSession::new(CuaDriverSessionOptions {
        transport: SessionTransportConfig {
            read_half: Box::new(read_half),
            write_half: Box::new(write_half),
            terminate: None,
        },
        diagnostic: None,
        on_closed: None,
    });
    session.connect(None, None).await.expect("connect");
    Arc::new(session)
}

#[tokio::test]
async fn session_connects_to_the_mock_broker_and_round_trips_tool_calls() {
    let (_directory, socket_path, accepted) = mock_broker().await;
    let session = connect_session(&socket_path).await;
    accepted.notified().await;

    assert!(session.ready());
    assert_eq!(session.schema_version().as_deref(), Some("1"));
    assert_eq!(session.capability_version().as_deref(), Some("1"));
    assert_eq!(session.tool_catalog().len(), 20);
    assert!(session.supports("click", "accessibility.element_tokens"));

    let result = session
        .call_tool(
            "click",
            json!({ "x": 1, "y": 2 }),
            &CuaDriverCallOptions::default(),
        )
        .await
        .expect("tool call");
    assert_eq!(result["structuredContent"]["ok"], true);

    // A tool that never entered the catalog is rejected client-side.
    let error = session
        .call_tool("move_cursor", json!({}), &CuaDriverCallOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_tool");

    // Session lifecycle tools are reserved by Aiden.
    let error = session
        .call_tool("start_session", json!({}), &CuaDriverCallOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, "reserved_tool");

    // The generation session id is injected into tools that declare it.
    let injected = session
        .call_tool(
            "click",
            json!({ "x": 1, "y": 2 }),
            &CuaDriverCallOptions::default(),
        )
        .await
        .expect("tool call");
    assert_eq!(injected["structuredContent"]["ok"], true);

    session.close().await;
}

#[tokio::test]
async fn session_injects_the_generation_session_id_for_declaring_tools() {
    let (observed_tx, mut observed_rx) = mpsc::channel(16);
    // Custom mock that records the last tools/call arguments.
    let directory = tempfile::TempDir::new().unwrap();
    let listener = UnixListener::bind(directory.path().join("control.sock")).unwrap();
    let observed_tx = Arc::new(observed_tx);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let observed_tx = Arc::clone(&observed_tx);
            tokio::spawn(async move {
                let (reader, mut writer) = tokio::io::split(stream);
                let mut reader = BufReader::new(reader);
                let mut line = String::new();
                let mut pending_tool_lists: HashSet<String> = HashSet::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let bytes = line.trim_end().as_bytes().to_vec();
                    let classified =
                        process_client_message(&bytes, &mut pending_tool_lists).unwrap();
                    let reply = match classified {
                        ClientMessage::Forward(bytes) => {
                            let message: Value = serde_json::from_slice(&bytes).unwrap();
                            let method = message["method"].as_str().unwrap_or_default();
                            let id = message.get("id").cloned();
                            if method == "tools/call"
                                && message["params"]["name"].as_str() != Some("start_session")
                            {
                                let _ = observed_tx.send(message.clone()).await;
                            }
                            Some(match method {
                                "initialize" => {
                                    json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": { "name": "mock", "version": "1" } } })
                                }
                                "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                                "tools/list" => {
                                    let id_key = id
                                        .as_ref()
                                        .map(serde_json::to_string)
                                        .map(Result::unwrap)
                                        .unwrap_or_else(|| "null".into());
                                    pending_tool_lists.insert(id_key);
                                    json!({ "jsonrpc": "2.0", "id": id, "result": catalog_tools() })
                                }
                                "tools/call" => {
                                    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [], "structuredContent": { "ok": true } } })
                                }
                                _ => {
                                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not allowed" } })
                                }
                            })
                        }
                        ClientMessage::Respond(bytes) => {
                            Some(serde_json::from_slice(&bytes).unwrap())
                        }
                        _ => None,
                    };
                    if let Some(reply) = reply {
                        let mut encoded = serde_json::to_vec(&reply).unwrap();
                        encoded.push(b'\n');
                        if writer.write_all(&encoded).await.is_err() {
                            break;
                        }
                    }
                }
            });
        }
    });
    let session = connect_session(&directory.path().join("control.sock")).await;
    let _ = session
        .call_tool("click", json!({ "x": 5 }), &CuaDriverCallOptions::default())
        .await
        .expect("tool call");
    let call = observed_rx.recv().await.expect("recorded call");
    assert_eq!(call["params"]["name"], "click");
    let session_id = call["params"]["arguments"]["session"]
        .as_str()
        .expect("session injected");
    assert!(session_id.starts_with("aiden-"));
    session.close().await;
}

#[tokio::test]
async fn requests_larger_than_the_client_limit_fail_locally_without_reaching_the_broker() {
    let (_directory, _socket_path, _accepted) = mock_broker().await;
    let _ = _socket_path;
    let session = connect_session(_socket_path.as_path()).await;
    let big = "a".repeat(1024 * 1024 + 16);
    let error = session
        .call_tool(
            "click",
            json!({ "payload": big }),
            &CuaDriverCallOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "request_too_large");
    session.close().await;
}

#[tokio::test]
async fn broker_guard_denies_unknown_tools_with_a_local_error() {
    // The guard mirror runs client-side; a denied request never reaches the
    // driver. Verify the classification directly.
    let mut pending = HashSet::new();
    let denied = process_client_message(
        br#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"move_cursor"}}"#,
        &mut pending,
    )
    .unwrap();
    let ClientMessage::Respond(response) = denied else {
        panic!("expected local denial");
    };
    let response: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["error"]["code"], -32601);
}
