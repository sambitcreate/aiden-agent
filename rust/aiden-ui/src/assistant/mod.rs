//! The proactive-assistant surface: an `AppView::Assistant` route rendering an
//! `AssistantPanel` entity (port of `renderer/components/assistant/*`).
//!
//! - [`view_state`] — pure transcript/approval state + the AgentEvent →
//!   view-state mapping (ports `use-assistant-chat.ts`).
//! - [`tool_executor`] — the runner's tool surface: identity tools, scheduling
//!   tools, and the enabled MCP connector tools collected on the shared
//!   `McpClientManager`.
//! - [`automation_approval`] — the inline automation proposal card
//!   (ports `assistant-automation-approval.tsx`).
//! - [`assistant_panel`] — the panel entity: thread, recent automations, the
//!   approval queue head, and the composer driving `aiden_agent::run_agent`.
//!
//! The approval bridge lives in [`crate::approvals`]: the runner's
//! `ApprovalPolicy` forwards gated calls to the panel's queue and awaits the
//! user's decision over a one-shot channel.

pub mod assistant_panel;
pub mod automation_approval;
pub mod thread;
pub mod tool_executor;
pub mod view_state;

pub use assistant_panel::{AssistantPanel, AssistantPanelDeps, AssistantPanelEvent};
