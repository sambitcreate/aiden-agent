//! The workspace bar's stateful core: git snapshots, detected editors, the
//! overlay router, and the pure display mappers the chips/pickers render.
//!
//! The entity holds no `ChatService` reference; [`WorkspaceState::set_mirror`]
//! receives the service's workspace list / active id / folder on every shell
//! notify and only restarts the git poll when the folder actually changed.
//! Every git and editor-detection call runs on the tokio bridge (via
//! [`gpui_tokio_bridge::Tokio`]), never on the GPUI foreground thread.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aiden_data::external_editors::{EditorCache, ResolvedExternalEditor, SystemEditorDiscovery};
use aiden_data::portable_config::Workspace;
use aiden_git::error::GitError;
use aiden_git::{
    GitBranches, GitCommitInput, GitCommitMode, GitErrorCode, GitInfo, GitPushCapability,
    GitPushInput, GitReview, GitService, GitServiceOptions, RunOptions,
};
use gpui::{
    div, px, App, AppContext as _, Context, Entity, EventEmitter, IntoElement as _,
    ParentElement as _, PathPromptOptions, SharedString, Task, Window,
};
use gpui_component::{
    input::{InputEvent, InputState},
    WindowExt as _,
};
use gpui_tokio_bridge::{JoinError, Tokio};
use tokio::sync::mpsc;

use super::git as git_surface;
use super::{bar, editors};

/// How often the git chip refreshes while the chat view is visible.
pub const GIT_POLL_INTERVAL: Duration = Duration::from_secs(15);

/// The overlay currently open from the workspace bar (one at a time — the
/// gpui-component dialog layer holds a single top dialog).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overlay {
    #[default]
    None,
    Workspaces,
    Branches,
    Commit,
    Push,
    Editors,
}

/// Notification severity for the shell's toast (`WorkspaceEvent::Notify`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    #[allow(dead_code)] // reserved for future info toasts
    Info,
    Success,
    Warning,
    Error,
}

/// Events the workspace bar emits to the shell (routed by `AppState`).
#[derive(Debug, Clone)]
pub enum WorkspaceEvent {
    /// Select a persisted workspace (route to `ChatService::select_workspace`).
    SelectWorkspace { id: String },
    /// A folder was chosen in the OS panel (route to
    /// `ChatService::add_workspace_from_folder`).
    AdoptFolder { folder: PathBuf },
    /// Show a toast notification.
    Notify {
        message: String,
        kind: NotificationKind,
    },
}

/// One message the git poll loop hands to the foreground watcher.
enum GitPollMsg {
    Info(Result<GitInfo, GitError>),
}

/// Owned render data for the bar chips, cloned out of the entity so the
/// render closures never hold a borrow across `cx.listener` captures.
#[derive(Debug, Clone, Default)]
pub(crate) struct WorkspaceBarSnapshot {
    pub(crate) git_info: Option<GitInfo>,
    pub(crate) git_error: Option<String>,
    pub(crate) active_folder: Option<PathBuf>,
    pub(crate) git_busy: bool,
    pub(crate) editors: Vec<ResolvedExternalEditor>,
    pub(crate) editors_loading: bool,
}

/// The git poll driver (tokio) + foreground watcher pair. The tasks are held
/// so their lifetime follows the poll lifecycle; the watch channel is the
/// explicit stop signal (gpui `Task` handles do not cancel on drop).
#[allow(dead_code)]
struct Poll {
    driver: Task<Result<(), JoinError>>,
    watcher: Task<()>,
    stop: tokio::sync::watch::Sender<bool>,
}

pub struct WorkspaceState {
    git: GitService,
    editor_cache: Arc<EditorCache>,

    // Mirrored from the chat service (pushed by AppState on every notify).
    pub(crate) active_id: Option<String>,
    pub(crate) active_folder: Option<PathBuf>,
    pub(crate) workspaces: Vec<Workspace>,

    // Git snapshots (all populated on the background).
    pub(crate) git_info: Option<GitInfo>,
    pub(crate) git_error: Option<String>,
    pub(crate) branches: Option<GitBranches>,
    pub(crate) review: Option<GitReview>,
    pub(crate) push_capability: Option<GitPushCapability>,
    /// A git mutation (checkout / create / commit / push) is in flight.
    pub(crate) git_busy: bool,

    // Detected editors.
    pub(crate) editors: Vec<ResolvedExternalEditor>,
    pub(crate) editors_loading: bool,

    // Overlay + dialog state.
    pub(crate) overlay: Overlay,
    /// Set when an async operation succeeded and the dialog should close on
    /// the next frame (the content builder defers the actual close).
    pub(crate) pending_close: bool,
    pub(crate) search_input: Entity<InputState>,
    pub(crate) branch_input: Entity<InputState>,
    pub(crate) commit_input: Entity<InputState>,
    pub(crate) push_input: Entity<InputState>,
    pub(crate) confirm_input: Entity<InputState>,
    pub(crate) branch_error: Option<String>,
    /// The branch picker is showing the create-a-branch form.
    pub(crate) branch_creating: bool,
    pub(crate) commit_mode: GitCommitMode,
    pub(crate) commit_error: Option<String>,
    pub(crate) push_remote: String,
    pub(crate) push_set_upstream: bool,
    pub(crate) push_force: bool,
    pub(crate) push_error: Option<String>,

    visible: bool,
    _poll: Option<Poll>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl WorkspaceState {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search…"));
        let branch_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("feature/my-branch"));
        let commit_input = cx.new(|cx| {
            InputState::new(window, cx)
                .auto_grow(2, 8)
                .placeholder("Describe this change")
        });
        let push_input = cx.new(|cx| InputState::new(window, cx));
        let confirm_input = cx
            .new(|cx| InputState::new(window, cx).placeholder("Type the destination branch name"));

        let mut this = Self {
            git: GitService::new(GitServiceOptions::default()),
            editor_cache: Arc::new(EditorCache::default()),
            active_id: None,
            active_folder: None,
            workspaces: Vec::new(),
            git_info: None,
            git_error: None,
            branches: None,
            review: None,
            push_capability: None,
            git_busy: false,
            editors: Vec::new(),
            editors_loading: false,
            overlay: Overlay::None,
            pending_close: false,
            search_input,
            branch_input,
            commit_input,
            push_input,
            confirm_input,
            branch_error: None,
            branch_creating: false,
            commit_mode: GitCommitMode::All,
            commit_error: None,
            push_remote: String::new(),
            push_set_upstream: true,
            push_force: false,
            push_error: None,
            visible: false,
            _poll: None,
            _subscriptions: Vec::new(),
        };

        // Enter in the branch-name field creates the branch; Enter in the
        // force-push confirm field pushes.
        this._subscriptions.push(cx.subscribe_in(
            &this.branch_input,
            window,
            |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::PressEnter { secondary: false }) {
                    this.create_branch(cx);
                }
            },
        ));
        this._subscriptions.push(cx.subscribe_in(
            &this.confirm_input,
            window,
            |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::PressEnter { secondary: false }) {
                    this.push_changes(cx);
                }
            },
        ));

        this
    }

    // =======================================================================
    // Shell sync + visibility
    // =======================================================================

    /// Mirror the chat service's workspace state into the bar. Only a folder
    /// change restarts the git poll / refresh, so message-streaming notifies
    /// stay cheap.
    pub fn set_mirror(
        &mut self,
        workspaces: Vec<Workspace>,
        active_id: Option<String>,
        folder: Option<PathBuf>,
        cx: &mut Context<Self>,
    ) {
        let folder_changed = self.active_folder != folder;
        self.workspaces = workspaces;
        self.active_id = active_id;
        self.active_folder = folder;
        if folder_changed {
            self.git_info = None;
            self.git_error = None;
            self.refresh_git_info(cx);
            if self.visible {
                self.start_poll(cx);
            }
        }
        cx.notify();
    }

    /// The chat view became visible (or hidden). While visible the git chip
    /// refreshes on focus and polls every [`GIT_POLL_INTERVAL`].
    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        if visible {
            self.refresh_git_info(cx);
            self.start_poll(cx);
        } else {
            self.stop_poll();
        }
        cx.notify();
    }

    /// Refresh-on-focus: always refresh when returning to the chat view, even
    /// if the bar was already visible.
    pub fn on_view_focused(&mut self, cx: &mut Context<Self>) {
        if self.visible {
            self.refresh_git_info(cx);
        }
        self.set_visible(true, cx);
    }

    // =======================================================================
    // Overlay routing
    // =======================================================================

    /// Open one of the bar's overlays, loading the data it needs first.
    pub fn open_overlay(&mut self, overlay: Overlay, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay == overlay {
            return;
        }
        self.close_dialog(window, cx);
        self.overlay = overlay;
        self.pending_close = false;
        match overlay {
            Overlay::Workspaces => {}
            Overlay::Branches => {
                self.branch_error = None;
                self.branch_creating = false;
                self.refresh_branches(cx);
            }
            Overlay::Commit => {
                self.commit_error = None;
                if let Some(review) = &self.review {
                    self.commit_mode = if review.summary.staged_files > 0 {
                        GitCommitMode::Staged
                    } else {
                        GitCommitMode::All
                    };
                }
                self.refresh_review(cx);
            }
            Overlay::Push => {
                self.push_error = None;
                self.push_force = false;
                self.confirm_input.update(cx, |input, inner| {
                    input.set_value("", window, inner);
                });
                self.refresh_push(cx);
            }
            Overlay::Editors => {
                self.refresh_editors(cx, true);
            }
            Overlay::None => {}
        }

        let entity = cx.entity();
        let focus = self.focus_for_overlay(overlay);
        window.open_dialog(cx, move |dialog, window, cx| {
            dialog
                .title(overlay_title(overlay))
                .close_button(true)
                .overlay_closable(true)
                .on_close({
                    let entity = entity.clone();
                    move |_, _window, cx| {
                        entity.update(cx, |this, cx| {
                            this.overlay = Overlay::None;
                            this.pending_close = false;
                            cx.notify();
                        });
                    }
                })
                .w(px(overlay_width(overlay)))
                .child(Self::overlay_content(&entity, window, cx))
        });
        // Focus the relevant input once the dialog content has rendered.
        cx.defer_in(window, move |_this, window, cx| {
            if let Some(input) = focus {
                input.update(cx, |input, cx| input.focus(window, cx));
            }
        });
    }

    /// Close the dialog + reset the overlay (has window access).
    pub fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.overlay = Overlay::None;
        self.pending_close = false;
        window.close_dialog(cx);
        cx.notify();
    }

    /// The dialog content for the active overlay. When an async operation set
    /// `pending_close`, defers the actual `close_dialog` to the end of the
    /// effect cycle (safe from inside the dialog's build closure).
    pub fn overlay_content(
        entity: &Entity<WorkspaceState>,
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::AnyElement {
        if entity.read(cx).pending_close {
            entity.update(cx, |this, cx| {
                this.overlay = Overlay::None;
                this.pending_close = false;
                cx.notify();
            });
            let entity = entity.clone();
            window.defer(cx, move |window, cx| {
                entity.update(cx, |this, cx| {
                    this.overlay = Overlay::None;
                    this.pending_close = false;
                    cx.notify();
                });
                window.close_dialog(cx);
            });
            return div().into_any_element();
        }
        match entity.read(cx).overlay {
            Overlay::Workspaces => bar::workspaces_content(entity, window, cx).into_any_element(),
            Overlay::Branches => {
                git_surface::branches_content(entity, window, cx).into_any_element()
            }
            Overlay::Commit => git_surface::commit_content(entity, window, cx).into_any_element(),
            Overlay::Push => git_surface::push_content(entity, window, cx).into_any_element(),
            Overlay::Editors => editors::editors_content(entity, window, cx).into_any_element(),
            Overlay::None => div().into_any_element(),
        }
    }

    fn focus_for_overlay(&self, overlay: Overlay) -> Option<Entity<InputState>> {
        match overlay {
            Overlay::Workspaces | Overlay::Branches | Overlay::Editors => {
                Some(self.search_input.clone())
            }
            Overlay::Commit => Some(self.commit_input.clone()),
            Overlay::Push => Some(self.push_input.clone()),
            Overlay::None => None,
        }
    }

    /// The owned snapshot the bar chips render from.
    pub(crate) fn bar_snapshot(&self) -> WorkspaceBarSnapshot {
        WorkspaceBarSnapshot {
            git_info: self.git_info.clone(),
            git_error: self.git_error.clone(),
            active_folder: self.active_folder.clone(),
            git_busy: self.git_busy,
            editors: self.editors.clone(),
            editors_loading: self.editors_loading,
        }
    }

    // =======================================================================
    // Git refresh (one-shot background reads)
    // =======================================================================

    fn refresh_all(&mut self, cx: &mut Context<Self>) {
        self.refresh_git_info(cx);
        self.refresh_branches(cx);
        self.refresh_review(cx);
        self.refresh_push(cx);
    }

    pub fn refresh_git_info(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.active_folder.clone() else {
            self.git_info = None;
            self.git_error = None;
            cx.notify();
            return;
        };
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::status::info(&git, &folder, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The git check was interrupted.",
                )),
            };
            this.update(cx, |this, cx| {
                match result {
                    Ok(info) => {
                        this.git_info = Some(info);
                        this.git_error = None;
                    }
                    Err(error) => this.git_error = Some(git_error_inline(&error)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn refresh_branches(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.active_folder.clone() else {
            self.branches = None;
            cx.notify();
            return;
        };
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::status::branches(&git, &folder, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The branch list could not be loaded.",
                )),
            };
            this.update(cx, |this, cx| {
                this.branches = result.ok();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn refresh_review(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.active_folder.clone() else {
            self.review = None;
            cx.notify();
            return;
        };
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::diff::review(&git, &folder, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The change review could not be loaded.",
                )),
            };
            this.update(cx, |this, cx| {
                this.review = result.ok();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn refresh_push(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.active_folder.clone() else {
            self.push_capability = None;
            cx.notify();
            return;
        };
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::push::push_capability(&git, &folder, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The push state could not be loaded.",
                )),
            };
            this.update(cx, |this, cx| {
                this.push_capability = result.ok();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // =======================================================================
    // Git mutations (all on the tokio bridge; dialogs close via pending_close)
    // =======================================================================

    /// Switch to an existing local branch (`git switch --no-guess`).
    pub fn checkout_branch(&mut self, name: &str, cx: &mut Context<Self>) {
        if self.git_busy {
            return;
        }
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        if self
            .branches
            .as_ref()
            .is_some_and(|branches| branches.current.as_deref() == Some(name))
        {
            return;
        }
        self.git_busy = true;
        self.branch_error = None;
        cx.notify();
        let git = self.git.clone();
        let name = name.to_string();
        let task = Tokio::spawn(cx, async move {
            aiden_git::branch::checkout(&git, &folder, &name, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The branch switch was interrupted.",
                )),
            };
            this.update(cx, |this, cx| {
                this.git_busy = false;
                match result {
                    Ok(()) => {
                        this.pending_close = true;
                        this.branch_error = None;
                        this.refresh_all(cx);
                    }
                    Err(error) => {
                        this.branch_error = Some(git_error_inline(&error));
                        this.refresh_branches(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Create and switch to a new local branch (`git switch -c`).
    pub fn create_branch(&mut self, cx: &mut Context<Self>) {
        if self.git_busy {
            return;
        }
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        let name = self.branch_input.read(cx).value().trim().to_string();
        if name.is_empty()
            || self
                .branches
                .as_ref()
                .is_some_and(|b| b.unborn.unwrap_or(false))
        {
            return;
        }
        self.git_busy = true;
        self.branch_error = None;
        cx.notify();
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::branch::create_branch(&git, &folder, &name, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "Branch creation was interrupted.",
                )),
            };
            this.update(cx, |this, cx| {
                this.git_busy = false;
                match result {
                    Ok(()) => {
                        this.pending_close = true;
                        this.branch_error = None;
                        this.refresh_all(cx);
                    }
                    Err(error) => {
                        this.branch_error = Some(git_error_inline(&error));
                        this.refresh_branches(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Commit the reviewed snapshot (staged-only or all changes).
    pub fn commit_changes(&mut self, cx: &mut Context<Self>) {
        if self.git_busy {
            return;
        }
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        let Some(review) = self.review.clone() else {
            self.commit_error = Some("Refresh Review before committing these changes.".into());
            cx.notify();
            return;
        };
        let Some(snapshot) = review.commit.snapshot.clone() else {
            self.commit_error = Some("Refresh Review before committing these changes.".into());
            cx.notify();
            return;
        };
        let message = self.commit_input.read(cx).value().trim().to_string();
        if message.is_empty() {
            self.commit_error =
                Some("Enter a commit message between 1 and 10,000 characters.".into());
            cx.notify();
            return;
        }
        if self.commit_mode == GitCommitMode::Staged && review.summary.staged_files == 0 {
            self.commit_error = Some("There are no staged changes to commit.".into());
            cx.notify();
            return;
        }
        self.git_busy = true;
        self.commit_error = None;
        cx.notify();
        let input = GitCommitInput {
            expected_snapshot: snapshot,
            message,
            mode: self.commit_mode,
        };
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::commit::commit(&git, &folder, input, None).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The commit was interrupted.",
                )),
            };
            this.update(cx, |this, cx| {
                this.git_busy = false;
                match result {
                    Ok(result) => {
                        this.pending_close = true;
                        this.commit_error = None;
                        this.refresh_all(cx);
                        cx.emit(WorkspaceEvent::Notify {
                            kind: NotificationKind::Success,
                            message: format!(
                                "Committed “{}” to {}.",
                                result.subject, result.branch
                            ),
                        });
                    }
                    Err(error) => {
                        this.commit_error = Some(git_error_inline(&error));
                        this.refresh_review(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Push the current branch (reviewed, never-fetch; `--force-with-lease`
    /// only when the user enabled it and typed the destination branch name).
    pub fn push_changes(&mut self, cx: &mut Context<Self>) {
        if self.git_busy {
            return;
        }
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        let Some(capability) = self.push_capability.clone() else {
            self.push_error = Some("Refresh the branch state before pushing.".into());
            cx.notify();
            return;
        };
        if !capability.allowed {
            self.push_error = Some(
                capability
                    .reason
                    .clone()
                    .unwrap_or_else(|| "This branch cannot be pushed from Aiden.".into()),
            );
            cx.notify();
            return;
        }
        let Some(expected_head) = capability.expected_head.clone() else {
            self.push_error = Some("Refresh the branch state before pushing.".into());
            cx.notify();
            return;
        };
        let Some(expected_branch) = capability.branch.clone() else {
            self.push_error = Some("Refresh the branch state before pushing.".into());
            cx.notify();
            return;
        };
        let remote = self.push_remote.trim().to_string();
        if remote.is_empty() {
            self.push_error = Some("Choose a configured Git remote.".into());
            cx.notify();
            return;
        }
        let destination = self.push_input.read(cx).value().trim().to_string();
        if destination.is_empty() {
            self.push_error = Some("Enter a valid destination branch.".into());
            cx.notify();
            return;
        }
        let Some(expected_remote_identity) = capability.remote_identities.get(&remote).cloned()
        else {
            self.push_error = Some("Refresh the remote state before pushing.".into());
            cx.notify();
            return;
        };
        let force = self.push_force;
        if force {
            let confirm = self.confirm_input.read(cx).value().trim().to_string();
            if confirm != destination {
                self.push_error =
                    Some("Type the destination branch name to confirm the force push.".into());
                cx.notify();
                return;
            }
        }
        self.git_busy = true;
        self.push_error = None;
        cx.notify();
        let set_upstream = self.push_set_upstream;
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            // Resolve the force-with-lease pin (the remote-tracking ref OID)
            // and push in the same background task so the reviewed inputs stay
            // internally consistent.
            let result = {
                let force_with_lease = if force {
                    let tracking = format!("refs/remotes/{remote}/{destination}");
                    let probe = git
                        .run(
                            &folder,
                            &["rev-parse", "--verify", &tracking],
                            RunOptions {
                                allow_exit_codes: &[128],
                                ..RunOptions::default()
                            },
                        )
                        .await?;
                    let oid = probe.stdout.trim().to_string();
                    if probe.exit_code == 0
                        && (40..=64).contains(&oid.len())
                        && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        Some(oid)
                    } else {
                        None
                    }
                } else {
                    None
                };
                let input = GitPushInput {
                    destination_branch: destination,
                    expected_branch,
                    expected_head,
                    expected_remote_identity,
                    remote,
                    set_upstream,
                    force_with_lease,
                };
                aiden_git::push::push(&git, &folder, input, None).await
            };
            result
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The push was interrupted.",
                )),
            };
            this.update(cx, |this, cx| {
                this.git_busy = false;
                match result {
                    Ok(result) => {
                        this.pending_close = true;
                        this.push_error = None;
                        this.refresh_all(cx);
                        cx.emit(WorkspaceEvent::Notify {
                            kind: NotificationKind::Success,
                            message: format!(
                                "Pushed {} to {}/{}.",
                                result.branch, result.remote, result.destination_branch
                            ),
                        });
                        if let Some(warning) = result.warning {
                            cx.emit(WorkspaceEvent::Notify {
                                kind: NotificationKind::Warning,
                                message: warning,
                            });
                        }
                    }
                    Err(error) => {
                        this.push_error = Some(git_error_inline(&error));
                        this.refresh_push(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Open the macOS folder panel and emit [`WorkspaceEvent::AdoptFolder`].
    pub fn choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_dialog(window, cx);
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(SharedString::from("Choose a workspace folder")),
        });
        cx.spawn(async move |this, cx| {
            let folder = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            if let Some(folder) = folder {
                this.update(cx, |_this, cx| {
                    cx.emit(WorkspaceEvent::AdoptFolder { folder });
                })
                .ok();
            }
        })
        .detach();
    }

    // =======================================================================
    // Editors
    // =======================================================================

    /// Detect installed editors on the background (bounded 15 s cache).
    pub fn refresh_editors(&mut self, cx: &mut Context<Self>, force: bool) {
        self.editors_loading = true;
        cx.notify();
        let cache = self.editor_cache.clone();
        let task = Tokio::spawn(cx, async move {
            tokio::task::spawn_blocking(move || cache.get(force, &SystemEditorDiscovery))
                .await
                .unwrap_or_default()
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let editors = result.unwrap_or_default();
            this.update(cx, |this, cx| {
                this.editors = editors;
                this.editors_loading = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Launch the workspace folder in the given editor (`open -b <bundleId>`
    /// via `aiden-data`); failures surface as error notifications.
    pub fn open_in_editor(&mut self, editor_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        let Some(editor) = self
            .editors
            .iter()
            .find(|editor| editor.id == editor_id)
            .cloned()
        else {
            cx.emit(WorkspaceEvent::Notify {
                kind: NotificationKind::Error,
                message: "That editor is no longer installed.".into(),
            });
            return;
        };
        self.close_dialog(window, cx);
        let folder = folder.display().to_string();
        let editor_label = editor.label.clone();
        let editor_id = editor.id.clone();
        let editors = self.editors.clone();
        let task = Tokio::spawn(cx, async move {
            tokio::task::spawn_blocking(move || {
                aiden_data::external_editors::open_folder_in_external_editor(
                    &folder, &editor_id, &editors,
                )
            })
            .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let message = match result {
                Ok(Ok(Ok(()))) => None,
                Ok(Ok(Err(error))) => Some(error.to_string()),
                _ => Some("The editor launch was interrupted.".to_string()),
            };
            this.update(cx, |_this, cx| {
                if let Some(message) = message {
                    cx.emit(WorkspaceEvent::Notify {
                        kind: NotificationKind::Error,
                        message: format!(
                            "Couldn't open this workspace in {editor_label}: {message}"
                        ),
                    });
                }
            })
            .ok();
        })
        .detach();
    }

    // =======================================================================
    // Git poll (15 s while visible; explicit stop via a watch channel)
    // =======================================================================

    fn start_poll(&mut self, cx: &mut Context<Self>) {
        self.stop_poll();
        let Some(folder) = self.active_folder.clone() else {
            return;
        };
        let git = self.git.clone();
        let (stop, stop_rx) = tokio::sync::watch::channel(false);
        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<GitPollMsg>();
        let mut driver_stop = stop_rx.clone();
        let watcher = cx.spawn(async move |this, cx| {
            let mut rx = msg_rx;
            let stopped = stop_rx;
            while let Some(msg) = rx.recv().await {
                if *stopped.borrow() {
                    break;
                }
                this.update(cx, |this, cx| {
                    match msg {
                        GitPollMsg::Info(result) => match result {
                            Ok(info) => {
                                this.git_info = Some(info);
                                this.git_error = None;
                            }
                            Err(error) => this.git_error = Some(git_error_inline(&error)),
                        },
                    }
                    cx.notify();
                })
                .ok();
            }
        });
        let driver = Tokio::spawn(cx, async move {
            loop {
                let info = aiden_git::status::info(&git, &folder, None).await;
                let _ = msg_tx.send(GitPollMsg::Info(info));
                tokio::select! {
                    _ = tokio::time::sleep(GIT_POLL_INTERVAL) => {}
                    changed = driver_stop.changed() => {
                        let _ = changed;
                        break;
                    }
                }
            }
        });
        self._poll = Some(Poll {
            driver,
            watcher,
            stop,
        });
    }

    fn stop_poll(&mut self) {
        if let Some(poll) = self._poll.take() {
            let _ = poll.stop.send(true);
        }
    }
}

impl EventEmitter<WorkspaceEvent> for WorkspaceState {}

fn overlay_title(overlay: Overlay) -> &'static str {
    match overlay {
        Overlay::Workspaces => "Choose a workspace",
        Overlay::Branches => "Switch branch",
        Overlay::Commit => "Commit changes",
        Overlay::Push => "Push branch",
        Overlay::Editors => "Open in editor",
        Overlay::None => "Workspace",
    }
}

fn overlay_width(overlay: Overlay) -> f32 {
    match overlay {
        Overlay::Commit | Overlay::Push => 460.0,
        _ => 380.0,
    }
}

// ===========================================================================
// Pure display mappers (unit-tested)
// ===========================================================================

/// The git chip state: branch label, dirty dot, ahead/behind, tooltip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitChipState {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u64,
    pub behind: u64,
    /// "main · 3 changes · ↑2 ↓1" tooltip text.
    pub summary: String,
}

pub fn git_chip_from_info(info: &GitInfo) -> Option<GitChipState> {
    if !info.is_repo {
        return None;
    }
    let detached = info.detached.unwrap_or(false);
    let unborn = info.unborn.unwrap_or(false);
    let branch = if unborn {
        info.branch
            .clone()
            .unwrap_or_else(|| "Unborn branch".to_string())
    } else if detached {
        "Detached HEAD".to_string()
    } else {
        info.branch
            .clone()
            .unwrap_or_else(|| "Unknown branch".to_string())
    };
    let uncommitted = info.uncommitted.unwrap_or(0);
    let dirty = uncommitted > 0;
    let ahead = info.ahead.unwrap_or(0);
    let behind = info.behind.unwrap_or(0);
    let mut parts: Vec<String> = vec![branch.clone()];
    if unborn {
        parts.push("No commits yet".to_string());
    }
    if dirty {
        parts.push(format!(
            "{uncommitted} change{}",
            if uncommitted == 1 { "" } else { "s" }
        ));
    }
    if ahead > 0 {
        parts.push(format!("↑{ahead}"));
    }
    if behind > 0 {
        parts.push(format!("↓{behind}"));
    }
    Some(GitChipState {
        branch,
        dirty,
        ahead,
        behind,
        summary: parts.join(" · "),
    })
}

/// The branch picker's local list with the current branch pinned first
/// (the rest keep git's committerdate order from `status::branches`).
pub fn order_local_branches(branches: &GitBranches) -> Vec<String> {
    let mut ordered = branches.branches.clone();
    if let Some(current) = &branches.current {
        if let Some(index) = ordered.iter().position(|branch| branch == current) {
            let pinned = ordered.remove(index);
            ordered.insert(0, pinned);
        }
    }
    ordered
}

fn plural(count: u64) -> &'static str {
    if count == 1 {
        "file"
    } else {
        "files"
    }
}

/// The commit dialog's selection description (TS `selectionDescription`).
pub fn commit_selection_description(review: &GitReview, mode: GitCommitMode) -> String {
    match mode {
        GitCommitMode::Staged => format!(
            "{} staged {}; unstaged portions stay in the working tree.",
            review.summary.staged_files,
            plural(review.summary.staged_files),
        ),
        GitCommitMode::All => format!(
            "{} changed {}, including untracked files.",
            review.summary.file_count,
            plural(review.summary.file_count),
        ),
    }
}

/// The editor the open-in-editor chip should launch by default (priority
/// order, Finder last — the ranking is a passthrough of `aiden-data`'s
/// priority sort).
pub fn preferred_editor(editors: &[ResolvedExternalEditor]) -> Option<&ResolvedExternalEditor> {
    editors
        .iter()
        .find(|editor| editor.id != "finder")
        .or_else(|| editors.first())
}

/// Case-insensitive workspace picker filter (name or folder path).
pub fn filter_workspaces<'a>(workspaces: &'a [Workspace], query: &str) -> Vec<&'a Workspace> {
    let query = query.trim().to_lowercase();
    workspaces
        .iter()
        .filter(|workspace| {
            query.is_empty()
                || workspace.name.to_lowercase().contains(&query)
                || workspace
                    .folder_path
                    .as_deref()
                    .map(|path| path.to_lowercase().contains(&query))
                    .unwrap_or(false)
        })
        .collect()
}

/// Case-insensitive branch picker filter.
pub fn filter_branches<'a>(branches: &'a [String], query: &str) -> Vec<&'a str> {
    let query = query.trim().to_lowercase();
    branches
        .iter()
        .filter(|branch| query.is_empty() || branch.to_lowercase().contains(&query))
        .map(String::as_str)
        .collect()
}

/// A taxonomy-driven hint appended to git error text based on the error code
/// (auth / conflict / dirty-tree messaging per the requirement).
pub fn git_error_hint(code: GitErrorCode) -> Option<&'static str> {
    match code {
        GitErrorCode::AuthFailed => Some("Check your Git credentials and try again."),
        GitErrorCode::Conflicted => Some("Resolve the merge conflicts before continuing."),
        GitErrorCode::DirtyWorktree => Some("Commit or stash your local changes first."),
        GitErrorCode::Unborn => Some("Create the repository's first commit to continue."),
        GitErrorCode::NotRepo => Some("This workspace is not a Git repository."),
        GitErrorCode::StaleSnapshot => Some("The Git state changed. Refresh and retry."),
        GitErrorCode::Timeout => Some("Git did not respond in time. Try again."),
        GitErrorCode::InvalidRef => Some("That name is not a valid Git reference."),
        GitErrorCode::InvalidInput => Some("Check the entered values and try again."),
        _ => None,
    }
}

/// The inline dialog/chip error text: the public git message plus the
/// taxonomy hint when one applies.
pub fn git_error_inline(error: &GitError) -> String {
    match git_error_hint(error.code) {
        Some(hint) => format!("{}. {hint}", error.message.trim_end_matches('.')),
        None => error.message.clone(),
    }
}

/// `truncatePathMiddle` (renderer/lib/truncate-path.ts): keep the leading
/// root and the trailing leaf, ellipsis in the middle.
pub fn truncate_path_middle(path: &str, max_length: usize) -> String {
    let value = path.trim();
    if max_length == 0 {
        return String::new();
    }
    if value.chars().count() <= max_length {
        return value.to_string();
    }
    let ellipsis = "…";
    if max_length <= ellipsis.chars().count() {
        return ellipsis.to_string();
    }
    let budget = max_length - ellipsis.chars().count();
    let sep = if value.contains('/') {
        Some("/")
    } else if value.contains('\\') {
        Some("\\")
    } else {
        None
    };
    if let Some(sep) = sep {
        let parts: Vec<&str> = value.split(sep).collect();
        if parts.len() >= 2 {
            let is_absolute_unix = parts[0].is_empty();
            let is_windows_drive = parts[0].len() == 2
                && parts[0]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && parts[0].chars().nth(1) == Some(':');
            let preferred_left = if (is_absolute_unix || is_windows_drive) && parts.len() >= 3 {
                2
            } else {
                1
            };
            let mut left_count = preferred_left;
            let mut right_count = 1;
            let mut candidate = format_path_ends(&parts, left_count, right_count, sep, ellipsis);
            if candidate.chars().count() > max_length && left_count > 1 {
                left_count = 1;
                candidate = format_path_ends(&parts, left_count, right_count, sep, ellipsis);
            }
            if candidate.chars().count() <= max_length {
                while left_count + right_count < parts.len() {
                    let grow_right = right_count <= left_count;
                    let next_left = if grow_right {
                        left_count
                    } else {
                        left_count + 1
                    };
                    let next_right = if grow_right {
                        right_count + 1
                    } else {
                        right_count
                    };
                    if next_left + next_right > parts.len() {
                        break;
                    }
                    let next = format_path_ends(&parts, next_left, next_right, sep, ellipsis);
                    if next.chars().count() > max_length {
                        break;
                    }
                    left_count = next_left;
                    right_count = next_right;
                    candidate = next;
                }
                if candidate.contains(ellipsis) {
                    return candidate;
                }
            }
        }
    }
    let head = budget.div_ceil(2);
    let tail = budget / 2;
    let chars: Vec<char> = value.chars().collect();
    let head_str: String = chars.iter().take(head).collect();
    let tail_str: String = chars.iter().rev().take(tail).collect();
    format!("{head_str}{ellipsis}{tail_str}")
}

fn format_path_ends(
    parts: &[&str],
    left_count: usize,
    right_count: usize,
    sep: &str,
    ellipsis: &str,
) -> String {
    let left = &parts[..left_count];
    let right = &parts[parts.len() - right_count..];
    let prefix = if left[0].is_empty() {
        format!("{sep}{}", left[1..].join(sep))
    } else {
        left.join(sep)
    };
    let suffix = right.join(sep);
    if left_count + right_count >= parts.len() {
        if left[0].is_empty() {
            format!("{sep}{}", parts[1..].join(sep))
        } else {
            parts.join(sep)
        }
    } else if prefix.ends_with(sep) || prefix == sep {
        format!("{prefix}{ellipsis}{sep}{suffix}")
    } else {
        format!("{prefix}{sep}{ellipsis}{sep}{suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(branch: &str, uncommitted: u64, ahead: u64, behind: u64) -> GitInfo {
        GitInfo {
            is_repo: true,
            branch: Some(branch.to_string()),
            detached: Some(false),
            unborn: Some(false),
            uncommitted: Some(uncommitted),
            upstream: Some("origin/main".to_string()),
            ahead: Some(ahead),
            behind: Some(behind),
            default_branch: Some("main".to_string()),
            has_remote: Some(true),
            remote_state: Some("local-ref".to_string()),
        }
    }

    #[test]
    fn git_chip_formats_branch_dirty_and_ahead_behind() {
        let chip = git_chip_from_info(&info("main", 3, 2, 1)).unwrap();
        assert_eq!(chip.branch, "main");
        assert!(chip.dirty);
        assert_eq!(chip.ahead, 2);
        assert_eq!(chip.behind, 1);
        assert_eq!(chip.summary, "main · 3 changes · ↑2 · ↓1");

        let clean = git_chip_from_info(&info("main", 0, 0, 0)).unwrap();
        assert!(!clean.dirty);
        assert_eq!(clean.summary, "main");
    }

    #[test]
    fn git_chip_detects_detached_and_unborn_heads() {
        let mut detached = info("12345678", 1, 0, 0);
        detached.detached = Some(true);
        let chip = git_chip_from_info(&detached).unwrap();
        assert_eq!(chip.branch, "Detached HEAD");

        let mut unborn = info("main", 0, 0, 0);
        unborn.unborn = Some(true);
        let chip = git_chip_from_info(&unborn).unwrap();
        assert_eq!(chip.branch, "main");
        assert!(chip.summary.contains("No commits yet"));
    }

    #[test]
    fn git_chip_is_none_outside_a_repository() {
        assert_eq!(git_chip_from_info(&GitInfo::not_repo()), None);
    }

    #[test]
    fn git_chip_pluralizes_single_change() {
        let chip = git_chip_from_info(&info("main", 1, 0, 0)).unwrap();
        assert_eq!(chip.summary, "main · 1 change");
    }

    #[test]
    fn local_branches_pin_the_current_first() {
        let branches = GitBranches {
            is_repo: true,
            current: Some("feature".to_string()),
            branches: vec!["main".into(), "feature".into(), "topic".into()],
            remote_branches: vec![],
            uncommitted: 0,
            detached: None,
            unborn: None,
            upstream: None,
            ahead: None,
            behind: None,
            default_branch: None,
            has_remote: None,
            remote_state: None,
        };
        assert_eq!(
            order_local_branches(&branches),
            vec!["feature", "main", "topic"]
        );
    }

    #[test]
    fn local_branches_without_current_keep_order() {
        let branches = GitBranches {
            is_repo: true,
            current: None,
            branches: vec!["main".into(), "topic".into()],
            remote_branches: vec![],
            uncommitted: 0,
            detached: Some(true),
            unborn: None,
            upstream: None,
            ahead: None,
            behind: None,
            default_branch: None,
            has_remote: None,
            remote_state: None,
        };
        assert_eq!(order_local_branches(&branches), vec!["main", "topic"]);
    }

    #[test]
    fn commit_selection_descriptions_match_the_renderer() {
        let review = GitReview {
            is_repo: true,
            branch: Some("main".into()),
            files: vec![],
            summary: aiden_git::GitReviewSummary {
                file_count: 4,
                additions: 10,
                deletions: 2,
                unavailable_stats: 0,
                staged_files: 3,
                unstaged_files: 1,
                conflicted_files: 0,
            },
            commit: aiden_git::GitCommitCapability {
                allowed: true,
                reason: None,
                snapshot: Some("0".repeat(40)),
                snapshot_complete: true,
                repository_root: true,
            },
        };
        assert_eq!(
            commit_selection_description(&review, GitCommitMode::Staged),
            "3 staged files; unstaged portions stay in the working tree."
        );
        assert_eq!(
            commit_selection_description(&review, GitCommitMode::All),
            "4 changed files, including untracked files."
        );
        let one = GitReview {
            summary: aiden_git::GitReviewSummary {
                file_count: 1,
                staged_files: 1,
                ..Default::default()
            },
            ..review
        };
        assert_eq!(
            commit_selection_description(&one, GitCommitMode::All),
            "1 changed file, including untracked files."
        );
    }

    #[test]
    fn preferred_editor_skips_finder_and_keeps_priority_order() {
        let editors = vec![
            ResolvedExternalEditor {
                id: "cursor".into(),
                label: "Cursor".into(),
                app_path: "/Applications/Cursor.app".into(),
                bundle_id: "com.todesktop.230313mzl4w4u92".into(),
                icon_data_url: String::new(),
            },
            ResolvedExternalEditor {
                id: "finder".into(),
                label: "Finder".into(),
                app_path: "/System/Library/CoreServices/Finder.app".into(),
                bundle_id: "com.apple.finder".into(),
                icon_data_url: String::new(),
            },
        ];
        // Ranking passthrough: definition priority order, Finder last.
        assert_eq!(editors.last().unwrap().id, "finder");
        assert_eq!(preferred_editor(&editors).unwrap().id, "cursor");
        assert_eq!(preferred_editor(&[]), None);
    }

    #[test]
    fn workspace_and_branch_filters_are_case_insensitive() {
        let workspaces = vec![
            Workspace {
                id: "w1".into(),
                name: "Aiden Agent".into(),
                folder_path: Some("/Users/sambit/projects/aiden-agent".into()),
                permission: aiden_data::portable_config::WorkspacePermission::Ask,
                managed_worktree: None,
                created_at: 1,
                updated_at: 1,
            },
            Workspace {
                id: "w2".into(),
                name: "Docs".into(),
                folder_path: None,
                permission: aiden_data::portable_config::WorkspacePermission::Ask,
                managed_worktree: None,
                created_at: 2,
                updated_at: 2,
            },
        ];
        assert_eq!(filter_workspaces(&workspaces, "aiden").len(), 1);
        assert_eq!(filter_workspaces(&workspaces, "PROJECTS").len(), 1);
        assert_eq!(filter_workspaces(&workspaces, "").len(), 2);

        let branches = vec!["main".to_string(), "FEATURE/x".to_string()];
        assert_eq!(filter_branches(&branches, "feature"), vec!["FEATURE/x"]);
        assert_eq!(filter_branches(&branches, "").len(), 2);
    }

    #[test]
    fn git_error_inline_appends_taxonomy_hints() {
        let auth = GitError::new(GitErrorCode::AuthFailed, "Authentication failed.");
        assert_eq!(
            git_error_inline(&auth),
            "Authentication failed. Check your Git credentials and try again."
        );
        let generic = GitError::new(GitErrorCode::CommandFailed, "Something broke.");
        assert_eq!(git_error_inline(&generic), "Something broke.");
        assert_eq!(
            git_error_hint(GitErrorCode::Conflicted),
            Some("Resolve the merge conflicts before continuing.")
        );
    }

    #[test]
    fn truncate_path_keeps_root_and_leaf() {
        assert_eq!(
            truncate_path_middle("/Users/sambit/projects/aiden-agent", 44),
            "/Users/sambit/projects/aiden-agent"
        );
        let short = truncate_path_middle(
            "/Users/sambit/very/deeply/nested/project/repository/folder/src/lib.rs",
            44,
        );
        assert!(short.starts_with("/Users/"));
        assert!(short.ends_with("lib.rs"));
        assert!(short.contains('…'));
        assert!(short.chars().count() <= 44);
    }

    #[test]
    fn truncate_path_falls_back_to_character_budget_without_separators() {
        let value = "abcdefghijklmnopqrstuvwxyz0123456789";
        let truncated = truncate_path_middle(value, 20);
        assert_eq!(truncated.chars().count(), 20); // 19 chars + ellipsis
        assert!(truncated.contains('…'));
    }
}
