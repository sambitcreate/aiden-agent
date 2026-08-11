//! Aiden Computer Use + Apple Foundation Models integration.
//!
//! Rust port of `main/services/computer-use/*` and
//! `main/services/foundation-models-connection*.ts`.
//!
//! ## Architecture (mirrors the TypeScript and the native broker)
//!
//! The agent-facing side never talks to the privileged broker socket directly:
//! Aiden spawns the signed **bridge** process (`aiden-cua-broker --bridge`),
//! which authenticates itself to the broker over Unix sockets and relays MCP
//! JSON-RPC on its stdio. This crate implements the client side of that
//! channel:
//!
//! - [`contract`] — the pinned cua-driver contract: version pins, the exact
//!   20-tool allow-list, the schema/capability validation, the minimal
//!   secret-free environment builder, and `CuaDriverError`.
//! - [`lines`] / [`jsonrpc`] — the newline-delimited JSON-RPC 2.0 framing the
//!   broker guard enforces (1 MiB client→bridge, 64 MiB bridge→client), plus a
//!   faithful port of the guard's message classification used by the mock
//!   broker in tests.
//! - [`session`] — `CuaDriverSession`: the MCP client over the bridge's stdio
//!   (initialize → tools/list → start_session → tool calls), including the
//!   local request-too-large loop, per-call timeouts, and the
//!   broken/closed lifecycle.
//! - [`host`] (macOS) — `CuaDriverHost`: spawns the broker (via `open` or a
//!   direct invocation), spawns the bridge with Node-compatible fd 3
//!   (socketpair) / fd 4 (readiness pipe), reads the exact
//!   `{"type":"ready","protocolVersion":2}` readiness frame, and owns session
//!   cleanup.
//! - [`process`] — bounded subprocess execution + the terminate-with-grace
//!   helper used for the bridge and test brokers.
//! - [`binary`] (macOS) — installation path resolution, the pinned driver
//!   sha-256, and code-signing verification.
//! - [`safety`] / [`generation_gate`] / [`settings_core`] / [`status_core`] —
//!   the pure policy logic: action normalization and approval summaries, the
//!   per-generation grant ledger, gating decisions, the durable settings
//!   coordinator, and the cached readiness service.
//! - [`foundation_models`] — the Apple Foundation Models helper client: the
//!   file-exchange protocol (request.json / response.json / process-id /
//!   cancelled under a `aiden-foundation-models-*` tempdir) plus the
//!   connection state machine.
//!
//! ## Platform split
//!
//! The protocol, policy, and helper file-exchange logic are cross-platform.
//! `host`, `binary`, and the fd-3/fd-4 bridge spawn are `target_os = "macos"`
//! only (like the native broker's `compile_error!`), because the broker's
//! launch-requirement API first exists on macOS 14.4.

#![allow(clippy::type_complexity)]

pub mod approval_core;
#[cfg(target_os = "macos")]
pub mod binary;
pub mod contract;
pub mod controller_runtime;
pub mod controller_state;
#[cfg(unix)]
pub mod foundation_models;
pub mod generation_gate;
#[cfg(target_os = "macos")]
pub mod host;
pub mod jsonrpc;
pub mod lines;
pub mod privacy_notice;
#[cfg(unix)]
pub mod process;
pub mod safety;
pub mod session;
pub mod settings_core;
pub mod settings_state;
#[cfg(unix)]
pub mod socket;
pub mod status_core;
pub mod tool;

pub use aiden_core::chat_title::{
    FoundationModelsConnectionState, FoundationModelsConnectionStatus,
};
pub use approval_core::{
    ComputerUseApprovalDecision, ComputerUseApprovalError, ComputerUseApprovalFacts,
    ComputerUseApprovalGate, ComputerUseApprovalRequest, ComputerUseApprovalWaiter,
};
pub use contract::{
    build_cua_driver_environment, computer_use_platform_supported,
    cua_driver_tool_declares_session, parse_cua_driver_tools, CuaDriverError, CuaDriverInvocation,
    CuaDriverManifest, CuaDriverToolCatalog, CuaDriverToolInfo, CUA_DRIVER_ALLOWED_TOOLS,
    CUA_DRIVER_BROKER_BUNDLE_ID, CUA_DRIVER_BROKER_EXECUTABLE, CUA_DRIVER_CAPABILITY_VERSION,
    CUA_DRIVER_HOST_BUNDLE_ID, CUA_DRIVER_REQUIRED_TOOLS, CUA_DRIVER_TCC_HOST_BUNDLE_ID,
    CUA_DRIVER_TOOL_SCHEMA, CUA_DRIVER_VERSION,
};
#[cfg(target_os = "macos")]
pub use controller_runtime::{create_computer_use_controller, CuaSessionDriver};
pub use controller_runtime::{
    ComputerUseController, ComputerUseDriver, ComputerUseExecutionError,
    ComputerUseExecutionResult, ComputerUseResultContent,
};
pub use controller_state::{
    ComputerUseApprovalDescriptor, ComputerUseControllerState, ComputerUseControllerStateError,
    ComputerUseTargetSnapshot,
};
#[cfg(unix)]
pub use foundation_models::{
    create_foundation_models_connection, parse_foundation_models_response,
    platform_foundation_models_status, run_helper_request, FoundationHelperSpawner,
    FoundationModelsCancellationToken, FoundationModelsConnection, FoundationModelsConnectionError,
    FoundationModelsResponse, FoundationModelsResult, FoundationModelsState,
    NativeFoundationModelsMethod, NativeFoundationModelsRequest,
    NativeFoundationModelsRequestRunner, NativeFoundationModelsRunOptions, OpenHelperSpawner,
    FOUNDATION_MODELS_PROTOCOL_VERSION,
};
pub use generation_gate::{
    activated_computer_use_stream_ids, composer_submission_allowed, computer_use_control_state,
    computer_use_readiness_ready, reduce_computer_use_refresh_state, ChatComputerUseMutationGate,
    ComputerUseGenerationGate,
};
pub use jsonrpc::{
    process_client_message, process_driver_message, ClientMessage, JsonRpcErrorObject, JsonRpcId,
    JsonRpcMessage, MAX_CLIENT_MESSAGE_BYTES, MAX_DRIVER_MESSAGE_BYTES,
};
pub use privacy_notice::{
    ComputerUseEnableIntent, ComputerUseNoticeDismissal, ComputerUsePrivacyNoticeState,
    COMPUTER_USE_NOTICE_DISMISSED_KEY, COMPUTER_USE_NOTICE_VERSION,
};
pub use safety::{
    computer_use_needs_approval, normalize_computer_use_args, parse_computer_use_key_chord,
    summarize_computer_use_approval, summarize_typed_approval_payload, ComputerUseBoundTarget,
    ComputerUseGrantConsumed, ComputerUseGrantLedger, ComputerUseGrantPrepared,
    ComputerUseSafetyError, ParsedKeyChord, COMPUTER_USE_READ_ONLY_ACTIONS,
};
pub use session::{
    CuaDriverCallOptions, CuaDriverSession, SessionTransport, SessionTransportConfig,
    CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES, CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES,
};
pub use settings_core::{
    computer_use_settings_dependencies_from_store, ComputerUseSettingsCoordinator,
    ComputerUseSettingsDependencies, ComputerUseSettingsError,
};
pub use settings_state::{
    ComputerUseSettingsOperation, ComputerUseSettingsRequest, ComputerUseSettingsState,
    ComputerUseStatusPresentation, ComputerUseStatusTone,
};
#[cfg(unix)]
pub use socket::{
    connect_socket_with_retry, validate_control_connect_target,
    validate_launch_lease_connect_target, RetryBackoff, CONTROL_SOCKET_NAME,
    LAUNCH_LEASE_SOCKET_NAME,
};
pub use status_core::{
    ComputerUseStatus, ComputerUseStatusDependencies, ComputerUseStatusService,
    ComputerUseStatusState, REQUIRED_HEALTH_CHECKS,
};
pub use tool::{
    computer_use_parameters_schema, COMPUTER_USE_ACTIONS, COMPUTER_USE_TOOL_DESCRIPTION,
    COMPUTER_USE_TOOL_NAME,
};
