//! Sequential Computer Use executor over an authenticated driver session.
//!
//! The app supplies a generation-owned driver adapter. This layer normalizes
//! every model argument, enforces the one-use grant state, maps only the
//! reviewed driver calls, bounds all returned content, and never logs or
//! persists screenshots/accessibility payloads.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use base64::Engine as _;
use futures::future::BoxFuture;
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "macos")]
use crate::host::CuaDriverHost;
use crate::{
    normalize_computer_use_args, parse_computer_use_key_chord, ComputerUseApprovalDescriptor,
    ComputerUseBoundTarget, ComputerUseControllerState, ComputerUseControllerStateError,
    ComputerUseSafetyError, ComputerUseTargetSnapshot, CuaDriverError, CuaDriverToolInfo,
};
#[cfg(target_os = "macos")]
use crate::{CuaDriverCallOptions, CuaDriverSession};

const ACTION_TIMEOUT_MS: u64 = 30_000;
const DISCOVERY_TIMEOUT_MS: u64 = 120_000;
const CAPTURE_TIMEOUT_MS: u64 = 60_000;
const MAX_DRIVER_TEXT_CHARS: usize = 96_000;
const MAX_IMAGE_BASE64_CHARS: usize = 60 * 1024 * 1024;
const MAX_DISCOVERY_ROWS: usize = 2_000;
const MAX_ELEMENTS: usize = 1_000;

pub trait ComputerUseDriver: Send + Sync + 'static {
    fn tool_catalog(&self) -> HashMap<String, CuaDriverToolInfo>;
    fn call_tool(
        &self,
        name: &str,
        args: Value,
        timeout_ms: u64,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<Value, CuaDriverError>>;
    fn close(&self) -> BoxFuture<'static, ()>;
}

#[cfg(target_os = "macos")]
pub struct CuaSessionDriver {
    session: Arc<CuaDriverSession>,
}

#[cfg(target_os = "macos")]
impl CuaSessionDriver {
    pub fn new(session: Arc<CuaDriverSession>) -> Self {
        Self { session }
    }
}

#[cfg(target_os = "macos")]
impl ComputerUseDriver for CuaSessionDriver {
    fn tool_catalog(&self) -> HashMap<String, CuaDriverToolInfo> {
        self.session.tool_catalog()
    }

    fn call_tool(
        &self,
        name: &str,
        args: Value,
        timeout_ms: u64,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<Value, CuaDriverError>> {
        let session = Arc::clone(&self.session);
        let name = name.to_string();
        Box::pin(async move {
            session
                .call_tool(
                    &name,
                    args,
                    &CuaDriverCallOptions {
                        signal: Some(cancellation),
                        timeout_ms: Some(timeout_ms),
                    },
                )
                .await
        })
    }

    fn close(&self) -> BoxFuture<'static, ()> {
        let session = Arc::clone(&self.session);
        Box::pin(async move {
            session.close().await;
        })
    }
}

#[cfg(target_os = "macos")]
pub async fn create_computer_use_controller(
    generation_id: impl Into<String>,
    supports_images: bool,
    cancellation: CancellationToken,
    host: Arc<CuaDriverHost>,
) -> Result<ComputerUseController<CuaSessionDriver>, CuaDriverError> {
    let session = host.create_session(Some(&cancellation)).await?;
    Ok(ComputerUseController::new(
        generation_id,
        supports_images,
        cancellation,
        Arc::new(CuaSessionDriver::new(session)),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerUseResultContent {
    Text(String),
    Image { data: String, mime_type: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComputerUseExecutionResult {
    pub content: Vec<ComputerUseResultContent>,
    pub details: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ComputerUseExecutionError {
    #[error(transparent)]
    Driver(#[from] CuaDriverError),
    #[error(transparent)]
    Safety(#[from] ComputerUseSafetyError),
    #[error(transparent)]
    State(#[from] ComputerUseControllerStateError),
    #[error("Computer Use returned a malformed result.")]
    MalformedResult,
    #[error("Computer Use was cancelled.")]
    Cancelled,
    #[error("The requested window is no longer available.")]
    TargetUnavailable,
    #[error("The app matched multiple windows. Capture an exact pid and window_id.")]
    AmbiguousTarget,
    #[error("Computer Use returned an invalid screenshot.")]
    InvalidScreenshot,
    #[error("The pinned helper does not support this reviewed action shape.")]
    UnsupportedShape,
}

struct ParsedResult {
    text: String,
    image: Option<DriverImage>,
    structured: Map<String, Value>,
}

struct DriverImage {
    data: String,
    mime_type: String,
    width: u32,
    height: u32,
}

pub struct ComputerUseController<D: ComputerUseDriver> {
    supports_images: bool,
    cancellation: CancellationToken,
    driver: Arc<D>,
    state: ComputerUseControllerState,
    closed: bool,
}

impl<D: ComputerUseDriver> ComputerUseController<D> {
    pub fn new(
        generation_id: impl Into<String>,
        supports_images: bool,
        cancellation: CancellationToken,
        driver: Arc<D>,
    ) -> Self {
        Self {
            supports_images,
            cancellation,
            driver,
            state: ComputerUseControllerState::new(generation_id),
            closed: false,
        }
    }

    pub fn target_revision(&self) -> u64 {
        self.state.target_revision()
    }

    pub async fn approval_for(
        &mut self,
        args: &Value,
    ) -> Result<Option<ComputerUseApprovalDescriptor>, ComputerUseExecutionError> {
        self.ensure_open()?;
        let normalized = normalize_computer_use_args(args)?;
        let preview = if normalized.get("action").and_then(Value::as_str) == Some("focus_app") {
            let target = self.resolve_target(&normalized).await?;
            Some(ComputerUseTargetSnapshot {
                pid: target.pid,
                window_id: target.window_id,
                app: Some(target.app),
                title: Some(target.title),
                screenshot_width: None,
                screenshot_height: None,
                element_indices: HashSet::new(),
            })
        } else {
            None
        };
        let approval = self.state.approval_for(&normalized, preview.as_ref())?;
        if approval.is_some() {
            self.validate_approval_shape(&normalized)?;
        }
        Ok(approval)
    }

    pub fn authorize(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(), ComputerUseExecutionError> {
        self.ensure_open()?;
        self.state.authorize(tool_call_id, args, approval)?;
        Ok(())
    }

    pub async fn execute(
        &mut self,
        tool_call_id: &str,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        self.ensure_open()?;
        self.check_cancelled()?;
        let args = normalize_computer_use_args(args)?;
        let consumed = self.state.consume(tool_call_id, &args)?;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match action {
            "list_apps" => self.list_apps().await,
            "list_windows" => self.list_windows().await,
            "wait" => self.wait(&args).await,
            "capture" => self.capture(&args).await,
            "focus_app" => self.focus_app(&args, consumed.bound_target).await,
            _ => self.mutate(&args).await,
        }
    }

    pub async fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.cancellation.cancel();
        self.state.close();
        self.driver.close().await;
    }

    fn ensure_open(&self) -> Result<(), ComputerUseExecutionError> {
        if self.closed {
            Err(ComputerUseExecutionError::Cancelled)
        } else {
            self.check_cancelled()
        }
    }

    fn check_cancelled(&self) -> Result<(), ComputerUseExecutionError> {
        if self.cancellation.is_cancelled() {
            Err(ComputerUseExecutionError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn validate_approval_shape(&self, args: &Value) -> Result<(), ComputerUseExecutionError> {
        if args.get("action").and_then(Value::as_str) == Some("focus_app") {
            if args.get("raise_window").and_then(Value::as_bool) == Some(true) {
                validate_driver_call(
                    &self.driver.tool_catalog(),
                    "bring_to_front",
                    &json!({ "pid": 1, "window_id": 1 }),
                )?;
            }
            return Ok(());
        }
        let target = self
            .state
            .target()
            .ok_or(ComputerUseControllerStateError::TargetRequired)?;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (tool, mut driver_args) = mutation_driver_args(action, args, target)?;
        if args.get("delivery_mode").and_then(Value::as_str) == Some("foreground") {
            driver_args["delivery_mode"] = Value::String("foreground".into());
            if args.get("bring_to_front").and_then(Value::as_bool) == Some(true) {
                validate_driver_call(
                    &self.driver.tool_catalog(),
                    "bring_to_front",
                    &json!({ "pid": target.pid, "window_id": target.window_id }),
                )?;
            }
        }
        validate_driver_call(&self.driver.tool_catalog(), tool, &driver_args)
    }

    async fn call(
        &self,
        name: &str,
        args: Value,
        timeout_ms: u64,
    ) -> Result<ParsedResult, ComputerUseExecutionError> {
        self.check_cancelled()?;
        validate_driver_call(&self.driver.tool_catalog(), name, &args)?;
        let raw = self
            .driver
            .call_tool(name, args, timeout_ms, self.cancellation.clone())
            .await?;
        parse_result(raw)
    }

    async fn list_apps(&self) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let result = self
            .call("list_apps", json!({}), DISCOVERY_TIMEOUT_MS)
            .await?;
        let apps = sanitize_apps(result.structured.get("apps"));
        Ok(text_result(
            json!({ "ok": true, "action": "list_apps", "count": apps.len(), "apps": apps }),
            json!({ "action": "list_apps" }),
        ))
    }

    async fn list_windows(&self) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let windows = self.load_windows().await?;
        let public = windows
            .iter()
            .map(WindowRecord::public_listing)
            .collect::<Vec<_>>();
        Ok(text_result(
            json!({ "ok": true, "action": "list_windows", "count": public.len(), "windows": public }),
            json!({ "action": "list_windows" }),
        ))
    }

    async fn wait(
        &self,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let seconds = args.get("seconds").and_then(Value::as_f64).unwrap_or(1.0);
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)) => {}
            _ = self.cancellation.cancelled() => return Err(ComputerUseExecutionError::Cancelled),
        }
        Ok(text_result(
            json!({ "ok": true, "action": "wait", "seconds": seconds }),
            json!({ "action": "wait" }),
        ))
    }

    async fn capture(
        &mut self,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        self.state.clear_target();
        let target = self.resolve_target(args).await?;
        self.capture_window(target, args).await
    }

    async fn capture_window(
        &mut self,
        target: WindowRecord,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let requested_mode = args.get("mode").and_then(Value::as_str).unwrap_or("som");
        let maximum = args
            .get("max_elements")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .min(MAX_ELEMENTS as u64) as usize;
        let degraded = requested_mode == "vision" && !self.supports_images;
        let mode = if degraded { "ax" } else { requested_mode };
        let include_screenshot = self.supports_images && mode != "ax";
        let mut driver_args = json!({
            "pid": target.pid,
            "window_id": target.window_id,
            "include_screenshot": include_screenshot,
            "max_elements": if mode == "vision" { 1 } else { maximum },
        });
        if mode != "som" {
            driver_args["capture_mode"] = Value::String(mode.into());
        }
        let result = self
            .call("get_window_state", driver_args, CAPTURE_TIMEOUT_MS)
            .await?;
        if include_screenshot && result.image.is_none() {
            return Err(ComputerUseExecutionError::InvalidScreenshot);
        }
        let elements = if mode == "vision" {
            Vec::new()
        } else {
            sanitize_elements(result.structured.get("elements"), maximum)
        };
        let image_dimensions = result
            .image
            .as_ref()
            .map(|image| (image.width, image.height));
        self.state.publish_capture(ComputerUseTargetSnapshot {
            pid: target.pid,
            window_id: target.window_id,
            app: Some(target.app.clone()),
            title: Some(target.title.clone()),
            screenshot_width: image_dimensions.map(|value| value.0),
            screenshot_height: image_dimensions.map(|value| value.1),
            element_indices: elements
                .iter()
                .filter_map(|element| {
                    element
                        .get("element_index")
                        .or_else(|| element.get("index"))
                        .and_then(Value::as_i64)
                })
                .collect(),
        });
        let mut payload = json!({
            "ok": true,
            "action": "capture",
            "mode": mode,
            "requested_mode": requested_mode,
            "target": target.public_target(),
            "elements": elements,
        });
        if degraded {
            payload["note"] = Value::String(
                "Vision capture degraded to accessibility text for this model.".into(),
            );
        }
        let details = json!({
            "action": "capture",
            "mode": mode,
            "requestedMode": requested_mode,
            "target": target.public_target(),
            "degradedToAccessibility": degraded,
        });
        Ok(result_with_image(payload, details, result.image))
    }

    async fn focus_app(
        &mut self,
        args: &Value,
        approved: Option<ComputerUseBoundTarget>,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let target = self.resolve_target(args).await?;
        if approved
            != Some(ComputerUseBoundTarget {
                pid: target.pid,
                window_id: target.window_id,
            })
        {
            return Err(ComputerUseExecutionError::TargetUnavailable);
        }
        self.state.clear_target();
        if args.get("raise_window").and_then(Value::as_bool) == Some(true) {
            self.call(
                "bring_to_front",
                json!({ "pid": target.pid, "window_id": target.window_id }),
                ACTION_TIMEOUT_MS,
            )
            .await?;
        }
        self.state.publish_capture(ComputerUseTargetSnapshot {
            pid: target.pid,
            window_id: target.window_id,
            app: Some(target.app.clone()),
            title: Some(target.title.clone()),
            screenshot_width: None,
            screenshot_height: None,
            element_indices: HashSet::new(),
        });
        let payload =
            json!({ "ok": true, "action": "focus_app", "target": target.public_target() });
        let details = json!({ "action": "focus_app", "target": target.public_target() });
        if args.get("capture_after").and_then(Value::as_bool) == Some(true) {
            return self
                .capture_after(target, "focus_app", payload, details)
                .await;
        }
        Ok(text_result(payload, details))
    }

    async fn mutate(
        &mut self,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        let target = self
            .state
            .target()
            .cloned()
            .ok_or(ComputerUseControllerStateError::TargetRequired)?;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (tool, mut driver_args) = mutation_driver_args(action, args, &target)?;
        if args.get("delivery_mode").and_then(Value::as_str) == Some("foreground") {
            if !schema_declares(&self.driver.tool_catalog(), tool, "delivery_mode") {
                return Err(ComputerUseExecutionError::UnsupportedShape);
            }
            if args.get("bring_to_front").and_then(Value::as_bool) == Some(true) {
                self.call(
                    "bring_to_front",
                    json!({ "pid": target.pid, "window_id": target.window_id }),
                    ACTION_TIMEOUT_MS,
                )
                .await?;
            }
            driver_args["delivery_mode"] = Value::String("foreground".into());
        }
        let result = self.call(tool, driver_args, ACTION_TIMEOUT_MS).await?;
        self.state.mutation_succeeded();
        let message = result.text.chars().take(8_000).collect::<String>();
        let mut payload = json!({
            "ok": true,
            "action": action,
            "target": target_json(&target),
        });
        if !message.is_empty() {
            payload["message"] = Value::String(message);
        }
        let details = json!({ "action": action, "target": target_json(&target) });
        if args.get("capture_after").and_then(Value::as_bool) == Some(true) {
            let target = WindowRecord {
                pid: target.pid,
                window_id: target.window_id,
                app: target.app.unwrap_or_default(),
                title: target.title.unwrap_or_default(),
                z_index: 0,
                is_on_screen: true,
            };
            return self.capture_after(target, action, payload, details).await;
        }
        Ok(text_result(payload, details))
    }

    async fn capture_after(
        &mut self,
        target: WindowRecord,
        action: &str,
        mut payload: Value,
        details: Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        match self
            .capture_window(target, &json!({ "mode": "som", "max_elements": 100 }))
            .await
        {
            Ok(capture) => Ok(merge_capture_after(action, payload, details, capture)),
            Err(ComputerUseExecutionError::Cancelled) => Err(ComputerUseExecutionError::Cancelled),
            Err(_) if self.cancellation.is_cancelled() => Err(ComputerUseExecutionError::Cancelled),
            Err(_) => {
                payload["capture_warning"] = Value::String(
                    "The action completed, but the follow-up capture failed. Do not repeat the action blindly."
                        .into(),
                );
                Ok(text_result(payload, details))
            }
        }
    }

    async fn load_windows(&self) -> Result<Vec<WindowRecord>, ComputerUseExecutionError> {
        let result = self
            .call("list_windows", json!({}), DISCOVERY_TIMEOUT_MS)
            .await?;
        Ok(parse_windows(result.structured.get("windows")))
    }

    async fn resolve_target(
        &self,
        args: &Value,
    ) -> Result<WindowRecord, ComputerUseExecutionError> {
        let windows = self.load_windows().await?;
        let pid = args.get("pid").and_then(Value::as_i64);
        let window_id = args.get("window_id").and_then(Value::as_i64);
        if let (Some(pid), Some(window_id)) = (pid, window_id) {
            return windows
                .into_iter()
                .find(|window| window.pid == pid && window.window_id == window_id)
                .ok_or(ComputerUseExecutionError::TargetUnavailable);
        }
        let query = args
            .get("app")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if matches!(query.as_str(), "screen" | "desktop") {
            return windows
                .into_iter()
                .filter(|window| window.is_on_screen)
                .filter_map(|window| desktop_priority(&window).map(|priority| (priority, window)))
                .min_by_key(|(priority, window)| (*priority, std::cmp::Reverse(window.z_index)))
                .map(|(_, window)| window)
                .ok_or(ComputerUseExecutionError::TargetUnavailable);
        }
        let matches = windows
            .into_iter()
            .filter(|window| window.app.trim().to_lowercase() == query)
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [target] => Ok(target.clone()),
            [] => Err(ComputerUseExecutionError::TargetUnavailable),
            _ => Err(ComputerUseExecutionError::AmbiguousTarget),
        }
    }
}

fn desktop_priority(window: &WindowRecord) -> Option<u8> {
    let app = window.app.trim().to_lowercase();
    let title = window.title.trim().to_lowercase();
    if (app == "finder" && matches!(title.as_str(), "desktop" | ""))
        || (matches!(app.as_str(), "progman" | "workerw" | "program manager"))
        || (matches!(app.as_str(), "gnome-shell" | "plasmashell" | "xfdesktop")
            && matches!(title.as_str(), "desktop" | ""))
    {
        return Some(0);
    }
    if matches!(app.as_str(), "explorer" | "explorer.exe")
        && matches!(
            title.as_str(),
            "desktop" | "program manager" | "taskbar" | "shell_traywnd" | ""
        )
    {
        return Some(if matches!(title.as_str(), "taskbar" | "shell_traywnd") {
            1
        } else {
            0
        });
    }
    (app == "dock" && matches!(title.as_str(), "dock" | "")).then_some(1)
}

#[derive(Clone)]
struct WindowRecord {
    pid: i64,
    window_id: i64,
    app: String,
    title: String,
    z_index: i64,
    is_on_screen: bool,
}

impl WindowRecord {
    fn public_listing(&self) -> Value {
        json!({
            "pid": self.pid,
            "window_id": self.window_id,
            "app_name": self.app,
            "title": self.title,
            "z_index": self.z_index,
            "is_on_screen": self.is_on_screen,
        })
    }

    fn public_target(&self) -> Value {
        json!({
            "pid": self.pid,
            "window_id": self.window_id,
            "app": self.app,
            "title": self.title,
        })
    }
}

fn parse_windows(value: Option<&Value>) -> Vec<WindowRecord> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_DISCOVERY_ROWS)
        .filter_map(|value| {
            let value = value.as_object()?;
            let pid = value.get("pid")?.as_i64().filter(|value| *value > 0)?;
            let window_id = value
                .get("window_id")
                .or_else(|| value.get("windowId"))?
                .as_i64()
                .filter(|value| *value > 0)?;
            Some(WindowRecord {
                pid,
                window_id,
                app: safe_string(value.get("app_name").or_else(|| value.get("appName")), 512),
                title: safe_string(value.get("title"), 512),
                z_index: value
                    .get("z_index")
                    .or_else(|| value.get("zIndex"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                is_on_screen: value
                    .get("is_on_screen")
                    .or_else(|| value.get("on_screen"))
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| {
                        value.get("off_screen").and_then(Value::as_bool) != Some(true)
                    }),
            })
        })
        .collect()
}

fn sanitize_apps(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_DISCOVERY_ROWS)
        .filter_map(|value| {
            let value = value.as_object()?;
            Some(json!({
                "pid": value.get("pid").and_then(Value::as_i64),
                "name": safe_string(
                    value
                        .get("name")
                        .or_else(|| value.get("app_name"))
                        .or_else(|| value.get("display_name")),
                    512,
                ),
                "bundle_id": safe_string(value.get("bundle_id").or_else(|| value.get("bundleId")), 512),
                "running": value.get("running").and_then(Value::as_bool),
                "active": value.get("active").and_then(Value::as_bool),
            }))
        })
        .collect()
}

fn sanitize_elements(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(maximum.min(MAX_ELEMENTS))
        .filter_map(|value| {
            let value = value.as_object()?;
            let index = value
                .get("element_index")
                .or_else(|| value.get("index"))?
                .as_i64()
                .filter(|value| *value >= 0)?;
            Some(json!({
                "element_index": index,
                "role": safe_string(value.get("role"), 256),
                "label": safe_string(value.get("label"), 2_000),
                "value": safe_string(value.get("value"), 2_000),
            }))
        })
        .collect()
}

fn safe_string(value: Option<&Value>, maximum: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .replace('\0', "")
        .chars()
        .take(maximum)
        .collect()
}

fn parse_result(raw: Value) -> Result<ParsedResult, ComputerUseExecutionError> {
    let raw = raw
        .as_object()
        .ok_or(ComputerUseExecutionError::MalformedResult)?;
    let mut text = String::new();
    let mut image = None;
    for content in raw
        .get("content")
        .and_then(Value::as_array)
        .ok_or(ComputerUseExecutionError::MalformedResult)?
    {
        let content = content
            .as_object()
            .ok_or(ComputerUseExecutionError::MalformedResult)?;
        match content.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(part) = content.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(part);
                }
            }
            Some("image") if image.is_none() => {
                image = Some(parse_image(content)?);
            }
            _ => return Err(ComputerUseExecutionError::MalformedResult),
        }
    }
    text = redact_encoded_data(&text)
        .chars()
        .take(MAX_DRIVER_TEXT_CHARS)
        .collect();
    if raw.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(CuaDriverError::new(
            "driver_action_failed",
            if text.trim().is_empty() {
                "The Computer Use helper rejected the action.".into()
            } else {
                text.chars().take(2_000).collect::<String>()
            },
        )
        .into());
    }
    Ok(ParsedResult {
        text,
        image,
        structured: raw
            .get("structuredContent")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

fn parse_image(content: &Map<String, Value>) -> Result<DriverImage, ComputerUseExecutionError> {
    let data = content
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mime_type = content
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if data.is_empty()
        || data.len() > MAX_IMAGE_BASE64_CHARS
        || data.starts_with("data:")
        || !matches!(mime_type, "image/png" | "image/jpeg")
    {
        return Err(ComputerUseExecutionError::InvalidScreenshot);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| ComputerUseExecutionError::InvalidScreenshot)?;
    let (width, height) = if mime_type == "image/png" {
        png_dimensions(&bytes)
    } else {
        jpeg_dimensions(&bytes)
    }
    .filter(|(width, height)| *width >= 8 && *height >= 8)
    .ok_or(ComputerUseExecutionError::InvalidScreenshot)?;
    Ok(DriverImage {
        data: data.into(),
        mime_type: mime_type.into(),
        width,
        height,
    })
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    (bytes.len() >= 24 && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10]).then(|| {
        (
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    })
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return None;
    }
    let mut offset = 2;
    while offset + 9 < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = bytes[offset + 1];
        offset += 2;
        if matches!(marker, 0xd8 | 0xd9) {
            continue;
        }
        if marker == 0xda || offset + 2 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes(bytes[offset..offset + 2].try_into().ok()?) as usize;
        if length < 2 || offset + length > bytes.len() {
            break;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 7 {
                return None;
            }
            let height = u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().ok()?);
            let width = u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?);
            return Some((u32::from(width), u32::from(height)));
        }
        offset += length;
    }
    None
}

fn redact_encoded_data(value: &str) -> String {
    static DATA_URI: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static ENCODED: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let data_uri = DATA_URI.get_or_init(|| {
        Regex::new(r"(?i)data:image/[a-z0-9.+-]+;base64,[a-z0-9+/=]+")
            .expect("valid data URI pattern")
    });
    let encoded = ENCODED.get_or_init(|| {
        Regex::new(r"(?i)[a-z0-9+/]{256,}={0,2}").expect("valid encoded-data pattern")
    });
    let value = value.replace('\0', "");
    let without_data_uri = data_uri.replace_all(&value, "[screenshot omitted]");
    encoded
        .replace_all(&without_data_uri, "[encoded data omitted]")
        .into_owned()
}

fn mutation_driver_args(
    action: &str,
    args: &Value,
    target: &ComputerUseTargetSnapshot,
) -> Result<(&'static str, Value), ComputerUseExecutionError> {
    let mut driver = json!({ "pid": target.pid, "window_id": target.window_id });
    let tool = match action {
        "click" | "double_click" | "right_click" | "middle_click" => {
            add_target(&mut driver, args, "element", "coordinate")?;
            if let Some(modifiers) = args.get("modifiers") {
                driver["modifier"] = modifiers.clone();
            }
            if action == "click" || action == "middle_click" {
                driver["button"] = Value::String(
                    args.get("button")
                        .and_then(Value::as_str)
                        .unwrap_or(if action == "middle_click" {
                            "middle"
                        } else {
                            "left"
                        })
                        .into(),
                );
            }
            match action {
                "double_click" => "double_click",
                "right_click" => "right_click",
                _ => "click",
            }
        }
        "drag" => {
            add_drag_target(&mut driver, args)?;
            driver["button"] = Value::String(
                args.get("button")
                    .and_then(Value::as_str)
                    .unwrap_or("left")
                    .into(),
            );
            if let Some(modifiers) = args.get("modifiers") {
                driver["modifier"] = modifiers.clone();
            }
            "drag"
        }
        "scroll" => {
            add_target(&mut driver, args, "element", "coordinate")?;
            driver["direction"] = args.get("direction").cloned().unwrap_or(Value::Null);
            driver["amount"] = args
                .get("amount")
                .cloned()
                .unwrap_or_else(|| Value::from(3));
            "scroll"
        }
        "type" => {
            driver["text"] = args.get("text").cloned().unwrap_or(Value::Null);
            "type_text"
        }
        "key" => {
            let chord = parse_computer_use_key_chord(args.get("keys").unwrap_or(&Value::Null))?;
            if chord.modifiers.is_empty() {
                driver["key"] = Value::String(chord.key);
                "press_key"
            } else {
                driver["keys"] = Value::Array(
                    chord
                        .modifiers
                        .into_iter()
                        .chain(std::iter::once(chord.key))
                        .map(Value::String)
                        .collect(),
                );
                "hotkey"
            }
        }
        "set_value" => {
            driver["element_index"] = args.get("element").cloned().unwrap_or(Value::Null);
            driver["value"] = args.get("value").cloned().unwrap_or(Value::Null);
            "set_value"
        }
        _ => return Err(ComputerUseExecutionError::UnsupportedShape),
    };
    Ok((tool, driver))
}

fn add_target(
    driver: &mut Value,
    args: &Value,
    element: &str,
    coordinate: &str,
) -> Result<(), ComputerUseExecutionError> {
    if let Some(index) = args.get(element) {
        driver["element_index"] = index.clone();
        return Ok(());
    }
    let coordinate = args
        .get(coordinate)
        .and_then(Value::as_array)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    driver["x"] = coordinate[0].clone();
    driver["y"] = coordinate[1].clone();
    Ok(())
}

fn add_drag_target(driver: &mut Value, args: &Value) -> Result<(), ComputerUseExecutionError> {
    if let (Some(from), Some(to)) = (args.get("from_element"), args.get("to_element")) {
        driver["from_element"] = from.clone();
        driver["to_element"] = to.clone();
        return Ok(());
    }
    let from = args
        .get("from_coordinate")
        .and_then(Value::as_array)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    let to = args
        .get("to_coordinate")
        .and_then(Value::as_array)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    driver["from_x"] = from[0].clone();
    driver["from_y"] = from[1].clone();
    driver["to_x"] = to[0].clone();
    driver["to_y"] = to[1].clone();
    Ok(())
}

fn schema_declares(
    catalog: &HashMap<String, CuaDriverToolInfo>,
    tool: &str,
    property: &str,
) -> bool {
    catalog
        .get(tool)
        .and_then(|tool| tool.input_schema.as_ref())
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.contains_key(property))
}

fn validate_driver_call(
    catalog: &HashMap<String, CuaDriverToolInfo>,
    tool: &str,
    args: &Value,
) -> Result<(), ComputerUseExecutionError> {
    let info = catalog
        .get(tool)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    let schema = info
        .input_schema
        .as_ref()
        .and_then(Value::as_object)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    if schema.get("type").and_then(Value::as_str) != Some("object")
        || !schema
            .get("additionalProperties")
            .is_some_and(Value::is_boolean)
    {
        return Err(ComputerUseExecutionError::UnsupportedShape);
    }
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    let args = args
        .as_object()
        .ok_or(ComputerUseExecutionError::UnsupportedShape)?;
    if !args.keys().all(|key| properties.contains_key(key)) {
        return Err(ComputerUseExecutionError::UnsupportedShape);
    }
    let required = match schema.get("required") {
        None => &[][..],
        Some(Value::Array(required)) => required.as_slice(),
        Some(_) => return Err(ComputerUseExecutionError::UnsupportedShape),
    };
    if required.iter().all(|key| {
        key.as_str()
            .is_some_and(|key| key == "session" || args.contains_key(key))
    }) {
        Ok(())
    } else {
        Err(ComputerUseExecutionError::UnsupportedShape)
    }
}

fn target_json(target: &ComputerUseTargetSnapshot) -> Value {
    json!({
        "pid": target.pid,
        "window_id": target.window_id,
        "app": target.app,
        "title": target.title,
    })
}

fn text_result(payload: Value, details: Value) -> ComputerUseExecutionResult {
    ComputerUseExecutionResult {
        content: vec![ComputerUseResultContent::Text(payload.to_string())],
        details,
    }
}

fn result_with_image(
    payload: Value,
    details: Value,
    image: Option<DriverImage>,
) -> ComputerUseExecutionResult {
    let mut result = text_result(payload, details);
    if let Some(image) = image {
        result.content.push(ComputerUseResultContent::Image {
            data: image.data,
            mime_type: image.mime_type,
        });
    }
    result
}

fn merge_capture_after(
    action: &str,
    payload: Value,
    details: Value,
    mut capture: ComputerUseExecutionResult,
) -> ComputerUseExecutionResult {
    let capture_payload = capture
        .content
        .first()
        .and_then(|content| match content {
            ComputerUseResultContent::Text(text) => serde_json::from_str(text).ok(),
            ComputerUseResultContent::Image { .. } => None,
        })
        .unwrap_or(Value::Null);
    capture.content[0] = ComputerUseResultContent::Text(
        json!({
            "action_result": payload,
            "capture": capture_payload,
        })
        .to_string(),
    );
    capture.details = json!({
        "action": action,
        "actionDetails": details,
        "capture": capture.details,
        "capturedAfter": true,
    });
    capture
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeDriver {
        calls: Mutex<Vec<(String, Value)>>,
        responses: Mutex<HashMap<String, Value>>,
        catalog: Mutex<Option<HashMap<String, CuaDriverToolInfo>>>,
    }

    impl ComputerUseDriver for FakeDriver {
        fn tool_catalog(&self) -> HashMap<String, CuaDriverToolInfo> {
            if let Some(catalog) = self.catalog.lock().unwrap().clone() {
                return catalog;
            }
            default_catalog()
        }

        fn call_tool(
            &self,
            name: &str,
            args: Value,
            _timeout_ms: u64,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<Value, CuaDriverError>> {
            self.calls.lock().unwrap().push((name.into(), args));
            let response = self.responses.lock().unwrap().get(name).cloned().unwrap_or_else(|| {
                json!({ "content": [{ "type": "text", "text": "ok" }], "structuredContent": {} })
            });
            Box::pin(async move { Ok(response) })
        }

        fn close(&self) -> BoxFuture<'static, ()> {
            Box::pin(async {})
        }
    }

    fn default_catalog() -> HashMap<String, CuaDriverToolInfo> {
        [
            ("list_apps", &[][..]),
            ("list_windows", &[][..]),
            (
                "get_window_state",
                &[
                    "pid",
                    "window_id",
                    "include_screenshot",
                    "max_elements",
                    "capture_mode",
                ],
            ),
            ("bring_to_front", &["pid", "window_id"]),
            (
                "click",
                &[
                    "pid",
                    "window_id",
                    "element_index",
                    "x",
                    "y",
                    "button",
                    "modifier",
                    "delivery_mode",
                ],
            ),
            (
                "double_click",
                &[
                    "pid",
                    "window_id",
                    "element_index",
                    "x",
                    "y",
                    "delivery_mode",
                ],
            ),
            (
                "right_click",
                &[
                    "pid",
                    "window_id",
                    "element_index",
                    "x",
                    "y",
                    "modifier",
                    "delivery_mode",
                ],
            ),
            (
                "drag",
                &[
                    "pid",
                    "window_id",
                    "from_element",
                    "to_element",
                    "from_x",
                    "from_y",
                    "to_x",
                    "to_y",
                    "button",
                    "modifier",
                    "delivery_mode",
                ],
            ),
            (
                "scroll",
                &[
                    "pid",
                    "window_id",
                    "element_index",
                    "x",
                    "y",
                    "direction",
                    "amount",
                    "delivery_mode",
                ],
            ),
            ("type_text", &["pid", "window_id", "text", "delivery_mode"]),
            ("press_key", &["pid", "window_id", "key", "delivery_mode"]),
            ("hotkey", &["pid", "window_id", "keys", "delivery_mode"]),
            ("set_value", &["pid", "window_id", "element_index", "value"]),
        ]
        .into_iter()
        .map(|(name, properties)| (name.into(), tool_info(name, properties)))
        .collect()
    }

    fn tool_info(name: &str, properties: &[&str]) -> CuaDriverToolInfo {
        CuaDriverToolInfo {
            name: name.into(),
            description: None,
            input_schema: Some(json!({
                "type": "object",
                "additionalProperties": false,
                "properties": properties
                    .iter()
                    .map(|property| ((*property).to_string(), json!({})))
                    .collect::<Map<String, Value>>(),
            })),
            capabilities: HashSet::new(),
            read_only: None,
            destructive: None,
            idempotent: None,
            open_world: None,
        }
    }

    fn controller() -> (ComputerUseController<FakeDriver>, Arc<FakeDriver>) {
        let driver = Arc::new(FakeDriver::default());
        driver.responses.lock().unwrap().insert(
            "list_windows".into(),
            json!({
                "content": [{ "type": "text", "text": "windows" }],
                "structuredContent": {
                    "windows": [{ "pid": 42, "window_id": 7, "app_name": "Notes", "title": "Draft" }]
                }
            }),
        );
        (
            ComputerUseController::new(
                "generation",
                false,
                CancellationToken::new(),
                driver.clone(),
            ),
            driver,
        )
    }

    fn publish_target(controller: &mut ComputerUseController<FakeDriver>) {
        controller.state.publish_capture(ComputerUseTargetSnapshot {
            pid: 42,
            window_id: 7,
            app: Some("Notes".into()),
            title: Some("Draft".into()),
            screenshot_width: Some(100),
            screenshot_height: Some(100),
            element_indices: HashSet::from([0]),
        });
    }

    #[tokio::test]
    async fn read_only_discovery_never_needs_approval_and_is_bounded() {
        let (mut controller, driver) = controller();
        assert!(controller
            .approval_for(&json!({ "action": "list_windows" }))
            .await
            .unwrap()
            .is_none());
        let result = controller
            .execute("call", &json!({ "action": "list_windows" }))
            .await
            .unwrap();
        assert_eq!(result.details["action"], "list_windows");
        assert_eq!(driver.calls.lock().unwrap()[0].0, "list_windows");
    }

    #[tokio::test]
    async fn capture_preserves_driver_element_indices_for_the_next_exact_approval() {
        let (mut controller, driver) = controller();
        driver.responses.lock().unwrap().insert(
            "get_window_state".into(),
            json!({
                "content": [{ "type": "text", "text": "captured" }],
                "structuredContent": {
                    "elements": [{
                        "element_index": 0,
                        "role": "button",
                        "label": "Save"
                    }]
                }
            }),
        );
        let result = controller
            .execute(
                "capture",
                &json!({ "action": "capture", "mode": "ax", "app": "Notes" }),
            )
            .await
            .unwrap();
        let text = match &result.content[0] {
            ComputerUseResultContent::Text(text) => text,
            ComputerUseResultContent::Image { .. } => panic!("text result expected"),
        };
        assert!(text.contains("element_index"));
        assert!(controller
            .approval_for(&json!({ "action": "click", "element": 0 }))
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn desktop_capture_selects_only_an_exact_visible_shell_window() {
        let (mut controller, driver) = controller();
        driver.responses.lock().unwrap().insert(
            "list_windows".into(),
            json!({
                "content": [{ "type": "text", "text": "windows" }],
                "structuredContent": {
                    "windows": [
                        {
                            "pid": 1,
                            "window_id": 2,
                            "app_name": "Finder",
                            "title": "Desktop",
                            "is_on_screen": false
                        },
                        {
                            "pid": 3,
                            "window_id": 4,
                            "app_name": "Finder",
                            "title": "Desktop",
                            "is_on_screen": true
                        }
                    ]
                }
            }),
        );
        controller
            .execute(
                "desktop",
                &json!({ "action": "capture", "mode": "ax", "app": "desktop" }),
            )
            .await
            .unwrap();
        let calls = driver.calls.lock().unwrap();
        let capture = calls
            .iter()
            .find(|call| call.0 == "get_window_state")
            .unwrap();
        assert_eq!(capture.1["pid"], 3);
        assert_eq!(capture.1["window_id"], 4);
    }

    #[tokio::test]
    async fn mutation_never_dispatches_without_an_allow_once_grant() {
        let (mut controller, driver) = controller();
        publish_target(&mut controller);
        let args = json!({ "action": "click", "element": 0 });
        assert!(controller.execute("call", &args).await.is_err());
        assert!(driver.calls.lock().unwrap().is_empty());

        let approval = controller.approval_for(&args).await.unwrap().unwrap();
        controller.authorize("call", &args, &approval).unwrap();
        controller.execute("call", &args).await.unwrap();
        assert_eq!(driver.calls.lock().unwrap()[0].0, "click");
        assert!(controller.execute("call", &args).await.is_err());
    }

    #[tokio::test]
    async fn driver_schema_mismatch_fails_before_approval_or_dispatch() {
        let (mut controller, driver) = controller();
        publish_target(&mut controller);
        let mut catalog = default_catalog();
        catalog.insert(
            "click".into(),
            tool_info("click", &["pid", "window_id", "button"]),
        );
        *driver.catalog.lock().unwrap() = Some(catalog);

        assert!(matches!(
            controller
                .approval_for(&json!({ "action": "click", "element": 0 }))
                .await,
            Err(ComputerUseExecutionError::UnsupportedShape)
        ));
        assert!(driver.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn newly_required_driver_argument_fails_closed_before_approval() {
        let (mut controller, driver) = controller();
        publish_target(&mut controller);
        let mut catalog = default_catalog();
        let mut click = tool_info(
            "click",
            &[
                "pid",
                "window_id",
                "element_index",
                "element_token",
                "button",
            ],
        );
        let schema = click.input_schema.as_mut().unwrap();
        schema["required"] = json!(["pid", "window_id", "element_token"]);
        catalog.insert("click".into(), click);
        *driver.catalog.lock().unwrap() = Some(catalog);

        assert!(matches!(
            controller
                .approval_for(&json!({ "action": "click", "element": 0 }))
                .await,
            Err(ComputerUseExecutionError::UnsupportedShape)
        ));
        assert!(driver.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn capture_after_is_sequential_and_does_not_repeat_a_completed_action_on_failure() {
        let (mut controller, driver) = controller();
        publish_target(&mut controller);
        let args = json!({ "action": "click", "element": 0, "capture_after": true });
        let approval = controller.approval_for(&args).await.unwrap().unwrap();
        controller
            .authorize("capture-after", &args, &approval)
            .unwrap();
        let result = controller.execute("capture-after", &args).await.unwrap();
        assert_eq!(result.details["capturedAfter"], true);
        assert_eq!(
            driver
                .calls
                .lock()
                .unwrap()
                .iter()
                .map(|call| call.0.as_str())
                .collect::<Vec<_>>(),
            ["click", "get_window_state"]
        );

        publish_target(&mut controller);
        driver.responses.lock().unwrap().insert(
            "get_window_state".into(),
            json!({
                "content": [{ "type": "text", "text": "capture failed" }],
                "structuredContent": {},
                "isError": true,
            }),
        );
        let approval = controller.approval_for(&args).await.unwrap().unwrap();
        controller
            .authorize("capture-fails", &args, &approval)
            .unwrap();
        let result = controller.execute("capture-fails", &args).await.unwrap();
        let text = match &result.content[0] {
            ComputerUseResultContent::Text(text) => text,
            ComputerUseResultContent::Image { .. } => panic!("text result expected"),
        };
        assert!(text.contains("follow-up capture failed"));
        assert_eq!(
            driver
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.0 == "click")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn cancellation_prevents_driver_dispatch() {
        let driver = Arc::new(FakeDriver::default());
        let cancellation = CancellationToken::new();
        let mut controller =
            ComputerUseController::new("generation", false, cancellation.clone(), driver.clone());
        cancellation.cancel();
        assert!(matches!(
            controller
                .execute("call", &json!({ "action": "list_apps" }))
                .await,
            Err(ComputerUseExecutionError::Cancelled)
        ));
        assert!(driver.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn encoded_screenshot_like_text_is_redacted_before_provider_return() {
        let encoded = "A".repeat(300);
        let parsed = parse_result(json!({
            "content": [{ "type": "text", "text": encoded }],
            "structuredContent": {}
        }))
        .unwrap();
        assert_eq!(parsed.text, "[encoded data omitted]");
    }

    #[test]
    fn malformed_short_jpeg_segment_is_rejected_without_panicking() {
        let bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0, 0, 0, 0, 0, 0];
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(matches!(
            parse_result(json!({
                "content": [{ "type": "image", "data": data, "mimeType": "image/jpeg" }],
                "structuredContent": {}
            })),
            Err(ComputerUseExecutionError::InvalidScreenshot)
        ));
    }
}
