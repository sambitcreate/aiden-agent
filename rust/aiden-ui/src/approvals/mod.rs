//! Reusable approval surfaces: the pending-approval queue reducer, the
//! UI-bound [`ApprovalPolicy`](approval_bridge::ApprovalBridge) that bridges
//! the agent runner to the UI, and the shared approval cards (tool, shell
//! command, MCP mutation) that render an approval's facts and emit typed
//! decisions.
//!
//! Ports of `renderer/components/subagent-shell-approval.tsx`,
//! `subagent-mcp-mutation-approval.tsx`, and the tool-approval language of
//! `git-commit-dialog.tsx` / `git-push-dialog.tsx` (confirm with a reason
//! before acting; fail closed when details are malformed).

pub mod approval_bridge;
pub mod mcp_mutation_approval;
pub mod queue;
pub mod shell_approval;
pub mod tool_approval_card;

pub use approval_bridge::ApprovalDecision;
