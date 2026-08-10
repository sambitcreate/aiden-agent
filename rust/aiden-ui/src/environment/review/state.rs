use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aiden_data::portable_config::{Workspace, WorkspacePermission};
use aiden_git::{
    AbortSignal, GitBranches, GitComparison, GitComparisonDiffInput, GitDiffInput, GitFileDiff,
    GitReview, GitService,
};
use gpui::{Context, EventEmitter, ScrollStrategy, Task, UniformListScrollHandle, Window};
use gpui_tokio_bridge::Tokio;

use super::diff::{parse_patch, DiffLine};

const CHANGES_POLL: Duration = Duration::from_secs(4);
const COMPARE_POLL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ReviewMode {
    #[default]
    Changes,
    Compare,
}

#[derive(Debug, Clone)]
pub(crate) enum ReviewEvent {
    OpenFile { request_id: u64, path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnerKey {
    id: String,
    folder: PathBuf,
    permission: WorkspacePermission,
}

pub(crate) struct Resource<T> {
    pub data: Option<T>,
    pub loading: bool,
    pub warning: Option<String>,
    generation: u64,
    key: Option<String>,
    signal: AbortSignal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResourceToken {
    generation: u64,
    key: String,
}

impl<T> Default for Resource<T> {
    fn default() -> Self {
        Self {
            data: None,
            loading: false,
            warning: None,
            generation: 0,
            key: None,
            signal: AbortSignal::new(),
        }
    }
}

impl<T> Resource<T> {
    fn begin(&mut self, key: String) -> (ResourceToken, AbortSignal) {
        self.signal.abort();
        self.signal = AbortSignal::new();
        self.generation = self.generation.wrapping_add(1);
        if self.key.as_deref() != Some(key.as_str()) {
            self.data = None;
            self.warning = None;
        }
        self.key = Some(key.clone());
        self.loading = true;
        (
            ResourceToken {
                generation: self.generation,
                key,
            },
            self.signal.clone(),
        )
    }

    fn finish(&mut self, token: ResourceToken, result: Result<T, String>) {
        if token.generation != self.generation || self.key.as_deref() != Some(token.key.as_str()) {
            return;
        }
        self.loading = false;
        match result {
            Ok(value) => {
                self.data = Some(value);
                self.warning = None;
            }
            Err(error) => self.warning = Some(error),
        }
    }

    fn clear(&mut self) {
        self.signal.abort();
        self.signal = AbortSignal::new();
        self.generation = self.generation.wrapping_add(1);
        self.key = None;
        self.data = None;
        self.loading = false;
        self.warning = None;
    }

    fn cancel_pending(&mut self) {
        self.signal.abort();
        self.signal = AbortSignal::new();
        self.generation = self.generation.wrapping_add(1);
        self.loading = false;
    }
}

pub(crate) struct ReviewWorkbench {
    git: GitService,
    owner: Option<OwnerKey>,
    pub mode: ReviewMode,
    pub active: bool,
    pub review: Resource<GitReview>,
    pub branches: Resource<GitBranches>,
    pub comparison: Resource<GitComparison>,
    pub file_diff: Resource<GitFileDiff>,
    pub parsed_diff: Arc<Vec<DiffLine>>,
    pub parsed_truncated: bool,
    pub selected_file: Option<String>,
    pub target_ref: Option<String>,
    pub target_menu_open: bool,
    pub target_menu_active: Option<String>,
    pub mode_focus: gpui::FocusHandle,
    pub file_focus: gpui::FocusHandle,
    pub target_focus: gpui::FocusHandle,
    pub target_option_focus: gpui::FocusHandle,
    pub file_scroll: UniformListScrollHandle,
    pub diff_scroll: UniformListScrollHandle,
    pub active_file: Option<String>,
    open_request: u64,
    _poll: Option<Task<()>>,
}

impl EventEmitter<ReviewEvent> for ReviewWorkbench {}

impl ReviewWorkbench {
    pub fn new(git: GitService, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            git,
            owner: None,
            mode: ReviewMode::Changes,
            active: false,
            review: Resource::default(),
            branches: Resource::default(),
            comparison: Resource::default(),
            file_diff: Resource::default(),
            parsed_diff: Arc::new(Vec::new()),
            parsed_truncated: false,
            selected_file: None,
            target_ref: None,
            target_menu_open: false,
            target_menu_active: None,
            mode_focus: cx.focus_handle().tab_stop(true),
            file_focus: cx.focus_handle().tab_stop(true),
            target_focus: cx.focus_handle().tab_stop(true),
            target_option_focus: cx.focus_handle().tab_stop(true),
            file_scroll: UniformListScrollHandle::new(),
            diff_scroll: UniformListScrollHandle::new(),
            active_file: None,
            open_request: 0,
            _poll: None,
        };
        this.start_poll(cx);
        this
    }

    pub fn set_workspace(&mut self, workspace: Option<Workspace>, cx: &mut Context<Self>) {
        let next = workspace.and_then(|workspace| {
            Some(OwnerKey {
                id: workspace.id,
                folder: PathBuf::from(workspace.folder_path?),
                permission: workspace.permission,
            })
        });
        if self.owner == next {
            return;
        }
        self.owner = next;
        self.review.clear();
        self.branches.clear();
        self.comparison.clear();
        self.file_diff.clear();
        self.parsed_diff = Arc::new(Vec::new());
        self.parsed_truncated = false;
        self.selected_file = None;
        self.active_file = None;
        self.target_ref = None;
        self.target_menu_open = false;
        self.target_menu_active = None;
        if self.active && self.available() {
            self.refresh(cx);
        }
        cx.notify();
    }

    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active && self.available() {
            self.refresh(cx);
        } else if !active {
            self.review.cancel_pending();
            self.branches.cancel_pending();
            self.comparison.cancel_pending();
            self.file_diff.cancel_pending();
        }
        cx.notify();
    }

    pub fn set_mode(&mut self, mode: ReviewMode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.target_menu_open = false;
        self.target_menu_active = None;
        self.selected_file = None;
        self.active_file = None;
        self.file_diff.clear();
        self.parsed_diff = Arc::new(Vec::new());
        self.parsed_truncated = false;
        if self.active {
            self.refresh(cx);
        }
        cx.notify();
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.available() {
            return;
        }
        self.refresh_branches(cx);
        self.refresh_mode(cx);
    }

    fn refresh_mode(&mut self, cx: &mut Context<Self>) {
        match self.mode {
            ReviewMode::Changes => self.refresh_changes(cx),
            ReviewMode::Compare => self.refresh_comparison(cx),
        }
    }

    pub fn choose_target(&mut self, target_ref: String, cx: &mut Context<Self>) {
        self.target_ref = Some(target_ref);
        self.target_menu_open = false;
        self.target_menu_active = None;
        self.file_diff.clear();
        self.parsed_diff = Arc::new(Vec::new());
        self.parsed_truncated = false;
        self.refresh_comparison(cx);
        cx.notify();
    }

    pub fn toggle_target_menu(&mut self, cx: &mut Context<Self>) {
        self.target_menu_open = !self.target_menu_open;
        self.target_menu_active = self
            .target_menu_open
            .then(|| {
                self.target_ref
                    .clone()
                    .or_else(|| self.branch_targets().first().map(|target| target.0.clone()))
            })
            .flatten();
        cx.notify();
    }

    pub fn close_target_menu(&mut self, cx: &mut Context<Self>) {
        if self.target_menu_open {
            self.target_menu_open = false;
            self.target_menu_active = None;
            cx.notify();
        }
    }

    pub fn move_target_menu(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let targets = self.branch_targets();
        let paths: Vec<String> = targets.into_iter().map(|target| target.0).collect();
        let Some(target) = roving_file_target(&paths, self.target_menu_active.as_deref(), key)
        else {
            return false;
        };
        self.target_menu_active = Some(target.to_string());
        cx.notify();
        true
    }

    pub fn activate_target_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(target) = self.target_menu_active.clone() {
            self.choose_target(target, cx);
        }
    }

    pub fn choose_file(&mut self, path: String, cx: &mut Context<Self>) {
        self.active_file = Some(path.clone());
        self.selected_file = Some(path);
        self.diff_scroll.scroll_to_item(0, ScrollStrategy::Top);
        self.refresh_diff(cx);
        cx.notify();
    }

    pub fn open_selected_in_files(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.selected_file.clone() else {
            return;
        };
        self.open_request = self.open_request.wrapping_add(1);
        cx.emit(ReviewEvent::OpenFile {
            request_id: self.open_request,
            path,
        });
    }

    pub fn branch_targets(&self) -> Vec<(String, String)> {
        self.branches
            .data
            .as_ref()
            .map_or_else(Vec::new, branch_targets)
    }

    pub fn move_file_focus(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let paths: Vec<String> = self
            .visible_files()
            .iter()
            .map(|file| file.path.clone())
            .collect();
        let Some(target) = roving_file_target(
            &paths,
            self.active_file
                .as_deref()
                .or(self.selected_file.as_deref()),
            key,
        ) else {
            return false;
        };
        self.active_file = Some(target.to_string());
        if let Some(index) = paths.iter().position(|path| path == target) {
            self.file_scroll
                .scroll_to_item(index, ScrollStrategy::Center);
        }
        cx.notify();
        true
    }

    pub fn activate_focused_file(&mut self, cx: &mut Context<Self>) {
        if let Some(path) = self.active_file.clone() {
            self.choose_file(path, cx);
        }
    }

    pub fn visible_files(&self) -> &[aiden_git::GitReviewFile] {
        match self.mode {
            ReviewMode::Changes => self
                .review
                .data
                .as_ref()
                .map(|value| value.files.as_slice()),
            ReviewMode::Compare => self
                .comparison
                .data
                .as_ref()
                .map(|value| value.files.as_slice()),
        }
        .unwrap_or(&[])
    }

    fn available(&self) -> bool {
        self.owner
            .as_ref()
            .is_some_and(|owner| owner.permission != WorkspacePermission::None)
    }

    fn refresh_changes(&mut self, cx: &mut Context<Self>) {
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let key = format!("{}:{}", owner.id, owner.folder.display());
        let (generation, signal) = self.review.begin(key);
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::diff::review(&git, &owner.folder, Some(&signal)).await
        });
        cx.spawn(async move |this, cx| {
            let result = task
                .await
                .map_err(|_| "Review was interrupted.".to_string())
                .and_then(|result| result.map_err(|error| error.to_string()));
            this.update(cx, |this, cx| {
                let previous = this
                    .review
                    .data
                    .as_ref()
                    .and_then(|value| value.commit.snapshot.clone());
                this.review.finish(generation, result);
                let current = this
                    .review
                    .data
                    .as_ref()
                    .and_then(|value| value.commit.snapshot.clone());
                let files = this
                    .review
                    .data
                    .as_ref()
                    .map(|value| value.files.iter().map(|file| file.path.clone()).collect());
                this.reconcile_selection(files, previous != current, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_branches(&mut self, cx: &mut Context<Self>) {
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let key = format!("{}:{}", owner.id, owner.folder.display());
        let (generation, signal) = self.branches.begin(key);
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::status::branches(&git, &owner.folder, Some(&signal)).await
        });
        cx.spawn(async move |this, cx| {
            let result = task
                .await
                .map_err(|_| "Branches were interrupted.".to_string())
                .and_then(|result| result.map_err(|error| error.to_string()));
            this.update(cx, |this, cx| {
                this.branches.finish(generation, result);
                let next_target =
                    resolved_target(this.target_ref.as_deref(), this.branches.data.as_ref());
                let target_changed = this.target_ref != next_target;
                if target_changed {
                    this.target_ref = next_target;
                    this.comparison.clear();
                    this.file_diff.clear();
                    this.parsed_diff = Arc::new(Vec::new());
                    this.parsed_truncated = false;
                    this.selected_file = None;
                    this.active_file = None;
                }
                if target_changed && this.mode == ReviewMode::Compare && this.target_ref.is_some() {
                    this.refresh_comparison(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_comparison(&mut self, cx: &mut Context<Self>) {
        let (Some(owner), Some(target)) = (self.owner.clone(), self.target_ref.clone()) else {
            return;
        };
        let key = format!("{}:{}:{target}", owner.id, owner.folder.display());
        let (generation, signal) = self.comparison.begin(key);
        let git = self.git.clone();
        let task = Tokio::spawn(cx, async move {
            aiden_git::diff::compare(&git, &owner.folder, &target, Some(&signal)).await
        });
        cx.spawn(async move |this, cx| {
            let result = task
                .await
                .map_err(|_| "Comparison was interrupted.".to_string())
                .and_then(|result| result.map_err(|error| error.to_string()));
            this.update(cx, |this, cx| {
                let previous = this
                    .comparison
                    .data
                    .as_ref()
                    .map(|value| value.snapshot.clone());
                this.comparison.finish(generation, result);
                let current = this
                    .comparison
                    .data
                    .as_ref()
                    .map(|value| value.snapshot.clone());
                let files = this
                    .comparison
                    .data
                    .as_ref()
                    .map(|value| value.files.iter().map(|file| file.path.clone()).collect());
                this.reconcile_selection(files, previous != current, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_diff(&mut self, cx: &mut Context<Self>) {
        let (Some(owner), Some(path)) = (self.owner.clone(), self.selected_file.clone()) else {
            return;
        };
        let git = self.git.clone();
        let owner_key = format!("{}:{}", owner.id, owner.folder.display());
        let key = match self.mode {
            ReviewMode::Changes => format!(
                "{owner_key}:changes:{}:{path}",
                self.review
                    .data
                    .as_ref()
                    .and_then(|review| review.commit.snapshot.as_deref())
                    .unwrap_or_default()
            ),
            ReviewMode::Compare => format!(
                "{owner_key}:compare:{}:{}:{path}",
                self.target_ref.as_deref().unwrap_or_default(),
                self.comparison
                    .data
                    .as_ref()
                    .map(|comparison| comparison.snapshot.as_str())
                    .unwrap_or_default()
            ),
        };
        let (generation, signal) = self.file_diff.begin(key);
        let mode = self.mode;
        let review_snapshot = self
            .review
            .data
            .as_ref()
            .and_then(|review| review.commit.snapshot.clone());
        let comparison = self.comparison.data.clone();
        let task = Tokio::spawn(cx, async move {
            match mode {
                ReviewMode::Changes => {
                    let snapshot = review_snapshot
                        .ok_or_else(|| "Refresh changes before opening a diff.".to_string())?;
                    aiden_git::diff::diff(
                        &git,
                        &owner.folder,
                        GitDiffInput {
                            expected_snapshot: snapshot,
                            path,
                        },
                        Some(&signal),
                    )
                    .await
                    .map_err(|error| error.to_string())
                }
                ReviewMode::Compare => {
                    let comparison = comparison
                        .ok_or_else(|| "Refresh comparison before opening a diff.".to_string())?;
                    aiden_git::diff::comparison_diff(
                        &git,
                        &owner.folder,
                        GitComparisonDiffInput {
                            expected_head: comparison.expected_head,
                            expected_target: comparison.expected_target,
                            merge_base: comparison.merge_base,
                            path,
                            target_ref: comparison.target_ref,
                        },
                        Some(&signal),
                    )
                    .await
                    .map_err(|error| error.to_string())
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task
                .await
                .map_err(|_| "Diff was interrupted.".to_string())
                .and_then(|result| result);
            this.update(cx, |this, cx| {
                this.file_diff.finish(generation, result);
                this.parsed_truncated = this
                    .file_diff
                    .data
                    .as_ref()
                    .is_some_and(|diff| diff.patch.lines().count() > 5_000);
                this.parsed_diff = this.file_diff.data.as_ref().map_or_else(
                    || Arc::new(Vec::new()),
                    |diff| parse_patch(&diff.patch, 5_000),
                );
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn start_poll(&mut self, cx: &mut Context<Self>) {
        self._poll = Some(cx.spawn(async move |this, cx| loop {
            let delay = this
                .read_with(cx, |this, _| match this.mode {
                    ReviewMode::Changes => CHANGES_POLL,
                    ReviewMode::Compare => COMPARE_POLL,
                })
                .unwrap_or(CHANGES_POLL);
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                if this.active {
                    this.refresh_mode(cx);
                }
            })
            .ok();
        }));
    }

    fn reconcile_selection(
        &mut self,
        files: Option<Vec<String>>,
        parent_changed: bool,
        cx: &mut Context<Self>,
    ) {
        let files = files.unwrap_or_default();
        let next = {
            self.selected_file
                .as_ref()
                .filter(|path| files.iter().any(|file| file == *path))
                .cloned()
                .or_else(|| files.first().cloned())
        };
        let selection_changed = self.selected_file != next;
        self.selected_file = next;
        if self
            .active_file
            .as_ref()
            .is_none_or(|active| !files.iter().any(|file| file == active))
        {
            self.active_file = self.selected_file.clone();
        }
        if self.selected_file.is_some()
            && (selection_changed || parent_changed || self.file_diff.data.is_none())
        {
            self.refresh_diff(cx);
        }
    }
}

fn roving_file_target<'a>(paths: &'a [String], active: Option<&str>, key: &str) -> Option<&'a str> {
    let current = active
        .and_then(|active| paths.iter().position(|path| path == active))
        .unwrap_or(0);
    let index = match key {
        "up" => current.saturating_sub(1),
        "down" => (current + 1).min(paths.len().checked_sub(1)?),
        "home" => 0,
        "end" => paths.len().checked_sub(1)?,
        _ => return None,
    };
    paths.get(index).map(String::as_str)
}

pub(crate) fn branch_targets(branches: &GitBranches) -> Vec<(String, String)> {
    let mut targets = Vec::new();
    for branch in &branches.branches {
        if Some(branch) != branches.current.as_ref() {
            targets.push((format!("refs/heads/{branch}"), branch.clone()));
        }
    }
    for branch in &branches.remote_branches {
        targets.push((
            format!("refs/remotes/{branch}"),
            format!("Last fetched · {branch}"),
        ));
    }
    targets
}

fn suggested_target(branches: Option<&GitBranches>) -> Option<String> {
    let branches = branches?;
    if let Some(upstream) = branches.upstream.as_deref() {
        if branches
            .remote_branches
            .iter()
            .any(|branch| branch == upstream)
        {
            return Some(format!("refs/remotes/{upstream}"));
        }
    }
    if let Some(default) = branches.default_branch.as_deref() {
        if branches.branches.iter().any(|branch| branch == default)
            && Some(default) != branches.current.as_deref()
        {
            return Some(format!("refs/heads/{default}"));
        }
        if let Some(remote) = branches
            .remote_branches
            .iter()
            .find(|branch| branch.ends_with(&format!("/{default}")))
        {
            return Some(format!("refs/remotes/{remote}"));
        }
    }
    branch_targets(branches)
        .into_iter()
        .next()
        .map(|target| target.0)
}

fn resolved_target(current: Option<&str>, branches: Option<&GitBranches>) -> Option<String> {
    let targets = branches.map(branch_targets).unwrap_or_default();
    current
        .filter(|current| targets.iter().any(|target| target.0 == *current))
        .map(str::to_string)
        .or_else(|| suggested_target(branches))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branches() -> GitBranches {
        GitBranches {
            is_repo: true,
            current: Some("feature".into()),
            branches: vec!["feature".into(), "main".into(), "older".into()],
            remote_branches: vec!["origin/main".into(), "upstream/dev".into()],
            uncommitted: 0,
            detached: None,
            unborn: None,
            upstream: Some("upstream/dev".into()),
            ahead: None,
            behind: None,
            default_branch: Some("main".into()),
            has_remote: Some(true),
            remote_state: Some("local-ref".into()),
        }
    }

    #[test]
    fn resource_keeps_last_good_for_same_key_and_clears_for_new_key() {
        let mut resource = Resource::default();
        let (first, _) = resource.begin("one".into());
        resource.finish(first, Ok(7));
        let (same, _) = resource.begin("one".into());
        resource.finish(same, Err("failed".into()));
        assert_eq!(resource.data, Some(7));
        assert_eq!(resource.warning.as_deref(), Some("failed"));
        resource.begin("two".into());
        assert_eq!(resource.data, None);
    }

    #[test]
    fn stale_resource_completion_is_rejected() {
        let mut resource = Resource::default();
        let (old, _) = resource.begin("one".into());
        resource.begin("two".into());
        resource.finish(old, Ok(1));
        assert_eq!(resource.data, None);
    }

    #[test]
    fn clear_cannot_reuse_generation_for_a_previous_owner() {
        let mut resource = Resource::default();
        let (old_owner, _) = resource.begin("owner-one".into());
        resource.clear();
        let (new_owner, _) = resource.begin("owner-two".into());
        assert_ne!(old_owner.generation, new_owner.generation);
        resource.finish(old_owner, Ok(1));
        assert_eq!(resource.data, None);
        resource.finish(new_owner, Ok(2));
        assert_eq!(resource.data, Some(2));
    }

    #[test]
    fn branch_targets_keep_locals_before_last_fetched_remotes() {
        let targets = branch_targets(&branches());
        assert_eq!(targets[0].0, "refs/heads/main");
        assert_eq!(targets[1].0, "refs/heads/older");
        assert_eq!(targets[2].1, "Last fetched · origin/main");
    }

    #[test]
    fn upstream_precedes_default_and_fallback_targets() {
        assert_eq!(
            suggested_target(Some(&branches())).as_deref(),
            Some("refs/remotes/upstream/dev")
        );
    }

    #[test]
    fn missing_comparison_target_reselects_the_current_suggestion() {
        assert_eq!(
            resolved_target(Some("refs/heads/deleted"), Some(&branches())).as_deref(),
            Some("refs/remotes/upstream/dev")
        );
        assert_eq!(
            resolved_target(Some("refs/heads/main"), Some(&branches())).as_deref(),
            Some("refs/heads/main")
        );
    }

    #[test]
    fn file_roving_uses_visible_order_and_bounds() {
        let paths = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(roving_file_target(&paths, Some("b"), "up"), Some("a"));
        assert_eq!(roving_file_target(&paths, Some("b"), "down"), Some("c"));
        assert_eq!(roving_file_target(&paths, Some("a"), "home"), Some("a"));
        assert_eq!(roving_file_target(&paths, Some("a"), "end"), Some("c"));
    }
}
