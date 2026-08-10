//! Workspace context bar + git controls (port of `workspace-picker.tsx`,
//! `git-branch-picker.tsx`, `git-commit-dialog.tsx`, `git-push-dialog.tsx`,
//! and `open-in-editor-picker.tsx`).
//!
//! The bar renders inside the chat pane header: a workspace chip (name/path,
//! opens the workspace picker), a git chip (branch name, dirty dot,
//! ahead/behind, opens the branch picker with commit/push dialogs), and an
//! open-in-editor chip (detected editors from `aiden-data`). All git and
//! editor-detection calls run on the tokio bridge; the chip's git status
//! refreshes on view focus and every 15 s while the chat view is visible.

mod bar;
mod editors;
mod git;
mod state;

pub(crate) use state::{
    preferred_editor, NotificationKind, Overlay, WorkspaceEvent, WorkspaceState,
};
