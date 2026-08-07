//! Aiden scheduled tasks — runtime, contract, and validation (port of the
//! Electron `main/services/schedule-*.ts` `-core` modules).
//!
//! Layout mirrors the TS split:
//!
//! - **`runtime`** — `schedule-service-core.ts`: the tokio-based scheduler
//!   runtime. A tick loop (default 30s cadence) loads due tasks from the
//!   `aiden-data` `ScheduleStore` (which owns `schedules.json` +
//!   `schedule-runs.json` and the cron evaluator) and dispatches each to a
//!   [`runtime::TaskExecutor`] trait implementation (the UI/agent wires real
//!   chat execution later). Runs are recorded back through the store, missed
//!   runs are caught up **once** at startup (matching the TS `start()` check
//!   `nextRunAt < now`), and one-shot vs cron schedules are distinguished only
//!   by their cron expression (`@once`-style expressions are not a thing in
//!   croner; a cron that has no future run is simply never due again).
//! - **`notification`** — `schedule-notification.ts`: pure decision logic for
//!   showing a macOS notification (opt-out, platform support, body
//!   normalization/truncation, click-to-open-chat).
//! - **`settings`** — `scheduled-settings-core.ts`: sparse settings patch
//!   projection for the Schedules settings surface.
//! - **`script`** — `schedule-script.ts`: script-mode task runner
//!   (resolution inside `~/.aiden/scripts` + workspace roots with symlink
//!   confinement, bounded subprocess execution with timeout/output caps).
//! - **`binding`** — `schedule-mcp-binding.ts` + `schedule-provider-binding.ts`:
//!   exact connection fingerprints that pin an approved automation to the
//!   connection properties that choose the inference recipient.
//! - **`tool`** — `schedule-tool.ts` + `renderer/shared/assistant.ts` limits:
//!   the agent-callable schedule tool contract, proposal normalization, and
//!   validation, plus the attended Assistant create/list/edit tool family.
//!
//! The guard logic (`schedule-guard.ts`) — MCP id/binding validation, the
//! assistant execution boundary, and the prompt guard — was already ported in
//! `aiden-data::schedule_store`, and this crate reuses it.

#![allow(clippy::type_complexity)]

pub mod binding;
pub mod notification;
pub mod runtime;
pub mod script;
pub mod settings;
pub mod tool;
