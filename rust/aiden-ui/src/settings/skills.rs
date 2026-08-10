//! Managed and discovered Skills settings.
//!
//! Managed skills live in the portable [`ConfigStore`]. Discovered skills are
//! read-only `SKILL.md` records loaded off-thread by `aiden_data`; every scan
//! is fenced by both a monotonically increasing generation and the complete
//! workspace capability identity.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use aiden_data::portable_config::{Skill, Workspace, WorkspacePermission};
use aiden_data::skills_discovery::{
    discover_skills_cancellable, DiscoveredSkill, DiscoveredSkillSource,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, uniform_list, AnyElement, App, AppContext as _, Context,
    Entity, FocusHandle, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, StyledExt as _,
};

use super::SettingsView;

const MANAGED_ROW_HEIGHT: f32 = 68.0;
const DISCOVERED_ROW_HEIGHT: f32 = 60.0;
const LIST_MAX_HEIGHT: f32 = 480.0;
const INSTRUCTIONS_MIN_HEIGHT: f32 = 160.0;
const INSTRUCTIONS_MAX_HEIGHT: f32 = 320.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SkillsWorkspaceIdentity {
    id: Option<String>,
    folder: Option<PathBuf>,
    permission: Option<WorkspacePermission>,
}

impl SkillsWorkspaceIdentity {
    fn from_workspace(workspace: Option<&Workspace>) -> Self {
        Self {
            id: workspace.map(|workspace| workspace.id.clone()),
            folder: workspace
                .and_then(|workspace| workspace.folder_path.as_deref())
                .map(PathBuf::from),
            permission: workspace.map(|workspace| workspace.permission),
        }
    }

    fn scan_root(&self) -> Option<PathBuf> {
        (self.permission != Some(WorkspacePermission::None))
            .then(|| self.folder.clone())
            .flatten()
    }
}

pub(crate) struct SkillEditorDraft {
    id: String,
    enabled: bool,
    name: Entity<InputState>,
    description: Entity<InputState>,
    instructions: Entity<InputState>,
    error: Option<String>,
    /// Input notifications belong to this editor instance. Dropping or
    /// replacing the modal immediately unregisters all three subscriptions.
    _subscriptions: Vec<gpui::Subscription>,
}

#[derive(Clone)]
pub(crate) struct DeleteDraft {
    skill: Skill,
}

pub(crate) enum SkillsModal {
    Editor(SkillEditorDraft),
    Delete(DeleteDraft),
}

pub(crate) struct SkillsState {
    pub(crate) configured: Vec<Skill>,
    pub(crate) discovered: Vec<DiscoveredSkill>,
    pub(crate) managed_loading: bool,
    pub(crate) discovery_loading: bool,
    pub(crate) managed_error: Option<String>,
    pub(crate) discovery_error: Option<String>,
    pub(crate) busy: bool,
    workspace: SkillsWorkspaceIdentity,
    managed_generation: u64,
    scan_generation: u64,
    scan_cancel: Arc<AtomicBool>,
    pub(crate) modal: Option<SkillsModal>,
    pub(crate) modal_scope: FocusHandle,
    pub(crate) modal_first_focus: FocusHandle,
    pub(crate) modal_last_focus: FocusHandle,
    new_skill_focus: FocusHandle,
    return_focus: Option<FocusHandle>,
}

impl SkillsState {
    pub(crate) fn new(cx: &mut Context<SettingsView>, workspace: Option<&Workspace>) -> Self {
        Self {
            configured: Vec::new(),
            discovered: Vec::new(),
            managed_loading: false,
            discovery_loading: false,
            managed_error: None,
            discovery_error: None,
            busy: false,
            workspace: SkillsWorkspaceIdentity::from_workspace(workspace),
            managed_generation: 0,
            scan_generation: 0,
            scan_cancel: Arc::new(AtomicBool::new(false)),
            modal: None,
            modal_scope: cx.focus_handle(),
            modal_first_focus: cx.focus_handle(),
            modal_last_focus: cx.focus_handle(),
            new_skill_focus: cx.focus_handle(),
            return_focus: None,
        }
    }

    pub(crate) fn modal_open(&self) -> bool {
        self.modal.is_some()
    }

    fn scan_is_current(&self, generation: u64, owner: &SkillsWorkspaceIdentity) -> bool {
        scan_result_is_current(self.scan_generation, &self.workspace, generation, owner)
    }
}

impl SettingsView {
    pub(crate) fn set_skills_workspace(
        &mut self,
        workspace: Option<&Workspace>,
        cx: &mut Context<Self>,
    ) {
        let identity = SkillsWorkspaceIdentity::from_workspace(workspace);
        if self.skills.workspace == identity {
            return;
        }
        self.skills.scan_cancel.store(true, Ordering::Release);
        self.skills.scan_generation = self.skills.scan_generation.wrapping_add(1);
        self.skills.workspace = identity;
        self.skills.discovered.clear();
        self.skills.discovery_error = None;
        self.skills.discovery_loading = false;
        self.refresh_discovered_skills(cx);
        cx.notify();
    }

    pub(crate) fn refresh_skills(&mut self, cx: &mut Context<Self>) {
        self.refresh_managed_skills(cx);
        self.refresh_discovered_skills(cx);
    }

    pub(crate) fn refresh_managed_skills(&mut self, cx: &mut Context<Self>) {
        // A mutation owns the newest catalog generation and finishes by
        // listing the committed state. Letting an external watcher supersede
        // it here could strand `busy=true` when the mutation completion is
        // correctly rejected as stale.
        if self.skills.busy {
            return;
        }
        self.skills.managed_generation = self.skills.managed_generation.wrapping_add(1);
        let generation = self.skills.managed_generation;
        self.skills.managed_loading = true;
        self.skills.managed_error = None;
        let config = self.services.config.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { config.list_skills() })
                .await;
            this.update(cx, |this, cx| {
                if this.skills.managed_generation != generation {
                    return;
                }
                this.skills.managed_loading = false;
                match result {
                    Ok(skills) => this.skills.configured = skills,
                    Err(error) => this.skills.managed_error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_discovered_skills(&mut self, cx: &mut Context<Self>) {
        self.skills.scan_cancel.store(true, Ordering::Release);
        self.skills.scan_generation = self.skills.scan_generation.wrapping_add(1);
        let generation = self.skills.scan_generation;
        let owner = self.skills.workspace.clone();
        let root = owner.scan_root();
        let cancel = Arc::new(AtomicBool::new(false));
        self.skills.scan_cancel = cancel.clone();
        self.skills.discovery_loading = true;
        self.skills.discovery_error = None;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    discover_skills_cancellable(root.as_deref(), cancel.as_ref())
                })
                .await;
            this.update(cx, |this, cx| {
                if !this.skills.scan_is_current(generation, &owner) {
                    return;
                }
                this.skills.discovery_loading = false;
                match result {
                    Ok(mut skills) => {
                        sort_discovered(&mut skills);
                        this.skills.discovered = skills;
                    }
                    Err(error) => {
                        if !matches!(
                            error,
                            aiden_data::skills_discovery::SkillsDiscoveryError::Cancelled
                        ) {
                            this.skills.discovery_error = Some(error.to_string());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn skills_modal_open(&self) -> bool {
        self.skills.modal_open()
    }

    pub(crate) fn skills_modal_focus_handles(
        &self,
        cx: &App,
    ) -> Option<(FocusHandle, FocusHandle)> {
        match self.skills.modal.as_ref()? {
            SkillsModal::Editor(draft) => Some((
                draft.name.read(cx).focus_handle(cx),
                self.skills.modal_last_focus.clone(),
            )),
            SkillsModal::Delete(_) => Some((
                self.skills.modal_first_focus.clone(),
                self.skills.modal_last_focus.clone(),
            )),
        }
    }

    pub(crate) fn skills_modal_contains_focus(&self, window: &Window, cx: &App) -> bool {
        self.skills.modal_scope.contains_focused(window, cx)
    }

    pub(crate) fn close_skills_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        replace_owned_modal(&mut self.skills.modal, None);
        restore_focus(self.skills.return_focus.take(), window, cx);
        cx.notify();
    }

    fn open_skill_editor(
        &mut self,
        skill: Option<Skill>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        let skill = skill.unwrap_or_else(|| Skill {
            id: new_skill_id(),
            name: String::new(),
            description: String::new(),
            instructions: String::new(),
            enabled: true,
        });
        let name_value = skill.name.clone();
        let description_value = skill.description.clone();
        let instructions_value = skill.instructions.clone();
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Code Reviewer")
                .default_value(name_value)
        });
        let description = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Reviews code for bugs, style, and security issues")
                .default_value(description_value)
        });
        let instructions = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("When reviewing code: 1) check for…")
                .default_value(instructions_value)
                .auto_grow(6, 12)
        });
        let subscriptions = [name.clone(), description.clone(), instructions.clone()]
            .into_iter()
            .map(|input| {
                cx.subscribe_in(&input, window, |_this, _input, event, _window, cx| {
                    if matches!(
                        event,
                        InputEvent::Change | InputEvent::Focus | InputEvent::Blur
                    ) {
                        cx.notify();
                    }
                })
            })
            .collect();
        self.skills.return_focus = window.focused(cx);
        replace_owned_modal(
            &mut self.skills.modal,
            Some(SkillsModal::Editor(SkillEditorDraft {
                id: skill.id,
                enabled: skill.enabled,
                name: name.clone(),
                description,
                instructions,
                error: None,
                _subscriptions: subscriptions,
            })),
        );
        cx.defer_in(window, move |_this, window, cx| {
            name.update(cx, |input, cx| input.focus(window, cx));
        });
        cx.notify();
    }

    fn open_delete_skill(&mut self, skill: Skill, window: &mut Window, cx: &mut Context<Self>) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        clear_managed_error(&mut self.skills.managed_error);
        self.skills.return_focus = window.focused(cx);
        replace_owned_modal(
            &mut self.skills.modal,
            Some(SkillsModal::Delete(DeleteDraft { skill })),
        );
        let focus = self.skills.modal_first_focus.clone();
        cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        cx.notify();
    }

    fn save_skill_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        let Some(SkillsModal::Editor(draft)) = self.skills.modal.as_ref() else {
            return;
        };
        let name = draft.name.read(cx).value().trim().to_string();
        let description = draft.description.read(cx).value().trim().to_string();
        let instructions = draft.instructions.read(cx).value().to_string();
        if !skill_form_valid(&name, &instructions) {
            return;
        }
        let skill = Skill {
            id: draft.id.clone(),
            name,
            description,
            instructions,
            enabled: draft.enabled,
        };
        if !begin_managed_mutation(&mut self.skills.busy, &mut self.skills.managed_error) {
            return;
        }
        self.skills.managed_generation = self.skills.managed_generation.wrapping_add(1);
        let generation = self.skills.managed_generation;
        let config = self.services.config.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    config.save_skill(&skill)?;
                    config.list_skills()
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.skills.managed_generation != generation {
                    return;
                }
                match result {
                    Ok(skills) => {
                        finish_managed_success(
                            &mut this.skills.busy,
                            &mut this.skills.managed_error,
                        );
                        this.skills.configured = skills;
                        replace_owned_modal(&mut this.skills.modal, None);
                        restore_focus(this.skills.return_focus.take(), window, cx);
                    }
                    Err(error) => {
                        this.skills.busy = false;
                        if let Some(SkillsModal::Editor(draft)) = this.skills.modal.as_mut() {
                            draft.error = Some(error.to_string());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn confirm_delete_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        let Some(SkillsModal::Delete(draft)) = self.skills.modal.as_ref() else {
            return;
        };
        let id = draft.skill.id.clone();
        if !begin_managed_mutation(&mut self.skills.busy, &mut self.skills.managed_error) {
            return;
        }
        self.skills.managed_generation = self.skills.managed_generation.wrapping_add(1);
        let generation = self.skills.managed_generation;
        let config = self.services.config.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    config.remove_skill(&id)?;
                    config.list_skills()
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.skills.managed_generation != generation {
                    return;
                }
                match result {
                    Ok(skills) => {
                        finish_managed_success(
                            &mut this.skills.busy,
                            &mut this.skills.managed_error,
                        );
                        this.skills.configured = skills;
                        replace_owned_modal(&mut this.skills.modal, None);
                        this.skills.return_focus = None;
                        restore_focus(Some(this.skills.new_skill_focus.clone()), window, cx);
                    }
                    Err(error) => {
                        this.skills.busy = false;
                        this.skills.managed_error = Some(error.to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn toggle_skill(&mut self, skill: Skill, enabled: bool, cx: &mut Context<Self>) {
        if !can_start_mutation(self.skills.busy) {
            return;
        }
        let mut skill = skill;
        skill.enabled = enabled;
        if !begin_managed_mutation(&mut self.skills.busy, &mut self.skills.managed_error) {
            return;
        }
        self.skills.managed_generation = self.skills.managed_generation.wrapping_add(1);
        let generation = self.skills.managed_generation;
        let config = self.services.config.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    config.save_skill(&skill)?;
                    config.list_skills()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.skills.managed_generation != generation {
                    return;
                }
                match result {
                    Ok(skills) => {
                        finish_managed_success(
                            &mut this.skills.busy,
                            &mut this.skills.managed_error,
                        );
                        this.skills.configured = skills;
                    }
                    Err(error) => {
                        this.skills.busy = false;
                        this.skills.managed_error = Some(error.to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn skills_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let configured_len = self.skills.configured.len();
        let discovered_len = self.skills.discovered.len();
        let busy = self.skills.busy;

        v_flex()
            .id("settings-skills")
            .gap_4()
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .min_w(px(0.))
                            .gap_1()
                            .child(div().font_semibold().child("Skills"))
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .child("Reusable instruction sets the assistant can invoke as tools when a task matches."),
                            ),
                    )
                    .child(
                        Button::new("settings-skills-new")
                            .primary()
                            .small()
                            .icon(IconName::Plus)
                            .label("New skill")
                            .track_focus(&self.skills.new_skill_focus)
                            .disabled(busy)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.open_skill_editor(None, window, cx);
                            })),
                    ),
            )
            .when(self.skills.managed_loading && configured_len == 0, |el| {
                el.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Loading skills…"),
                )
            })
            .when_some(self.skills.managed_error.clone(), |el, error| {
                el.child(div().text_sm().text_color(theme.danger).child(error))
            })
            .when(!self.skills.managed_loading && configured_len == 0, |el| {
                el.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No skills yet. Create one — e.g. “Code Reviewer” with your review checklist as its instructions."),
                )
            })
            .when(configured_len > 0, |el| {
                el.child(self.managed_skills_list(configured_len, busy, window, cx))
            })
            .when(self.skills.discovery_loading && discovered_len == 0, |el| {
                el.child(
                    div()
                        .pt_2()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Scanning skill folders…"),
                )
            })
            .when_some(self.skills.discovery_error.clone(), |el, error| {
                el.child(div().text_sm().text_color(theme.danger).child(error))
            })
            .when(discovered_len > 0, |el| {
                el.child(
                    v_flex()
                        .pt_2()
                        .gap_2()
                        .child(div().font_semibold().child("From skill folders"))
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child("Auto-discovered SKILL.md files in workspace and global .agents/skills, .claude/skills, and .aiden/{skill,skills} folders. Always available."),
                        )
                        .child(self.discovered_skills_list(discovered_len, cx)),
                )
            })
    }

    fn managed_skills_list(
        &mut self,
        count: usize,
        busy: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let height = (count as f32 * MANAGED_ROW_HEIGHT).min(LIST_MAX_HEIGHT);
        let theme = cx.theme().clone();
        v_flex()
            .id("settings-managed-skills-card")
            .h(px(height))
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .overflow_hidden()
            .child(uniform_list(
                "settings-managed-skills-list",
                count,
                cx.processor(move |this, range: std::ops::Range<usize>, _window, cx| {
                    range
                        .map(|index| {
                            let skill = this.skills.configured[index].clone();
                            let row_id = SharedString::from(format!("managed-skill-{}", skill.id));
                            h_flex()
                                .id(row_id)
                                .h(px(MANAGED_ROW_HEIGHT))
                                .px_3p5()
                                .py_3()
                                .gap_3()
                                .border_b_1()
                                .border_color(theme.border)
                                .child(
                                    v_flex()
                                        .min_w(px(0.))
                                        .flex_1()
                                        .gap_0p5()
                                        .child(
                                            div()
                                                .truncate()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(if skill.name.trim().is_empty() {
                                                    "Untitled skill".to_string()
                                                } else {
                                                    skill.name.clone()
                                                }),
                                        )
                                        .child(
                                            div()
                                                .truncate()
                                                .text_sm()
                                                .text_color(theme.muted_foreground)
                                                .child(if skill.description.trim().is_empty() {
                                                    "No description".to_string()
                                                } else {
                                                    skill.description.clone()
                                                }),
                                        ),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "edit-skill-{}",
                                        skill.id
                                    )))
                                    .small()
                                    .label("Edit")
                                    .disabled(busy)
                                    .on_click({
                                        let skill = skill.clone();
                                        cx.listener(move |this, _event, window, cx| {
                                            this.open_skill_editor(Some(skill.clone()), window, cx);
                                        })
                                    }),
                                )
                                .child(
                                    Switch::new(SharedString::from(format!(
                                        "toggle-skill-{}",
                                        skill.id
                                    )))
                                    .checked(skill.enabled)
                                    .disabled(busy)
                                    .on_click({
                                        let skill = skill.clone();
                                        cx.listener(move |this, checked: &bool, _window, cx| {
                                            this.toggle_skill(skill.clone(), *checked, cx);
                                        })
                                    }),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "delete-skill-{}",
                                        skill.id
                                    )))
                                    .ghost()
                                    .small()
                                    .icon(IconName::Delete)
                                    .tooltip("Delete skill")
                                    .disabled(busy)
                                    .on_click({
                                        let skill = skill.clone();
                                        cx.listener(move |this, _event, window, cx| {
                                            this.open_delete_skill(skill.clone(), window, cx);
                                        })
                                    }),
                                )
                        })
                        .collect()
                }),
            ))
            .into_any_element()
    }

    fn discovered_skills_list(&self, count: usize, cx: &mut Context<Self>) -> AnyElement {
        let height = (count as f32 * DISCOVERED_ROW_HEIGHT).min(LIST_MAX_HEIGHT);
        let theme = cx.theme().clone();
        v_flex()
            .id("settings-discovered-skills-card")
            .h(px(height))
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .overflow_hidden()
            .child(uniform_list(
                "settings-discovered-skills-list",
                count,
                cx.processor(move |this, range: std::ops::Range<usize>, _window, _cx| {
                    range
                        .map(|index| {
                            let skill = &this.skills.discovered[index];
                            let source = discovered_source_label(skill.source);
                            let detail = if skill.description.trim().is_empty() {
                                skill.path.display().to_string()
                            } else {
                                skill.description.clone()
                            };
                            h_flex()
                                .id(SharedString::from(format!("discovered-skill-{}", skill.id)))
                                .h(px(DISCOVERED_ROW_HEIGHT))
                                .px_3p5()
                                .py_3()
                                .gap_3()
                                .border_b_1()
                                .border_color(theme.border)
                                .child(
                                    Icon::new(IconName::Folder)
                                        .size(px(16.))
                                        .text_color(theme.muted_foreground),
                                )
                                .child(
                                    v_flex()
                                        .min_w(px(0.))
                                        .flex_1()
                                        .gap_0p5()
                                        .child(
                                            h_flex()
                                                .gap_2()
                                                .child(
                                                    div()
                                                        .truncate()
                                                        .font_semibold()
                                                        .child(skill.name.clone()),
                                                )
                                                .child(
                                                    div()
                                                        .px_1p5()
                                                        .py_0p5()
                                                        .rounded_md()
                                                        .bg(
                                                            if skill.source
                                                                == DiscoveredSkillSource::Workspace
                                                            {
                                                                theme.accent.opacity(0.12)
                                                            } else {
                                                                theme.secondary
                                                            },
                                                        )
                                                        .text_xs()
                                                        .child(source),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .truncate()
                                                .text_sm()
                                                .text_color(theme.muted_foreground)
                                                .child(detail),
                                        ),
                                )
                        })
                        .collect()
                }),
            ))
            .into_any_element()
    }
}

pub(crate) fn skills_modal(
    settings: &Entity<SettingsView>,
    cx: &mut Context<crate::app::AppState>,
) -> AnyElement {
    let state = settings.read(cx);
    let Some(modal) = state.skills.modal.as_ref() else {
        return div().into_any_element();
    };
    let theme = cx.theme().clone();
    let busy = state.skills.busy;
    let first = state.skills.modal_first_focus.clone();
    let last = state.skills.modal_last_focus.clone();
    let scope = state.skills.modal_scope.clone();

    let content = match modal {
        SkillsModal::Editor(draft) => {
            let valid = skill_form_valid(
                draft.name.read(cx).value().as_ref(),
                draft.instructions.read(cx).value().as_ref(),
            );
            let title = state
                .skills
                .configured
                .iter()
                .find(|skill| skill.id == draft.id)
                .filter(|skill| !skill.name.trim().is_empty())
                .map_or_else(
                    || "New skill".to_string(),
                    |skill| format!("Edit {}", skill.name),
                );
            v_flex()
                .id("settings-skill-editor-dialog")
                .w(px(560.))
                .max_w(gpui::relative(0.92))
                .max_h(gpui::relative(0.9))
                .overflow_y_scroll()
                .gap_4()
                .p_5()
                .rounded(px(16.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.popover)
                .shadow_lg()
                .occlude()
                .track_focus(&scope)
                .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| cx.stop_propagation())
                .on_click(|_event, _window, cx| cx.stop_propagation())
                .child(div().text_lg().font_semibold().child(title))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Define when the model should use this skill and the instructions it should follow."),
                )
                .child(field(
                    "Name",
                    "",
                    Input::new(&draft.name).disabled(busy),
                    theme.muted_foreground,
                ))
                .child(field(
                    "Description",
                    "Shown to the model so it knows when to use this skill.",
                    Input::new(&draft.description).disabled(busy),
                    theme.muted_foreground,
                ))
                .child(
                    v_flex()
                        .gap_1p5()
                        .child(div().text_sm().font_semibold().child("Instructions"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Required. Loaded when the model invokes the skill."),
                        )
                        .child(
                            div()
                                .min_h(px(INSTRUCTIONS_MIN_HEIGHT))
                                .max_h(px(INSTRUCTIONS_MAX_HEIGHT))
                                .child(Input::new(&draft.instructions).disabled(busy)),
                        ),
                )
                .when_some(draft.error.clone(), |el, error| {
                    el.child(div().text_sm().text_color(theme.danger).child(error))
                })
                .child(
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            h_flex()
                                .child(
                                    Button::new("skills-editor-cancel")
                                        .ghost()
                                        .label("Cancel")
                                        .disabled(busy)
                                        .on_click({
                                            let settings = settings.clone();
                                            move |_event, window, cx| settings.update(cx, |state, cx| state.close_skills_modal(window, cx))
                                        }),
                                ),
                        )
                        .child(
                            h_flex()
                                .track_focus(&last)
                                .tab_stop(true)
                                .on_key_down({
                                    let settings = settings.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if !busy
                                            && valid
                                            && matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            )
                                        {
                                            settings.update(cx, |state, cx| {
                                                state.save_skill_editor(window, cx)
                                            });
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("skills-editor-save")
                                        .primary()
                                        .label("Save")
                                        .tab_stop(false)
                                        .disabled(busy || !valid)
                                        .on_click({
                                            let settings = settings.clone();
                                            move |_event, window, cx| settings.update(cx, |state, cx| state.save_skill_editor(window, cx))
                                        }),
                                ),
                        ),
                )
                .into_any_element()
        }
        SkillsModal::Delete(draft) => {
            let name = if draft.skill.name.trim().is_empty() {
                "Untitled skill"
            } else {
                draft.skill.name.as_str()
            };
            v_flex()
                .id("settings-skill-delete-dialog")
                .w(px(360.))
                .max_w(gpui::relative(0.9))
                .gap_3()
                .p_4()
                .rounded(px(16.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.popover)
                .shadow_lg()
                .occlude()
                .track_focus(&scope)
                .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                    cx.stop_propagation()
                })
                .on_click(|_event, _window, cx| cx.stop_propagation())
                .child(div().text_lg().font_semibold().child("Delete this skill?"))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(format!("“{name}” will be removed.")),
                )
                .when_some(state.skills.managed_error.clone(), |el, error| {
                    el.child(div().text_sm().text_color(theme.danger).child(error))
                })
                .child(
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            h_flex()
                                .track_focus(&first)
                                .tab_stop(true)
                                .on_key_down({
                                    let settings = settings.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if !busy
                                            && matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            )
                                        {
                                            settings.update(cx, |state, cx| {
                                                state.close_skills_modal(window, cx)
                                            });
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("skills-delete-cancel")
                                        .ghost()
                                        .label("Cancel")
                                        .tab_stop(false)
                                        .disabled(busy)
                                        .on_click({
                                            let settings = settings.clone();
                                            move |_event, window, cx| {
                                                settings.update(cx, |state, cx| {
                                                    state.close_skills_modal(window, cx)
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
                                    let settings = settings.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if !busy
                                            && matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            )
                                        {
                                            settings.update(cx, |state, cx| {
                                                state.confirm_delete_skill(window, cx)
                                            });
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .child(
                                    Button::new("skills-delete-confirm")
                                        .danger()
                                        .label("Delete")
                                        .tab_stop(false)
                                        .disabled(busy)
                                        .on_click({
                                            let settings = settings.clone();
                                            move |_event, window, cx| {
                                                settings.update(cx, |state, cx| {
                                                    state.confirm_delete_skill(window, cx)
                                                })
                                            }
                                        }),
                                ),
                        ),
                )
                .into_any_element()
        }
    };

    v_flex()
        .id("settings-skills-modal-backdrop")
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
            let settings = settings.clone();
            move |_event, window, cx| {
                cx.stop_propagation();
                settings.update(cx, |state, cx| state.close_skills_modal(window, cx));
            }
        })
        .child(content)
        .into_any_element()
}

fn field(
    label: &'static str,
    help: &'static str,
    input: Input,
    muted: gpui::Hsla,
) -> impl IntoElement {
    v_flex()
        .gap_1p5()
        .child(div().text_sm().font_semibold().child(label))
        .when(!help.is_empty(), |el| {
            el.child(div().text_xs().text_color(muted).child(help))
        })
        .child(input)
}

fn restore_focus(focus: Option<FocusHandle>, window: &mut Window, cx: &mut Context<SettingsView>) {
    if let Some(focus) = focus {
        cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
    }
}

fn skill_form_valid(name: &str, instructions: &str) -> bool {
    !name.trim().is_empty() && !instructions.trim().is_empty()
}

fn can_start_mutation(busy: bool) -> bool {
    !busy
}

fn begin_managed_mutation(busy: &mut bool, error: &mut Option<String>) -> bool {
    if *busy {
        return false;
    }
    *busy = true;
    clear_managed_error(error);
    true
}

fn finish_managed_success(busy: &mut bool, error: &mut Option<String>) {
    *busy = false;
    clear_managed_error(error);
}

fn clear_managed_error(error: &mut Option<String>) {
    *error = None;
}

fn replace_owned_modal<T>(slot: &mut Option<T>, replacement: Option<T>) {
    *slot = replacement;
}

fn scan_result_is_current(
    current_generation: u64,
    current_owner: &SkillsWorkspaceIdentity,
    result_generation: u64,
    result_owner: &SkillsWorkspaceIdentity,
) -> bool {
    current_generation == result_generation && current_owner == result_owner
}

fn discovered_source_label(source: DiscoveredSkillSource) -> &'static str {
    match source {
        DiscoveredSkillSource::Workspace => "workspace",
        DiscoveredSkillSource::Global => "global",
    }
}

fn sort_discovered(skills: &mut [DiscoveredSkill]) {
    skills.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| source_rank(left.source).cmp(&source_rank(right.source)))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn source_rank(source: DiscoveredSkillSource) -> u8 {
    match source {
        DiscoveredSkillSource::Workspace => 0,
        DiscoveredSkillSource::Global => 1,
    }
}

fn new_skill_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("skill-{}", base36(millis))
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("base36 digits are valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_requires_trimmed_name_and_instructions() {
        assert!(skill_form_valid("Reviewer", "Review carefully"));
        assert!(!skill_form_valid("   ", "Review carefully"));
        assert!(!skill_form_valid("Reviewer", "\n\t"));
    }

    #[test]
    fn workspace_permission_controls_only_the_workspace_scan_root() {
        let folder = PathBuf::from("/tmp/project");
        let full = SkillsWorkspaceIdentity {
            id: Some("one".into()),
            folder: Some(folder.clone()),
            permission: Some(WorkspacePermission::Full),
        };
        let none = SkillsWorkspaceIdentity {
            permission: Some(WorkspacePermission::None),
            ..full.clone()
        };
        assert_eq!(full.scan_root(), Some(folder));
        assert_eq!(none.scan_root(), None);
    }

    #[test]
    fn scan_identity_includes_folder_and_permission() {
        let original = SkillsWorkspaceIdentity {
            id: Some("same".into()),
            folder: Some(PathBuf::from("/one")),
            permission: Some(WorkspacePermission::Full),
        };
        let moved = SkillsWorkspaceIdentity {
            folder: Some(PathBuf::from("/two")),
            ..original.clone()
        };
        let revoked = SkillsWorkspaceIdentity {
            permission: Some(WorkspacePermission::None),
            ..original.clone()
        };
        assert_ne!(original, moved);
        assert_ne!(original, revoked);
    }

    #[test]
    fn source_order_prefers_workspace_for_equal_names() {
        assert!(
            source_rank(DiscoveredSkillSource::Workspace)
                < source_rank(DiscoveredSkillSource::Global)
        );
        assert_eq!(
            discovered_source_label(DiscoveredSkillSource::Workspace),
            "workspace"
        );
        assert_eq!(
            discovered_source_label(DiscoveredSkillSource::Global),
            "global"
        );

        let make_skill = |name: &str, source, path: &str| DiscoveredSkill {
            id: format!("{source:?}-{path}"),
            name: name.to_string(),
            description: String::new(),
            instructions: String::new(),
            source,
            path: PathBuf::from(path),
            version: aiden_data::skills_discovery::SkillFileVersion {
                device: 1,
                inode: 1,
                byte_length: 1,
                sha256: "hash".to_string(),
            },
        };
        let mut skills = vec![
            make_skill("zeta", DiscoveredSkillSource::Global, "/zeta"),
            make_skill("Alpha", DiscoveredSkillSource::Global, "/global-alpha"),
            make_skill(
                "alpha",
                DiscoveredSkillSource::Workspace,
                "/workspace-alpha",
            ),
        ];
        sort_discovered(&mut skills);
        assert_eq!(skills[0].source, DiscoveredSkillSource::Workspace);
        assert_eq!(skills[1].source, DiscoveredSkillSource::Global);
        assert_eq!(skills[2].name, "zeta");
    }

    #[test]
    fn stale_scan_generation_or_owner_is_rejected() {
        let owner = SkillsWorkspaceIdentity {
            id: Some("workspace".into()),
            folder: Some(PathBuf::from("/one")),
            permission: Some(WorkspacePermission::Ask),
        };
        let moved = SkillsWorkspaceIdentity {
            folder: Some(PathBuf::from("/two")),
            ..owner.clone()
        };
        assert!(scan_result_is_current(8, &owner, 8, &owner));
        assert!(!scan_result_is_current(8, &owner, 7, &owner));
        assert!(!scan_result_is_current(8, &owner, 8, &moved));
    }

    #[test]
    fn busy_state_rejects_duplicate_mutations() {
        assert!(can_start_mutation(false));
        assert!(!can_start_mutation(true));
    }

    #[test]
    fn mutation_lifecycle_clears_stale_errors_on_start_and_success() {
        let mut busy = false;
        let mut error = Some("old failure".to_string());
        assert!(begin_managed_mutation(&mut busy, &mut error));
        assert!(busy);
        assert_eq!(error, None);

        error = Some("impossible stale error".to_string());
        finish_managed_success(&mut busy, &mut error);
        assert!(!busy);
        assert_eq!(error, None);
    }

    #[test]
    fn replacing_or_closing_a_modal_drops_its_scoped_resources() {
        use std::sync::atomic::AtomicUsize;

        struct DropProbe(Arc<AtomicUsize>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }

        let drops = Arc::new(AtomicUsize::new(0));
        let mut modal = None;
        replace_owned_modal(&mut modal, Some(DropProbe(drops.clone())));
        assert_eq!(drops.load(Ordering::Relaxed), 0);
        replace_owned_modal(&mut modal, Some(DropProbe(drops.clone())));
        assert_eq!(drops.load(Ordering::Relaxed), 1);
        replace_owned_modal(&mut modal, None);
        assert_eq!(drops.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn base36_ids_are_stable_and_compact() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }

    #[test]
    fn list_geometry_is_bounded_for_large_catalogs() {
        assert_eq!((1.0 * MANAGED_ROW_HEIGHT).min(LIST_MAX_HEIGHT), 68.0);
        assert_eq!((500.0 * MANAGED_ROW_HEIGHT).min(LIST_MAX_HEIGHT), 480.0);
        assert_eq!((1000.0 * DISCOVERED_ROW_HEIGHT).min(LIST_MAX_HEIGHT), 480.0);
    }
}
