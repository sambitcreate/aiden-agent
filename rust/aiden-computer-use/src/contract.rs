//! The pinned cua-driver contract (port of `main/services/computer-use/contract.ts`).
//!
//! The version pins, the exact 20-tool allow-list, and the schema/capability
//! validation are the shared fail-closed contract between TypeScript and the
//! Rust broker. A drifted catalog must be rejected locally rather than guessed.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

/// The pinned cua-driver release this build was verified against.
pub const CUA_DRIVER_VERSION: &str = "0.8.3";
/// The tool catalog schema version accepted at session readiness.
pub const CUA_DRIVER_TOOL_SCHEMA: &str = "1";
/// The capability schema version accepted at session readiness.
pub const CUA_DRIVER_CAPABILITY_VERSION: &str = "1";
/// Aiden's own host bundle id.
pub const CUA_DRIVER_HOST_BUNDLE_ID: &str = "com.sambitcreate.aiden-agent";
/// The signed broker's bundle id (the process that owns macOS TCC permission).
pub const CUA_DRIVER_BROKER_BUNDLE_ID: &str = "com.sambitcreate.aiden-agent.cua-driver";
/// The signed broker is the responsible process that owns macOS TCC permission.
pub const CUA_DRIVER_TCC_HOST_BUNDLE_ID: &str = CUA_DRIVER_BROKER_BUNDLE_ID;
/// The broker/bridge executable name inside the helper bundle.
pub const CUA_DRIVER_BROKER_EXECUTABLE: &str = "aiden-cua-broker";

/// The exact tools the broker guard forwards and Aiden's catalog requires.
pub const CUA_DRIVER_ALLOWED_TOOLS: &[&str] = &[
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

/// Every allowed tool is required so native and Rust fail closed on contract drift.
pub const CUA_DRIVER_REQUIRED_TOOLS: &[&str] = CUA_DRIVER_ALLOWED_TOOLS;

/// The broker's launch-requirement API first exists on macOS 14.4.
pub fn computer_use_platform_supported(platform: &str, system_version: &str) -> bool {
    if platform != "darwin" {
        return false;
    }
    let trimmed = system_version.trim();
    // Parse the leading major and optional minor numbers (`/^(\d+)(?:\.(\d+))?/`).
    let mut components = trimmed.split('.');
    let major = components
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    let mut digits = String::new();
    let minor = components
        .next()
        .map(|part| {
            for character in part.chars() {
                if character.is_ascii_digit() {
                    digits.push(character);
                } else {
                    break;
                }
            }
            digits.parse::<u32>().ok().unwrap_or(0)
        })
        .unwrap_or(0);
    major > 14 || (major == 14 && minor >= 4)
}

/// How Aiden launches a helper executable (broker or bridge).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuaDriverInvocation {
    /// Aiden's broker/bridge executable, resolved inside the signed helper app.
    pub command: std::path::PathBuf,
    /// Test-only argv inserted before the bridge flags.
    pub prefix_args: Vec<String>,
}

impl CuaDriverInvocation {
    pub fn new(command: impl Into<std::path::PathBuf>) -> Self {
        Self {
            command: command.into(),
            prefix_args: Vec::new(),
        }
    }
}

/// Version pins reported while the host is alive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuaDriverManifest {
    pub schema_version: String,
    pub binary_version: String,
}

/// One tool in the validated cua-driver catalog.
#[derive(Debug, Clone)]
pub struct CuaDriverToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
    pub capabilities: HashSet<String>,
    pub read_only: Option<bool>,
    pub destructive: Option<bool>,
    pub idempotent: Option<bool>,
    pub open_world: Option<bool>,
}

/// The parsed, allow-listed, fully validated catalog from `tools/list`.
#[derive(Debug, Clone)]
pub struct CuaDriverToolCatalog {
    pub tools: HashMap<String, CuaDriverToolInfo>,
    pub schema_version: String,
    pub capability_version: String,
}

/// Error taxonomy shared by the whole computer-use stack. `code` mirrors the
/// TypeScript `CuaDriverError.code` strings so status mapping stays identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuaDriverError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl CuaDriverError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: true,
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new("cancelled", message)
    }
}

impl std::fmt::Display for CuaDriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "cua-driver error {}: {}",
            self.code, self.message
        )
    }
}

impl std::error::Error for CuaDriverError {}

/// cua-driver is a privileged third-party child. Give it only the environment
/// needed for locale, temporary files, and the broker/proxy contract. Provider
/// keys, OAuth tokens, Node injection flags, dynamic-loader variables, and
/// proxy credentials never cross this boundary.
pub fn build_cua_driver_environment(
    source: &HashMap<String, String>,
    host_bundle_id: &str,
) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    environment.insert(
        "PATH".to_string(),
        "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
    );
    environment.insert(
        "CUA_DRIVER_HOST_BUNDLE_ID".to_string(),
        host_bundle_id.to_string(),
    );
    environment.insert(
        "CUA_DRIVER_RS_TELEMETRY_ENABLED".to_string(),
        "0".to_string(),
    );
    environment.insert("CUA_TELEMETRY_ENABLED".to_string(), "0".to_string());
    environment.insert(
        "CUA_DRIVER_RS_UPDATE_CHECK".to_string(),
        "false".to_string(),
    );
    environment.insert("NO_COLOR".to_string(), "1".to_string());
    for key in [
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "USER",
        "__CF_USER_TEXT_ENCODING",
    ] {
        if let Some(value) = source.get(key) {
            if !value.is_empty() && !value.contains('\0') {
                environment.insert(key.to_string(), value.clone());
            }
        }
    }
    environment
}

fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(record) => Some(record),
        _ => None,
    }
}

/// Return whether this exact pinned tool schema accepts Aiden's generation
/// session id. Malformed or drifted object schemas are rejected rather than
/// guessing and sending an argument the driver did not declare.
pub fn cua_driver_tool_declares_session(tool: &CuaDriverToolInfo) -> Result<bool, CuaDriverError> {
    let schema =
        as_record(tool.input_schema.as_ref().unwrap_or(&Value::Null)).ok_or_else(|| {
            CuaDriverError::new(
                "invalid_tools",
                format!(
                    "cua-driver returned a malformed input schema for {}.",
                    tool.name
                ),
            )
        })?;
    let properties = as_record(schema.get("properties").unwrap_or(&Value::Null));
    if schema.get("type") != Some(&Value::String("object".to_string()))
        || !schema
            .get("additionalProperties")
            .is_some_and(Value::is_boolean)
        || properties.is_none()
    {
        return Err(CuaDriverError::new(
            "invalid_tools",
            format!(
                "cua-driver returned a malformed input schema for {}.",
                tool.name
            ),
        ));
    }
    if !properties.unwrap().contains_key("session") {
        return Ok(false);
    }
    let session_schema = as_record(properties.unwrap().get("session").unwrap_or(&Value::Null));
    if session_schema.and_then(|entry| entry.get("type"))
        != Some(&Value::String("string".to_string()))
    {
        return Err(CuaDriverError::new(
            "invalid_tools",
            format!(
                "cua-driver returned an invalid session schema for {}.",
                tool.name
            ),
        ));
    }
    Ok(true)
}

fn optional_bool(
    tool: &Map<String, Value>,
    snake: &str,
    camel: &str,
    annotation: &str,
) -> Option<bool> {
    match tool.get(snake) {
        Some(Value::Bool(value)) => return Some(*value),
        Some(_) => {}
        None => {}
    }
    match tool.get(camel) {
        Some(Value::Bool(value)) => return Some(*value),
        Some(_) => {}
        None => {}
    }
    as_record(tool.get("annotations").unwrap_or(&Value::Null))
        .and_then(|annotations| annotations.get(annotation))
        .and_then(Value::as_bool)
}

/// Parse and validate the `tools/list` result. Only the allow-listed tools may
/// enter Aiden's catalog, every required tool must be present, and every
/// exposed input schema must declare (or explicitly reject) the session field.
pub fn parse_cua_driver_tools(value: &Value) -> Result<CuaDriverToolCatalog, CuaDriverError> {
    let response = as_record(value).ok_or_else(|| {
        CuaDriverError::new(
            "invalid_tools",
            "cua-driver returned an invalid tool catalog.",
        )
    })?;
    let raw_tools = response
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CuaDriverError::new(
                "invalid_tools",
                "cua-driver returned an invalid tool catalog.",
            )
        })?;
    let schema_version = response
        .get("schema_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CuaDriverError::new(
                "incompatible_driver",
                "cua-driver tool schema is unsupported.",
            )
        })?;
    if schema_version != CUA_DRIVER_TOOL_SCHEMA {
        return Err(CuaDriverError::new(
            "incompatible_driver",
            format!("cua-driver tool schema {schema_version} is unsupported."),
        ));
    }
    let capability_version = response
        .get("capability_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CuaDriverError::new(
                "incompatible_driver",
                "cua-driver capability schema is unsupported.",
            )
        })?;
    if capability_version != CUA_DRIVER_CAPABILITY_VERSION {
        return Err(CuaDriverError::new(
            "incompatible_driver",
            format!("cua-driver capability schema {capability_version} is unsupported."),
        ));
    }

    let allowed: HashSet<&str> = CUA_DRIVER_ALLOWED_TOOLS.iter().copied().collect();
    let mut tools = HashMap::new();
    for raw in raw_tools {
        let Some(tool) = as_record(raw) else {
            continue;
        };
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() || !allowed.contains(name) {
            continue;
        }
        let capabilities = match tool.get("capabilities") {
            Some(Value::Array(items)) => {
                items
                    .iter()
                    .try_fold(HashSet::new(), |mut set, item| match item.as_str() {
                        Some(value) => {
                            set.insert(value.to_string());
                            Ok(set)
                        }
                        None => Err(CuaDriverError::new(
                            "invalid_tools",
                            format!("cua-driver returned invalid capabilities for {name}."),
                        )),
                    })
            }
            _ => {
                return Err(CuaDriverError::new(
                    "invalid_tools",
                    format!("cua-driver returned invalid capabilities for {name}."),
                ))
            }
        }?;
        let input_schema = tool
            .get("inputSchema")
            .or_else(|| tool.get("input_schema"))
            .cloned();
        let info = CuaDriverToolInfo {
            name: name.to_string(),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            input_schema,
            capabilities,
            read_only: optional_bool(tool, "read_only", "readOnly", "readOnlyHint"),
            destructive: optional_bool(tool, "destructive", "destructive", "destructiveHint"),
            idempotent: optional_bool(tool, "idempotent", "idempotent", "idempotentHint"),
            open_world: optional_bool(tool, "open_world", "openWorld", "openWorldHint"),
        };
        // Validate every exposed schema during readiness, before any tool call
        // can reach the privileged bridge.
        cua_driver_tool_declares_session(&info)?;
        tools.insert(name.to_string(), info);
    }
    for required in CUA_DRIVER_REQUIRED_TOOLS {
        if !tools.contains_key(*required) {
            return Err(CuaDriverError::new(
                "incompatible_driver",
                format!("cua-driver is missing required tool {required}."),
            ));
        }
    }
    Ok(CuaDriverToolCatalog {
        tools,
        schema_version: schema_version.to_string(),
        capability_version: capability_version.to_string(),
    })
}

/// Match the TypeScript `isAbortError`: Node's AbortError name or a message
/// mentioning abort/cancel.
pub fn is_abort_error(error: &dyn std::error::Error) -> bool {
    let name = error
        .source()
        .map(|source| source.to_string())
        .unwrap_or_default();
    let message = error.to_string();
    message.contains("abort") || message.contains("cancel") || name.contains("Abort")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_value() -> Value {
        let tools: Vec<Value> = CUA_DRIVER_ALLOWED_TOOLS
            .iter()
            .enumerate()
            .map(|(index, name)| {
                serde_json::json!({
                    "name": name,
                    "description": format!("tool {index}"),
                    "inputSchema": {
                        "type": "object",
                        "additionalProperties": true,
                        "properties": { "session": { "type": "string" } }
                    },
                    "capabilities": ["click"],
                })
            })
            .collect();
        serde_json::json!({
            "schema_version": CUA_DRIVER_TOOL_SCHEMA,
            "capability_version": CUA_DRIVER_CAPABILITY_VERSION,
            "tools": tools,
        })
    }

    #[test]
    fn platform_support_is_exact_at_the_14_4_boundary() {
        assert!(!computer_use_platform_supported("darwin", "14.3.9"));
        assert!(computer_use_platform_supported("darwin", "14.4"));
        assert!(computer_use_platform_supported("darwin", "15.0"));
        assert!(!computer_use_platform_supported("linux", "14.4"));
        assert!(!computer_use_platform_supported("darwin", "unknown"));
    }

    #[test]
    fn allowlist_is_exact_and_has_no_cursor_or_persistence_surface() {
        assert_eq!(CUA_DRIVER_ALLOWED_TOOLS.len(), 20);
        for forbidden in [
            "move_cursor",
            "launch_app",
            "kill_app",
            "start_recording",
            "replay_recording",
            "check_for_update",
            "config_set",
        ] {
            assert!(!CUA_DRIVER_ALLOWED_TOOLS.contains(&forbidden));
        }
    }

    #[test]
    fn parses_and_requires_the_full_pinned_catalog() {
        let catalog = parse_cua_driver_tools(&catalog_value()).unwrap();
        assert_eq!(catalog.schema_version, CUA_DRIVER_TOOL_SCHEMA);
        assert_eq!(catalog.capability_version, CUA_DRIVER_CAPABILITY_VERSION);
        assert_eq!(catalog.tools.len(), 20);
        assert!(catalog.tools["click"].capabilities.contains("click"));
    }

    #[test]
    fn filters_foreign_tools_out_of_the_catalog() {
        let mut value = catalog_value();
        value["tools"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "name": "move_cursor",
                "inputSchema": { "type": "object", "additionalProperties": true, "properties": {} },
                "capabilities": []
            }));
        let catalog = parse_cua_driver_tools(&value).unwrap();
        assert!(!catalog.tools.contains_key("move_cursor"));
    }

    #[test]
    fn rejects_drifted_schema_or_capability_versions() {
        let mut value = catalog_value();
        value["schema_version"] = serde_json::json!("2");
        assert_eq!(
            parse_cua_driver_tools(&value).unwrap_err().code,
            "incompatible_driver"
        );
        let mut value = catalog_value();
        value["capability_version"] = serde_json::json!("2");
        assert_eq!(
            parse_cua_driver_tools(&value).unwrap_err().code,
            "incompatible_driver"
        );
    }

    #[test]
    fn rejects_missing_required_tools() {
        let mut value = catalog_value();
        value["tools"]
            .as_array_mut()
            .unwrap()
            .retain(|tool| tool["name"] != "click");
        assert_eq!(
            parse_cua_driver_tools(&value).unwrap_err().code,
            "incompatible_driver"
        );
    }

    #[test]
    fn session_declaration_is_exact() {
        let mut info = CuaDriverToolInfo {
            name: "click".into(),
            description: None,
            input_schema: Some(serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "session": { "type": "string" } }
            })),
            capabilities: HashSet::new(),
            read_only: None,
            destructive: None,
            idempotent: None,
            open_world: None,
        };
        assert!(cua_driver_tool_declares_session(&info).unwrap());
        info.input_schema = Some(serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }));
        assert!(!cua_driver_tool_declares_session(&info).unwrap());
        info.input_schema = Some(serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "session": { "type": "number" } }
        }));
        assert_eq!(
            cua_driver_tool_declares_session(&info).unwrap_err().code,
            "invalid_tools"
        );
        info.input_schema = Some(serde_json::json!({ "type": "string" }));
        assert_eq!(
            cua_driver_tool_declares_session(&info).unwrap_err().code,
            "invalid_tools"
        );
    }

    #[test]
    fn environment_is_an_explicit_secret_free_allowlist() {
        let mut source = HashMap::new();
        source.insert("HOME".to_string(), "/Users/aiden".to_string());
        source.insert("OPENAI_API_KEY".to_string(), "secret".to_string());
        source.insert("NODE_OPTIONS".to_string(), "--inject".to_string());
        let environment = build_cua_driver_environment(&source, CUA_DRIVER_TCC_HOST_BUNDLE_ID);
        for forbidden in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "NODE_OPTIONS",
            "DYLD_INSERT_LIBRARIES",
            "HTTPS_PROXY",
            "CUA_DRIVER_POLICY_FILE",
        ] {
            assert!(!environment.contains_key(forbidden));
        }
        assert_eq!(
            environment.get("CUA_DRIVER_HOST_BUNDLE_ID").unwrap(),
            CUA_DRIVER_TCC_HOST_BUNDLE_ID
        );
        assert_eq!(environment.get("HOME").unwrap(), "/Users/aiden");
    }
}
