//! Aiden Agent subagent system — Rust port of `main/services/subagents/**`.
//!
//! The injected-port seams (clock closures, approval/authority callbacks, host
//! dependency injection) intentionally carry `Box<dyn Fn… + Send + Sync>`
//! signatures that mirror the TS production-inert core pattern; the
//! `type_complexity` lint is suppressed crate-wide for those seams.
#![allow(clippy::type_complexity)]
//!
//! The largest remaining TS surface in the Electron main process, ported in
//! seven groups:
//!
//! 1. **Authority/capabilities** — [`authority`], [`request_capabilities`],
//!    [`capability_profile`], [`approval`], [`contracts`]: the positive
//!    six-ceiling intersection and digest-pinned approvals.
//! 2. **Run store** — [`run_store_storage`] (in-process replacement for the
//!    signed C `aiden-subagent-run-store` helper, identical on-disk format and
//!    CAS-generation discipline), [`run_store`] (V1), [`run_store_v2`] (V2),
//!    [`run_store_migration`], [`run_store_dispatcher`],
//!    [`run_store_production`].
//! 3. **Lifecycle/supervision** — [`nesting`], [`event_projector`],
//!    [`health_metrics`], [`history_read`], [`background_lifecycle`],
//!    [`control`], [`forked_context`], [`child_runtime`], [`supervisor`].
//! 4. **Shell/file-mutation effects** — [`file_mutation`], [`file_mutator`]
//!    (in-process `aiden-subagent-file-mutator`), [`shell_runner`] (in-process
//!    `aiden-subagent-shell-runner` with the exact `AIDSH001` framing),
//!    [`shell`], [`workspace_write`], [`network_budget`], [`outbound_approval`].
//! 5. **MCP surface** — [`mcp`]: bounded fetch, credential redaction,
//!    mutation approval core, and the trait ports used by the host
//!    `aiden-mcp::client::McpClientManager` wiring.
//! 6. **Control/IPC + compat** — [`control`] registry, identifier privacy
//!    (via [`safe_text`]), packaged-soak [`packaged_soak`].
//! 7. **Forked context + management** — [`forked_context`], management
//!    requests (aiden-core `subagent_management_v2`).
//!
//! # Host wiring (production-inert cores)
//!
//! Every executor seam is injected, matching the TS "production-inert core"
//! pattern: the child provider loop (`run_child`), the MCP host
//! (`aiden-mcp::client::McpClientManager` behind the [`mcp::SubagentMcpClientPort`]
//! trait), and the read-only child tool assembly. The host reuses
//! `aiden-agent::coding_tools::subagent_coding_tool_defs` with the allowlist
//! resolved by [`capability_profile::resolve_capability_profile`] and
//! `is_protected_credential_path` for the read path.
//!
//! # C-helper semantics replicated in-process
//!
//! - **Run store** (`native/subagent-run-store/main.c`): `runs.json` ≤8 MiB,
//!   `.runs.json.<uuid>.tmp` staging with O_EXCL + 0600, fsync + identity
//!   verification + atomic install + dir fsync, generation tokens
//!   (`dev-ino-size-mtime-ctime-birthtime` hex fields), CAS writes that fail
//!   with `destination_changed` instead of overwriting newer durable state.
//! - **File mutator** (`native/subagent-file-mutator/main.c`):
//!   `inspect → prepare-inspected → commit → finalize/preserve/cancel` with the
//!   `.aiden-subagent-file-<effectId>-<uuid>.tmp` recovery artifacts and
//!   digest-pinned refuse-if-changed semantics.
//! - **Shell runner** (`native/subagent-shell-runner/main.c`): the `AIDSH001`
//!   request frame and `AIDSR001` response frame, `/bin/zsh -f -c` in a
//!   minimal private 0700 environment, 512 KiB stream caps, and the eight
//!   outcome taxonomy.
//!
//! # Explicit stubs / non-portable surfaces
//!
//! - `subagent-phase3-contract.test.ts` asserts source-ordering guarantees
//!   inside the Electron `llm-client.ts` file (e.g. "snapshot persists before
//!   renderer delivery"). That is an implementation-verification test with no
//!   equivalent in a Rust port; the guarantees it checks (authority preflight →
//!   projection → canonical write → renderer delivery) are enforced by the
//!   [`foreground_persistence`] ordering instead.
//! - `agent-compatibility.test.ts` drives `SubagentRuntimeRegistry` against the
//!   pi `Agent` loop; the registry state machine is ported in
//!   [`child_runtime`] and the compatibility matrix (`hasChatProviderResponse`,
//!   deployment limits, shutdown grace) is preserved there.
//! - `subagent-identifier-privacy.test.ts` tests `isSafeSubagentIdentifier`
//!   (ported in aiden-core + [`safe_text`]).
//! - Production host wiring (per-workspace `workspaceOperationRegistry`,
//!   MCP server config resolution, provider runtimes) stays behind injected
//!   traits, matching the TS "production-inert core" pattern.

pub mod approval;
pub mod authority;
pub mod background_lifecycle;
pub mod capability_profile;
pub mod child_runtime;
pub mod contracts;
pub mod control;
pub mod effect;
pub mod event_projector;
pub mod file_mutation;
pub mod file_mutator;
pub mod foreground_persistence;
pub mod forked_context;
pub mod health_metrics;
pub mod history_read;
pub mod mcp;
pub mod nesting;
pub mod network_budget;
pub mod outbound_approval;
pub mod packaged_soak;
pub mod request_capabilities;
pub mod run_store;
pub mod run_store_dispatcher;
pub mod run_store_migration;
pub mod run_store_production;
pub mod run_store_storage;
pub mod run_store_v2;
pub mod safe_text;
pub mod shell;
pub mod shell_runner;
pub mod supervisor;
pub mod workspace_write;
