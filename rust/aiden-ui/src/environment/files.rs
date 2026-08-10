use std::collections::BTreeSet;
use std::path::PathBuf;

use aiden_data::portable_config::{Workspace, WorkspacePermission};
use gpui::{
    div, prelude::FluentBuilder as _, px, AnyElement, AppContext as _, Context, ElementId, Entity,
    EventEmitter, FocusHandle, FontWeight, InteractiveElement as _, IntoElement as _,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
};

use crate::app::AppState;
use crate::workspace_files::{
    list_workspace_files_cancellable, read_workspace_file_cancellable,
    write_workspace_file_cancellable, WorkspaceFileCancellation, WorkspaceFileDocument,
    WorkspaceFileEntry, WorkspaceFileErrorCode, WorkspaceFileIndex, WorkspaceFileKind,
};

pub const FILE_TREE_WIDTH: f32 = 190.0;
pub const FILE_TOOLBAR_HEIGHT: f32 = 40.0;
pub const FILE_ROW_HEIGHT: f32 = 28.0;
pub const FILES_COMPACT_BREAKPOINT: f32 = 540.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesEditorSnapshot {
    pub workspace_id: Option<String>,
    pub path: Option<String>,
    pub dirty: bool,
    pub saving: bool,
}

#[derive(Debug, Clone)]
pub enum FilesEvent {
    StateChanged(FilesEditorSnapshot),
    ExternalDiscardRequested,
    ExternalDiscardCancelled,
    Notification(FilesNotification),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilesNotification {
    Warning(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SaveIssue {
    code: WorkspaceFileErrorCode,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiscardConfirmation {
    OpenPath(String),
    BackToTree,
    Reload,
    ExternalMutation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RequestToken {
    generation: u64,
}

fn request_is_current(current: u64, token: RequestToken) -> bool {
    current == token.generation
}

fn compact_files_layout(width: f32) -> bool {
    width < FILES_COMPACT_BREAKPOINT
}

pub(crate) fn compact_files_for_environment(preferred_width: f32, container_width: f32) -> bool {
    compact_files_layout(super::layout::resolve_layout(preferred_width, container_width).width)
}

fn workspace_identity_changed(current: Option<&Workspace>, next: Option<&Workspace>) -> bool {
    match (current, next) {
        (Some(current), Some(next)) => {
            current.id != next.id
                || current.folder_path != next.folder_path
                || current.permission != next.permission
        }
        (None, None) => false,
        _ => true,
    }
}

fn workspace_files_available(workspace: Option<&Workspace>, root_present: bool) -> bool {
    root_present
        && workspace.is_some_and(|workspace| {
            workspace.folder_path.is_some() && workspace.permission != WorkspacePermission::None
        })
}

fn can_save_document(
    available: bool,
    dirty: bool,
    saving: bool,
    loading: bool,
    blocked: bool,
    confirmation_open: bool,
) -> bool {
    available && dirty && !saving && !loading && !blocked && !confirmation_open
}

fn should_apply_document_read(
    current_generation: u64,
    token: RequestToken,
    selected_path: Option<&str>,
    requested_path: &str,
    loading: bool,
) -> bool {
    loading
        && request_is_current(current_generation, token)
        && selected_path == Some(requested_path)
}

fn document_warning(document: &WorkspaceFileDocument) -> Option<String> {
    document.warning.clone()
}

fn keyboard_activates(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

fn resolved_active_path<'a>(
    visible: &'a [String],
    active: Option<&str>,
    selected: Option<&str>,
) -> Option<&'a str> {
    active
        .and_then(|path| visible.iter().find(|visible| visible.as_str() == path))
        .or_else(|| {
            selected.and_then(|path| visible.iter().find(|visible| visible.as_str() == path))
        })
        .or_else(|| visible.first())
        .map(String::as_str)
}

fn roving_target<'a>(visible: &'a [String], active: Option<&str>, key: &str) -> Option<&'a str> {
    let current = resolved_active_path(visible, active, None)?;
    let index = visible.iter().position(|path| path == current)?;
    let target = match key {
        "up" => index.saturating_sub(1),
        "down" => (index + 1).min(visible.len() - 1),
        "home" => 0,
        "end" => visible.len() - 1,
        _ => return None,
    };
    Some(visible[target].as_str())
}

fn expand_ancestors(path: &str, expanded: &mut BTreeSet<String>) {
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    let mut parent = String::new();
    for part in parts {
        if !parent.is_empty() {
            parent.push('/');
        }
        parent.push_str(part);
        expanded.insert(parent.clone());
    }
}

fn entry_visible(entry: &WorkspaceFileEntry, query: &str, expanded: &BTreeSet<String>) -> bool {
    let query = query.trim().to_lowercase();
    if !query.is_empty() {
        return entry.kind == WorkspaceFileKind::File && entry.path.to_lowercase().contains(&query);
    }
    if entry.parent_path.is_empty() {
        return true;
    }
    let mut parent = String::new();
    entry.parent_path.split('/').all(|part| {
        if !parent.is_empty() {
            parent.push('/');
        }
        parent.push_str(part);
        expanded.contains(&parent)
    })
}

pub struct FilesWorkbench {
    workspace: Option<Workspace>,
    root: Option<PathBuf>,
    index: Option<WorkspaceFileIndex>,
    index_loading: bool,
    index_error: Option<String>,
    index_generation: u64,
    index_cancellation: WorkspaceFileCancellation,
    read_generation: u64,
    read_cancellation: WorkspaceFileCancellation,
    save_generation: u64,
    save_cancellation: WorkspaceFileCancellation,
    expanded: BTreeSet<String>,
    selected_path: Option<String>,
    active_path: Option<String>,
    compact_detail: bool,
    document: Option<WorkspaceFileDocument>,
    document_loading: bool,
    document_error: Option<String>,
    baseline: String,
    saving: bool,
    saved: bool,
    save_issue: Option<SaveIssue>,
    wrap: bool,
    confirmation: Option<DiscardConfirmation>,
    interaction_blocked: bool,
    suppress_editor_event: bool,
    pub search_input: Entity<InputState>,
    pub editor_input: Entity<InputState>,
    pub scope_focus: FocusHandle,
    selected_row_focus: FocusHandle,
    back_focus: FocusHandle,
    pub(crate) confirmation_focus: FocusHandle,
    pub(crate) confirmation_last_focus: FocusHandle,
    confirmation_return_focus: Option<FocusHandle>,
    last_review_request: u64,
}

impl EventEmitter<FilesEvent> for FilesWorkbench {}

impl FilesWorkbench {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search files"));
        let editor_input = cx.new(|cx| {
            InputState::new(window, cx)
                .code_editor("text")
                .soft_wrap(false)
        });
        let mut this = Self {
            workspace: None,
            root: None,
            index: None,
            index_loading: false,
            index_error: None,
            index_generation: 0,
            index_cancellation: WorkspaceFileCancellation::default(),
            read_generation: 0,
            read_cancellation: WorkspaceFileCancellation::default(),
            save_generation: 0,
            save_cancellation: WorkspaceFileCancellation::default(),
            expanded: BTreeSet::new(),
            selected_path: None,
            active_path: None,
            compact_detail: false,
            document: None,
            document_loading: false,
            document_error: None,
            baseline: String::new(),
            saving: false,
            saved: false,
            save_issue: None,
            wrap: false,
            confirmation: None,
            interaction_blocked: false,
            suppress_editor_event: false,
            search_input,
            editor_input,
            scope_focus: cx.focus_handle(),
            selected_row_focus: cx.focus_handle().tab_stop(true),
            back_focus: cx.focus_handle().tab_stop(true),
            confirmation_focus: cx.focus_handle().tab_stop(true),
            confirmation_last_focus: cx.focus_handle().tab_stop(true),
            confirmation_return_focus: None,
            last_review_request: 0,
        };
        this.install_subscriptions(window, cx);
        this
    }

    fn install_subscriptions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.subscribe_in(
            &self.search_input,
            window,
            |this, _input, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    let visible = this.visible_paths(cx);
                    this.active_path = resolved_active_path(
                        &visible,
                        this.active_path.as_deref(),
                        this.selected_path.as_deref(),
                    )
                    .map(str::to_string);
                    cx.notify();
                }
            },
        )
        .detach();
        cx.subscribe_in(
            &self.editor_input,
            window,
            |this, _input, event, _window, cx| {
                if matches!(event, InputEvent::Change) && !this.suppress_editor_event {
                    this.saved = false;
                    if this
                        .save_issue
                        .as_ref()
                        .is_some_and(|issue| issue.code != WorkspaceFileErrorCode::ChangedOnDisk)
                    {
                        this.save_issue = None;
                    }
                    this.emit_state(cx);
                    cx.notify();
                }
            },
        )
        .detach();
    }

    pub fn dirty(&self, cx: &gpui::App) -> bool {
        self.document.is_some() && self.editor_input.read(cx).value().as_ref() != self.baseline
    }

    pub fn focus_inside(&self, window: &Window, cx: &gpui::App) -> bool {
        self.scope_focus.contains_focused(window, cx)
    }

    pub fn confirmation_open(&self) -> bool {
        self.confirmation.is_some()
    }

    pub fn cancel_confirmation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.confirmation.take() == Some(DiscardConfirmation::ExternalMutation) {
            cx.emit(FilesEvent::ExternalDiscardCancelled);
        }
        if let Some(focus) = self.confirmation_return_focus.take() {
            focus.focus(window);
        } else if self.compact_detail {
            self.back_focus.focus(window);
        } else {
            self.selected_row_focus.focus(window);
        }
        cx.notify();
    }

    fn show_confirmation(
        &mut self,
        confirmation: DiscardConfirmation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.confirmation = Some(confirmation);
        self.confirmation_return_focus = window.focused(cx);
        let focus = self.confirmation_focus.clone();
        cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        cx.notify();
    }

    pub fn set_interaction_blocked(
        &mut self,
        blocked: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.interaction_blocked == blocked {
            return;
        }
        self.interaction_blocked = blocked;
        if blocked {
            self.index_cancellation.cancel();
            self.read_cancellation.cancel();
            self.index_generation = self.index_generation.wrapping_add(1);
            self.read_generation = self.read_generation.wrapping_add(1);
            self.index_loading = false;
            self.document_loading = false;
        } else if self.available() {
            self.refresh(cx);
            if self.document.is_none() {
                if let Some(path) = self.selected_path.clone() {
                    self.open_path(path, self.compact_detail, window, cx);
                }
            }
        }
        cx.notify();
    }

    fn emit_state(&self, cx: &mut Context<Self>) {
        cx.emit(FilesEvent::StateChanged(FilesEditorSnapshot {
            workspace_id: self
                .workspace
                .as_ref()
                .map(|workspace| workspace.id.clone()),
            path: self.selected_path.clone(),
            dirty: self.dirty(cx),
            saving: self.saving,
        }));
    }

    pub fn set_workspace(
        &mut self,
        workspace: Option<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !workspace_identity_changed(self.workspace.as_ref(), workspace.as_ref()) {
            self.workspace = workspace;
            return;
        }
        let dismissed_confirmation = self.confirmation.is_some();
        self.cancel_all();
        self.workspace = workspace;
        self.root = self
            .workspace
            .as_ref()
            .and_then(|workspace| workspace.folder_path.as_deref())
            .map(PathBuf::from);
        self.index = None;
        self.index_error = None;
        self.expanded.clear();
        self.selected_path = None;
        self.active_path = None;
        self.compact_detail = false;
        self.document = None;
        self.document_loading = false;
        self.document_error = None;
        self.baseline.clear();
        self.saving = false;
        self.save_issue = None;
        if self.confirmation.take() == Some(DiscardConfirmation::ExternalMutation) {
            cx.emit(FilesEvent::ExternalDiscardCancelled);
        }
        self.confirmation_return_focus = None;
        if dismissed_confirmation {
            self.scope_focus.focus(window);
        }
        self.set_editor_value("", window, cx);
        self.emit_state(cx);
        if self.available() {
            self.refresh(cx);
        }
        cx.notify();
    }

    fn available(&self) -> bool {
        workspace_files_available(self.workspace.as_ref(), self.root.is_some())
    }

    fn cancel_all(&mut self) {
        self.index_cancellation.cancel();
        self.read_cancellation.cancel();
        self.save_cancellation.cancel();
        self.index_generation = self.index_generation.wrapping_add(1);
        self.read_generation = self.read_generation.wrapping_add(1);
        self.save_generation = self.save_generation.wrapping_add(1);
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.available() || self.interaction_blocked {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        self.index_cancellation.cancel();
        self.index_cancellation = WorkspaceFileCancellation::default();
        self.index_generation = self.index_generation.wrapping_add(1);
        let token = RequestToken {
            generation: self.index_generation,
        };
        let cancellation = self.index_cancellation.clone();
        self.index_loading = true;
        self.index_error = None;
        let task =
            cx.background_spawn(
                async move { list_workspace_files_cancellable(&root, &cancellation) },
            );
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if !request_is_current(this.index_generation, token) {
                    return;
                }
                this.index_loading = false;
                match result {
                    Ok(index) => this.index = Some(index),
                    Err(error) => this.index_error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn choose_entry(
        &mut self,
        path: &str,
        kind: WorkspaceFileKind,
        symbolic: bool,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.interaction_blocked {
            return;
        }
        self.active_path = Some(path.to_string());
        match kind {
            WorkspaceFileKind::Directory => {
                if !self.expanded.remove(path) {
                    self.expanded.insert(path.to_string());
                }
                cx.notify();
            }
            WorkspaceFileKind::File if !symbolic => {
                self.request_open_path(path.to_string(), compact, window, cx)
            }
            WorkspaceFileKind::File | WorkspaceFileKind::Symlink => {}
        }
    }

    fn visible_paths(&self, cx: &gpui::App) -> Vec<String> {
        let query = self.search_input.read(cx).value();
        self.index
            .as_ref()
            .map(|index| {
                index
                    .entries
                    .iter()
                    .filter(|entry| entry_visible(entry, query.as_ref(), &self.expanded))
                    .map(|entry| entry.path.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn move_active_row(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let visible = self.visible_paths(cx);
        let active = resolved_active_path(
            &visible,
            self.active_path.as_deref(),
            self.selected_path.as_deref(),
        );
        let Some(target) = roving_target(&visible, active, key) else {
            return false;
        };
        self.active_path = Some(target.to_string());
        let focus = self.selected_row_focus.clone();
        cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        cx.notify();
        true
    }

    fn request_open_path(
        &mut self,
        path: String,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected_path.as_deref() == Some(path.as_str()) {
            if compact {
                self.compact_detail = true;
                self.back_focus.focus(window);
                cx.notify();
            }
            return;
        }
        if self.saving {
            return;
        }
        if self.dirty(cx) {
            self.show_confirmation(DiscardConfirmation::OpenPath(path), window, cx);
            return;
        }
        self.open_path(path, compact, window, cx);
    }

    pub fn open_from_review(
        &mut self,
        request_id: u64,
        path: String,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if request_id <= self.last_review_request {
            return;
        }
        self.last_review_request = request_id;
        self.request_open_path(path, compact, window, cx);
    }

    fn open_path(
        &mut self,
        path: String,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.available() || self.interaction_blocked {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        self.read_cancellation.cancel();
        self.read_cancellation = WorkspaceFileCancellation::default();
        self.read_generation = self.read_generation.wrapping_add(1);
        let token = RequestToken {
            generation: self.read_generation,
        };
        let cancellation = self.read_cancellation.clone();
        self.selected_path = Some(path.clone());
        expand_ancestors(&path, &mut self.expanded);
        self.compact_detail = compact;
        self.document = None;
        self.document_loading = true;
        self.document_error = None;
        self.baseline.clear();
        self.save_issue = None;
        self.saved = false;
        self.set_editor_value("", window, cx);
        self.emit_state(cx);
        if compact {
            self.back_focus.focus(window);
        }
        let requested_path = path.clone();
        let task = cx.background_spawn(async move {
            read_workspace_file_cancellable(&root, &requested_path, &cancellation)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                if !should_apply_document_read(
                    this.read_generation,
                    token,
                    this.selected_path.as_deref(),
                    &path,
                    this.document_loading,
                ) {
                    return;
                }
                this.document_loading = false;
                match result {
                    Ok(document) => {
                        if let Some(warning) = document_warning(&document) {
                            cx.emit(FilesEvent::Notification(FilesNotification::Warning(
                                warning,
                            )));
                        }
                        this.baseline = document.content.clone();
                        this.set_editor_value(&document.content.clone(), window, cx);
                        this.document = Some(document);
                    }
                    Err(error) => this.document_error = Some(error.to_string()),
                }
                this.emit_state(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn set_editor_value(&mut self, value: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.suppress_editor_event = true;
        self.editor_input.update(cx, |input, cx| {
            input.set_value(value.to_string(), window, cx)
        });
        self.suppress_editor_event = false;
    }

    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !can_save_document(
            self.available(),
            self.dirty(cx),
            self.saving,
            self.document_loading,
            self.interaction_blocked,
            self.confirmation.is_some(),
        ) {
            return;
        }
        let (Some(root), Some(path), Some(document)) = (
            self.root.clone(),
            self.selected_path.clone(),
            self.document.clone(),
        ) else {
            return;
        };
        let submitted = self.editor_input.read(cx).value().to_string();
        let expected_version = document.version;
        self.save_cancellation.cancel();
        self.save_cancellation = WorkspaceFileCancellation::default();
        self.save_generation = self.save_generation.wrapping_add(1);
        let token = RequestToken {
            generation: self.save_generation,
        };
        let cancellation = self.save_cancellation.clone();
        self.saving = true;
        self.saved = false;
        self.save_issue = None;
        self.emit_state(cx);
        let task = cx.background_spawn(async move {
            write_workspace_file_cancellable(
                &root,
                &path,
                &submitted,
                &expected_version,
                &cancellation,
            )
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, _window, cx| {
                if !request_is_current(this.save_generation, token) {
                    return;
                }
                this.saving = false;
                match result {
                    Ok(document) => {
                        if let Some(warning) = document_warning(&document) {
                            cx.emit(FilesEvent::Notification(FilesNotification::Warning(
                                warning,
                            )));
                        }
                        this.baseline = document.content.clone();
                        this.document = Some(document);
                        this.saved = true;
                        this.save_issue = None;
                        this.refresh(cx);
                    }
                    Err(error) => {
                        this.save_issue = Some(SaveIssue {
                            code: error.code(),
                            message: error.to_string(),
                        });
                    }
                }
                this.emit_state(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn request_external_discard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty(cx) && !self.saving {
            self.show_confirmation(DiscardConfirmation::ExternalMutation, window, cx);
        }
    }

    fn discard_current(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.read_cancellation.cancel();
        self.save_cancellation.cancel();
        self.read_generation = self.read_generation.wrapping_add(1);
        self.save_generation = self.save_generation.wrapping_add(1);
        self.saving = false;
        self.save_issue = None;
        self.saved = false;
        let baseline = self.baseline.clone();
        self.set_editor_value(&baseline, window, cx);
        self.emit_state(cx);
        cx.notify();
    }

    fn confirm_discard(&mut self, compact: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.interaction_blocked || self.saving || !self.available() {
            return;
        }
        let Some(confirmation) = self.confirmation.take() else {
            return;
        };
        if confirmation == DiscardConfirmation::ExternalMutation {
            self.confirmation = Some(confirmation);
            cx.emit(FilesEvent::ExternalDiscardRequested);
            return;
        }
        self.confirmation_return_focus = None;
        self.discard_current(window, cx);
        match confirmation {
            DiscardConfirmation::OpenPath(path) => self.open_path(path, compact, window, cx),
            DiscardConfirmation::BackToTree => {
                self.compact_detail = false;
                self.selected_row_focus.focus(window);
            }
            DiscardConfirmation::Reload => {
                if let Some(path) = self.selected_path.clone() {
                    self.open_path(path, compact, window, cx);
                }
            }
            DiscardConfirmation::ExternalMutation => unreachable!(),
        }
        cx.notify();
    }

    pub fn confirm_external_discard(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.confirmation != Some(DiscardConfirmation::ExternalMutation)
            || self.interaction_blocked
            || self.saving
            || !self.available()
        {
            return false;
        }
        self.confirmation = None;
        self.confirmation_return_focus = None;
        self.discard_current(window, cx);
        true
    }

    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if self.dirty(cx) {
            self.show_confirmation(DiscardConfirmation::BackToTree, window, cx);
        } else {
            self.compact_detail = false;
            self.selected_row_focus.focus(window);
        }
        cx.notify();
    }

    fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_confirmation(DiscardConfirmation::Reload, window, cx);
    }

    fn toggle_wrap(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.wrap = !self.wrap;
        self.editor_input
            .update(cx, |input, cx| input.set_soft_wrap(self.wrap, window, cx));
        cx.notify();
    }
}

pub(crate) fn files_panel(
    files: &Entity<FilesWorkbench>,
    width: f32,
    _window: &mut Window,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let state = files.read(cx);
    let compact = compact_files_layout(width);
    let show_tree = !compact || !state.compact_detail;
    let show_editor = !compact || state.compact_detail;
    let theme = cx.theme().clone();
    let query = state.search_input.read(cx).value().to_string();
    let selected_path = state.selected_path.clone();
    let stored_active_path = state.active_path.clone();
    let visible_entries: Vec<_> = state
        .index
        .as_ref()
        .map(|index| {
            index
                .entries
                .iter()
                .filter(|entry| entry_visible(entry, &query, &state.expanded))
                .map(|entry| {
                    (
                        entry.path.clone(),
                        entry.name.clone(),
                        entry.depth,
                        entry.kind,
                        entry.symbolic,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let visible_paths: Vec<String> = visible_entries
        .iter()
        .map(|(path, _, _, _, _)| path.clone())
        .collect();
    let active_path = resolved_active_path(
        &visible_paths,
        stored_active_path.as_deref(),
        selected_path.as_deref(),
    )
    .map(str::to_string);
    let scope_focus = state.scope_focus.clone();
    let selected_row_focus = state.selected_row_focus.clone();
    let back_focus = state.back_focus.clone();
    let index_loading = state.index_loading;
    let index_error = state.index_error.clone();
    let index_truncated = state.index.as_ref().is_some_and(|index| index.truncated);
    let document_loaded = state.document.is_some();
    let document_loading = state.document_loading;
    let document_error = state.document_error.clone();
    let dirty = state.dirty(cx);
    let saving = state.saving;
    let saved = state.saved;
    let issue = state.save_issue.clone();
    let wrap = state.wrap;
    let confirmation_open = state.confirmation.is_some();
    let interaction_blocked = state.interaction_blocked;
    let workspace = state.workspace.clone();
    let search_input = state.search_input.clone();
    let editor_input = state.editor_input.clone();

    if workspace
        .as_ref()
        .and_then(|workspace| workspace.folder_path.as_ref())
        .is_none()
    {
        return empty_state(
            "No workspace folder",
            "Choose a local workspace to browse and edit files beside the conversation.",
            cx,
        );
    }
    if workspace
        .as_ref()
        .is_some_and(|workspace| workspace.permission == WorkspacePermission::None)
    {
        return empty_state(
            "File access is off",
            "Change this workspace from No Access before opening Files.",
            cx,
        );
    }

    let tree = v_flex()
        .id("environment-files-tree")
        .h_full()
        .w(if compact {
            gpui::relative(1.)
        } else {
            px(FILE_TREE_WIDTH).into()
        })
        .flex_shrink_0()
        .bg(theme.sidebar)
        .when(!compact, |el| el.border_r_1().border_color(theme.border))
        .child(
            h_flex()
                .h(px(FILE_TOOLBAR_HEIGHT))
                .flex_shrink_0()
                .gap_1()
                .px_2()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .child(Input::new(&search_input).small()),
                )
                .child(
                    Button::new("environment-files-refresh")
                        .ghost()
                        .small()
                        .icon(if index_loading {
                            IconName::LoaderCircle
                        } else {
                            IconName::Redo
                        })
                        .disabled(index_loading || interaction_blocked)
                        .tooltip("Refresh files")
                        .on_click({
                            let files = files.clone();
                            move |_event, _window, cx| {
                                files.update(cx, |state, cx| state.refresh(cx))
                            }
                        }),
                ),
        )
        .child(
            v_flex()
                .id("environment-files-tree-scroll")
                .min_h(px(0.))
                .flex_1()
                .overflow_y_scroll()
                .p_1()
                .when(index_loading && visible_entries.is_empty(), |el| {
                    el.child(status_copy("Loading workspace files…", cx))
                })
                .when(index_error.is_some() && visible_entries.is_empty(), |el| {
                    el.child(status_copy(
                        index_error.as_deref().unwrap_or("File index unavailable"),
                        cx,
                    ))
                })
                .when(
                    !index_loading && index_error.is_none() && visible_entries.is_empty(),
                    |el| {
                        el.child(status_copy(
                            if query.trim().is_empty() {
                                "This workspace is empty."
                            } else {
                                "No matching files."
                            },
                            cx,
                        ))
                    },
                )
                .children(visible_entries.into_iter().map(
                    |(path, name, depth, kind, symbolic)| {
                        let selected = selected_path.as_deref() == Some(path.as_str());
                        let active = active_path.as_deref() == Some(path.as_str());
                        let expanded = files.read(cx).expanded.contains(&path);
                        let row_files = files.clone();
                        let row_path = path.clone();
                        let keyboard_files = files.clone();
                        let keyboard_path = path.clone();
                        let row = h_flex()
                            .id(ElementId::Name(
                                format!("environment-file-row:{path}").into(),
                            ))
                            .h(px(FILE_ROW_HEIGHT))
                            .w_full()
                            .rounded(px(8.))
                            .pl(px(4.
                                + if query.trim().is_empty() {
                                    depth as f32 * 12.
                                } else {
                                    0.
                                }))
                            .pr_1()
                            .gap_1()
                            .text_xs()
                            .text_color(if selected {
                                theme.foreground
                            } else {
                                theme.muted_foreground
                            })
                            .when(selected, |el| el.bg(theme.list_active))
                            .hover(|style| style.bg(theme.list_hover))
                            .focus(|style| style.bg(theme.list_active))
                            .tab_stop(active)
                            .when(active, |el| el.track_focus(&selected_row_focus))
                            .on_click(move |_event, window, cx| {
                                row_files.update(cx, |state, cx| {
                                    state.choose_entry(
                                        &row_path, kind, symbolic, compact, window, cx,
                                    )
                                });
                            })
                            .on_key_down(move |event: &gpui::KeyDownEvent, window, cx| {
                                if keyboard_activates(event.keystroke.key.as_str()) {
                                    keyboard_files.update(cx, |state, cx| {
                                        state.choose_entry(
                                            &keyboard_path,
                                            kind,
                                            symbolic,
                                            compact,
                                            window,
                                            cx,
                                        )
                                    });
                                    cx.stop_propagation();
                                } else if keyboard_files.update(cx, |state, cx| {
                                    state.move_active_row(event.keystroke.key.as_str(), window, cx)
                                }) {
                                    cx.stop_propagation();
                                }
                            })
                            .child(div().w(px(14.)).when(
                                kind == WorkspaceFileKind::Directory,
                                |el| {
                                    el.child(
                                        Icon::new(if expanded {
                                            IconName::ChevronDown
                                        } else {
                                            IconName::ChevronRight
                                        })
                                        .xsmall(),
                                    )
                                },
                            ))
                            .child(
                                Icon::new(if kind == WorkspaceFileKind::Directory {
                                    if expanded {
                                        IconName::FolderOpen
                                    } else {
                                        IconName::Folder
                                    }
                                } else if symbolic {
                                    IconName::ExternalLink
                                } else {
                                    IconName::File
                                })
                                .xsmall(),
                            )
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .flex_1()
                                    .truncate()
                                    .child(if query.trim().is_empty() { name } else { path }),
                            );
                        row
                    },
                )),
        )
        .when(index_truncated || index_error.is_some(), |el| {
            el.child(
                div()
                    .flex_shrink_0()
                    .border_t_1()
                    .border_color(theme.border)
                    .px_2()
                    .py_2()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(if index_error.is_some() {
                        "Refresh failed. Showing the last file index."
                    } else {
                        "Large workspace: showing the first 4,000 entries."
                    }),
            )
        });

    let editor = if selected_path.is_none() {
        empty_state(
            "Choose a file",
            "Select a UTF-8 text file. Saves are checked against the version on disk.",
            cx,
        )
    } else {
        let path = selected_path.clone().unwrap_or_default();
        let status = if saving {
            "Saving…"
        } else if issue.is_some() {
            "Save failed"
        } else if dirty {
            "Edited"
        } else if saved {
            "Saved"
        } else {
            ""
        };
        let mut editor_body = v_flex()
            .id("environment-file-editor")
            .size_full()
            .min_w(px(0.))
            .child(
                h_flex()
                    .h(px(FILE_TOOLBAR_HEIGHT))
                    .flex_shrink_0()
                    .gap_1()
                    .px_2()
                    .border_b_1()
                    .border_color(theme.border)
                    .when(compact, |el| {
                        el.child(
                            h_flex()
                                .track_focus(&back_focus)
                                .tab_stop(true)
                                .on_key_down({
                                    let files = files.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if keyboard_activates(event.keystroke.key.as_str()) {
                                            files.update(cx, |state, cx| state.back(window, cx));
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("environment-files-back")
                                        .ghost()
                                        .small()
                                        .tab_stop(false)
                                        .icon(IconName::ChevronLeft)
                                        .disabled(saving || interaction_blocked)
                                        .tooltip("Back to files")
                                        .on_click({
                                            let files = files.clone();
                                            move |_event, window, cx| {
                                                files.update(cx, |state, cx| state.back(window, cx))
                                            }
                                        }),
                                ),
                        )
                    })
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex_1()
                            .truncate()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(path),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(status),
                    )
                    .child(
                        Button::new("environment-files-wrap")
                            .ghost()
                            .small()
                            .icon(IconName::Replace)
                            .selected(wrap)
                            .disabled(interaction_blocked)
                            .tooltip(if wrap {
                                "Turn off line wrapping"
                            } else {
                                "Wrap long lines"
                            })
                            .on_click({
                                let files = files.clone();
                                move |_event, window, cx| {
                                    files.update(cx, |state, cx| state.toggle_wrap(window, cx))
                                }
                            }),
                    )
                    .child(
                        Button::new("environment-files-save")
                            .small()
                            .label("Save")
                            .disabled(
                                !dirty
                                    || saving
                                    || !document_loaded
                                    || document_loading
                                    || interaction_blocked
                                    || confirmation_open,
                            )
                            .tooltip("Save file (⌘S)")
                            .on_click({
                                let files = files.clone();
                                move |_event, window, cx| {
                                    files.update(cx, |state, cx| state.save(window, cx))
                                }
                            }),
                    ),
            );
        if let Some(issue) = issue {
            let changed = issue.code == WorkspaceFileErrorCode::ChangedOnDisk;
            editor_body = editor_body.child(
                h_flex()
                    .flex_shrink_0()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.danger.opacity(0.06))
                    .text_xs()
                    .text_color(theme.danger)
                    .child(div().min_w(px(0.)).flex_1().child(issue.message))
                    .child(
                        Button::new("environment-files-recover")
                            .ghost()
                            .small()
                            .label(if changed { "Reload" } else { "Retry" })
                            .disabled(interaction_blocked || confirmation_open)
                            .on_click({
                                let files = files.clone();
                                move |_event, window, cx| {
                                    files.update(cx, |state, cx| {
                                        if changed {
                                            state.reload(window, cx)
                                        } else {
                                            state.save(window, cx)
                                        }
                                    })
                                }
                            }),
                    ),
            );
        }
        if document_loading {
            editor_body = editor_body.child(
                v_flex()
                    .min_h(px(0.))
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .child(Icon::new(IconName::LoaderCircle))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("Loading file…"),
                    ),
            );
        } else if let Some(error) = document_error {
            editor_body = editor_body.child(
                v_flex()
                    .min_h(px(0.))
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .px_6()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("File unavailable"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(error),
                    )
                    .child(
                        Button::new("environment-files-read-retry")
                            .small()
                            .label("Try again")
                            .disabled(interaction_blocked)
                            .on_click({
                                let files = files.clone();
                                move |_event, window, cx| {
                                    files.update(cx, |state, cx| {
                                        if let Some(path) = state.selected_path.clone() {
                                            state.open_path(path, compact, window, cx);
                                        }
                                    })
                                }
                            }),
                    ),
            );
        } else {
            editor_body = editor_body.child(
                div().min_h(px(0.)).flex_1().bg(theme.background).child(
                    Input::new(&editor_input)
                        .appearance(false)
                        .disabled(saving || interaction_blocked),
                ),
            );
        }
        editor_body.into_any_element()
    };

    h_flex()
        .id("environment-files-panel")
        .key_context("FilesEditor")
        .track_focus(&scope_focus)
        .size_full()
        .min_w(px(0.))
        .overflow_hidden()
        .when(show_tree, |el| el.child(tree))
        .when(show_editor, |el| {
            el.child(div().min_w(px(0.)).flex_1().child(editor))
        })
        .into_any_element()
}

pub(crate) fn files_confirmation_modal(
    files: &Entity<FilesWorkbench>,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let state = files.read(cx);
    let Some(confirmation) = state.confirmation.clone() else {
        return div().into_any_element();
    };
    let external = confirmation == DiscardConfirmation::ExternalMutation;
    let blocked = state.interaction_blocked || state.saving || !state.available();
    let first = state.confirmation_focus.clone();
    let last = state.confirmation_last_focus.clone();
    let theme = cx.theme().clone();

    v_flex()
        .id("environment-files-discard-confirmation")
        .absolute()
        .inset_0()
        .occlude()
        .items_center()
        .justify_center()
        .bg(gpui::black().opacity(0.18))
        .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
            cx.stop_propagation()
        })
        .on_click({
            let files = files.clone();
            move |_event, window, cx| {
                cx.stop_propagation();
                files.update(cx, |state, cx| state.cancel_confirmation(window, cx));
            }
        })
        .child(
            v_flex()
                .id("environment-files-discard-dialog")
                .w(px(320.))
                .max_w(gpui::relative(0.9))
                .gap_3()
                .p_4()
                .rounded(px(16.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.popover)
                .shadow_lg()
                .occlude()
                .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                    cx.stop_propagation()
                })
                .on_click(|_event, _window, cx| cx.stop_propagation())
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Discard unsaved edits?"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(if external {
                            "Discard this draft before changing workspace or context."
                        } else {
                            "This file has changes that have not been saved."
                        }),
                )
                .child(
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            h_flex()
                                .track_focus(&first)
                                .tab_stop(true)
                                .on_key_down({
                                    let files = files.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if matches!(event.keystroke.key.as_str(), "enter" | "space")
                                        {
                                            files.update(cx, |state, cx| {
                                                state.cancel_confirmation(window, cx)
                                            });
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("environment-files-keep-editing")
                                        .ghost()
                                        .small()
                                        .tab_stop(false)
                                        .label("Keep editing")
                                        .on_click({
                                            let files = files.clone();
                                            move |_event, window, cx| {
                                                files.update(cx, |state, cx| {
                                                    state.cancel_confirmation(window, cx)
                                                })
                                            }
                                        }),
                                ),
                        )
                        .child(
                            h_flex()
                                .track_focus(&last)
                                .tab_stop(true)
                                .on_key_down({
                                    let files = files.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if !blocked
                                            && matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            )
                                        {
                                            files.update(cx, |state, cx| {
                                                let compact = state.compact_detail;
                                                state.confirm_discard(compact, window, cx)
                                            });
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("environment-files-discard")
                                        .danger()
                                        .small()
                                        .tab_stop(false)
                                        .label("Discard edits")
                                        .disabled(blocked)
                                        .on_click({
                                            let files = files.clone();
                                            move |_event, window, cx| {
                                                files.update(cx, |state, cx| {
                                                    let compact = state.compact_detail;
                                                    state.confirm_discard(compact, window, cx)
                                                })
                                            }
                                        }),
                                ),
                        ),
                ),
        )
        .into_any_element()
}

fn empty_state(
    title: &'static str,
    description: &'static str,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let theme = cx.theme().clone();
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_2()
        .px_6()
        .text_center()
        .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
        .child(
            div()
                .max_w(px(340.))
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(description),
        )
        .into_any_element()
}

fn status_copy(message: impl Into<String>, cx: &mut Context<AppState>) -> AnyElement {
    div()
        .p_3()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(message.into())
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, parent: &str, kind: WorkspaceFileKind) -> WorkspaceFileEntry {
        WorkspaceFileEntry {
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            parent_path: parent.into(),
            depth: path.matches('/').count(),
            kind,
            symbolic: false,
            size: None,
            modified_at: None,
        }
    }

    fn workspace(folder: &str, permission: WorkspacePermission) -> Workspace {
        Workspace {
            id: "workspace-1".into(),
            name: "Workspace".into(),
            folder_path: Some(folder.into()),
            permission,
            managed_worktree: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn stale_async_results_are_rejected_by_generation() {
        assert!(!request_is_current(4, RequestToken { generation: 3 }));
        assert!(request_is_current(4, RequestToken { generation: 4 }));
    }

    #[test]
    fn compact_layout_matches_electron_breakpoint() {
        assert!(compact_files_layout(539.));
        assert!(!compact_files_layout(540.));
    }

    #[test]
    fn review_handoff_uses_rendered_environment_width() {
        assert!(compact_files_for_environment(560., 1_040.));
        assert!(!compact_files_for_environment(560., 1_200.));
    }

    #[test]
    fn collapsed_ancestors_hide_descendants_until_expanded() {
        let file = entry("src/main.rs", "src", WorkspaceFileKind::File);
        assert!(!entry_visible(&file, "", &BTreeSet::new()));
        assert!(entry_visible(&file, "", &BTreeSet::from(["src".into()])));
    }

    #[test]
    fn search_returns_files_only_and_matches_full_path() {
        let file = entry("src/main.rs", "src", WorkspaceFileKind::File);
        let directory = entry("src", "", WorkspaceFileKind::Directory);
        assert!(entry_visible(&file, "MAIN", &BTreeSet::new()));
        assert!(!entry_visible(&directory, "src", &BTreeSet::new()));
    }

    #[test]
    fn ancestor_expansion_is_deterministic() {
        let mut expanded = BTreeSet::new();
        expand_ancestors("src/environment/files.rs", &mut expanded);
        assert_eq!(
            expanded,
            BTreeSet::from(["src".into(), "src/environment".into()])
        );
    }

    #[test]
    fn same_id_folder_or_permission_changes_invalidate_files_identity() {
        let original = workspace("/tmp/one", WorkspacePermission::Full);
        let moved = workspace("/tmp/two", WorkspacePermission::Full);
        let revoked = workspace("/tmp/one", WorkspacePermission::None);
        assert!(workspace_identity_changed(Some(&original), Some(&moved)));
        assert!(workspace_identity_changed(Some(&original), Some(&revoked)));
        assert!(!workspace_identity_changed(
            Some(&original),
            Some(&original)
        ));
    }

    #[test]
    fn permission_none_never_resumes_files_io_after_unblock() {
        let revoked = workspace("/tmp/one", WorkspacePermission::None);
        assert!(!workspace_files_available(Some(&revoked), true));
    }

    #[test]
    fn loading_and_confirmation_prevent_save() {
        assert!(!can_save_document(true, true, false, true, false, false));
        assert!(!can_save_document(true, true, false, false, false, true));
        assert!(can_save_document(true, true, false, false, false, false));
    }

    #[test]
    fn stale_or_finished_reads_cannot_overwrite_editor_input() {
        let token = RequestToken { generation: 7 };
        assert!(should_apply_document_read(
            7,
            token,
            Some("src/lib.rs"),
            "src/lib.rs",
            true
        ));
        assert!(!should_apply_document_read(
            8,
            token,
            Some("src/lib.rs"),
            "src/lib.rs",
            true
        ));
        assert!(!should_apply_document_read(
            7,
            token,
            Some("src/main.rs"),
            "src/lib.rs",
            true
        ));
        assert!(!should_apply_document_read(
            7,
            token,
            Some("src/lib.rs"),
            "src/lib.rs",
            false
        ));
    }

    #[test]
    fn document_warning_is_forwarded_verbatim() {
        let document = WorkspaceFileDocument {
            path: "src/lib.rs".into(),
            content: String::new(),
            size: 0,
            modified_at: 1,
            version: "v1".into(),
            warning: Some("Recovered the original file".into()),
        };
        assert_eq!(
            document_warning(&document).as_deref(),
            Some("Recovered the original file")
        );
    }

    #[test]
    fn roving_rows_follow_visible_order_and_clamp() {
        let visible = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(roving_target(&visible, Some("b"), "up"), Some("a"));
        assert_eq!(roving_target(&visible, Some("b"), "down"), Some("c"));
        assert_eq!(roving_target(&visible, Some("a"), "up"), Some("a"));
        assert_eq!(roving_target(&visible, Some("c"), "down"), Some("c"));
        assert_eq!(roving_target(&visible, Some("b"), "home"), Some("a"));
        assert_eq!(roving_target(&visible, Some("b"), "end"), Some("c"));
    }

    #[test]
    fn hidden_active_and_selected_rows_fall_back_to_first_visible() {
        let visible = vec!["visible-a".into(), "visible-b".into()];
        assert_eq!(
            resolved_active_path(&visible, Some("hidden"), Some("also-hidden")),
            Some("visible-a")
        );
        assert_eq!(
            resolved_active_path(&visible, Some("hidden"), Some("visible-b")),
            Some("visible-b")
        );
    }

    #[test]
    fn compact_back_accepts_only_enter_and_space() {
        assert!(keyboard_activates("enter"));
        assert!(keyboard_activates("space"));
        assert!(!keyboard_activates("arrowleft"));
    }
}
