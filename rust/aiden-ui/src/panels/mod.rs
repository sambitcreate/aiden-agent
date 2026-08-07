//! Main-window surface panels (port of `renderer/components/*`): command
//! palette, terminal drawer, subagent roster, scheduled tasks, and the
//! profile/usage view.
//!
//! Every panel is a standalone `Entity` with a `new(cx, deps)` constructor
//! that takes `Arc`'d service dependencies. Panels only emit events
//! (`cx.emit`) for actions the orchestrator turns into service calls, so they
//! never touch `app.rs`/`services` directly. `app.rs` wires the real
//! store-backed adapters; the in-memory demo sources remain for standalone
//! exercise and tests.

pub mod command_palette;
pub mod scheduled_panel;
pub mod subagents_panel;
pub mod terminal_drawer;
pub mod usage_panel;
