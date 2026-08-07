//! Main-window surface panels (port of `renderer/components/*`): command
//! palette, terminal drawer, subagent roster, scheduled tasks, and the
//! profile/usage view.
//!
//! Every panel is a standalone `Entity` with a `new(cx, deps)` constructor
//! that takes `Arc`'d service dependencies (traits the orchestrator wires to
//! the real stores in a later phase). Panels only emit events (`cx.emit`)
//! for actions the orchestrator turns into service calls, so they never touch
//! `app.rs`/`services` directly.
//!
//! Panels are public API surfaces for the orchestrator; until it wires them
//! into `app.rs` the whole module is unreferenced, so dead code is expected.
#![allow(dead_code)]

pub mod command_palette;
pub mod scheduled_panel;
pub mod subagents_panel;
pub mod terminal_drawer;
pub mod usage_panel;
