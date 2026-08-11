//! MCP servers settings (port of `mcp-settings.tsx`).
//!
//! Lists the configured servers from the portable config, toggles each
//! server's enabled state, adds stdio servers (command/args/env), removes
//! them, and tests connections through `aiden_mcp::client::McpClientManager`
//! (async, run on the tokio bridge with a spinner while pending). OAuth
//! servers render a placeholder badge; the interactive OAuth flow is out of
//! scope for this pass.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::portable_config::McpServer;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, ElementId, Entity, Focusable as _,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    scroll::ScrollableElement as _,
    select::{Select, SelectEvent, SelectItem, SelectState},
    spinner::Spinner,
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, IconName, Sizable as _,
};
use gpui_tokio_bridge::Tokio;

use super::{SettingsServices, SettingsView};

/// A server as listed, owned for rendering. The full portable record is kept
/// so toggles/tests rebuild the exact stored connection (headers, URLs, etc.)
/// without field loss.
#[derive(Debug, Clone)]
pub struct McpServerRow {
    pub record: McpServer,
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    #[allow(dead_code)] // kept for round-trip fidelity; the row UI shows command + args
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub oauth: bool,
    pub preset_id: Option<String>,
    pub enabled: bool,
}

impl From<&McpServer> for McpServerRow {
    fn from(server: &McpServer) -> Self {
        Self {
            record: server.clone(),
            id: server.id.clone(),
            name: server.name.clone(),
            transport: match server.transport {
                aiden_data::portable_config::McpTransport::Stdio => "stdio".to_string(),
                aiden_data::portable_config::McpTransport::Http => "http".to_string(),
                aiden_data::portable_config::McpTransport::Sse => "sse".to_string(),
            },
            command: server.command.clone(),
            args: server.args.clone().unwrap_or_default(),
            env: server.env.clone().unwrap_or_default(),
            url: server.url.clone(),
            oauth: server.oauth.unwrap_or(false),
            preset_id: server.preset_id.clone(),
            enabled: server.enabled,
        }
    }
}

/// Per-server test-connection status.
#[derive(Debug, Clone, Default)]
pub struct McpTestStatus {
    pub connected: bool,
    pub tool_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpModal {
    CustomEditor,
    PresetSetup(&'static str),
    RemoveConfirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransportItem {
    value: aiden_data::portable_config::McpTransport,
    label: &'static str,
}

impl SelectItem for TransportItem {
    type Value = aiden_data::portable_config::McpTransport;

    fn title(&self) -> SharedString {
        self.label.into()
    }

    fn value(&self) -> &Self::Value {
        &self.value
    }
}

/// Inline add-server draft (input entities created when the form opens).
pub struct McpDraft {
    pub id: String,
    pub name: Entity<InputState>,
    transport: aiden_data::portable_config::McpTransport,
    transport_select: Entity<SelectState<Vec<TransportItem>>>,
    pub command: Entity<InputState>,
    pub args: Entity<InputState>,
    pub env: Entity<InputState>,
    pub url: Entity<InputState>,
    pub headers: Entity<InputState>,
    pub preset_key: Entity<InputState>,
    pub oauth: bool,
    pub enabled: bool,
    pub preset_id: Option<String>,
    pub editing: bool,
    pub saving: bool,
    pub authorizing: bool,
    pub revoking: bool,
    pub preset_key_removing: bool,
}

#[derive(Default)]
pub struct McpState {
    pub servers: Vec<McpServerRow>,
    pub modal: Option<McpModal>,
    pub adding: Option<McpDraft>,
    pub removing: Option<String>,
    pub removing_busy: bool,
    pub testing: Option<String>,
    pub statuses: BTreeMap<String, McpTestStatus>,
    pub preset_badges: BTreeMap<String, String>,
    pub status_revision: u64,
    /// Fences connection-test results across edits, removal, and reset.
    pub connection_revision: u64,
    pub statuses_loaded: bool,
    pub oauth_revision: Arc<AtomicU64>,
    pub error: Option<String>,
    return_focus: Option<gpui::FocusHandle>,
    modal_scope: Option<gpui::FocusHandle>,
    modal_first_focus: Option<gpui::FocusHandle>,
    modal_last_focus: Option<gpui::FocusHandle>,
    _subscriptions: Vec<gpui::Subscription>,
}

/// Parse `KEY=VALUE` lines (the TS `linesToRecord`).
pub fn parse_env_lines(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(index) = line.find('=') {
            let key = line[..index].trim();
            let value = line[index + 1..].trim();
            if !key.is_empty() {
                out.insert(key.to_string(), value.to_string());
            }
        }
    }
    out
}

/// Format a record as `KEY=VALUE` lines (the TS `recordToLines`).
#[allow(dead_code)] // round-trip helper for the env editor; the row UI hides env today
pub fn format_env_lines(record: &BTreeMap<String, String>) -> String {
    record
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

const MCP_EDITOR_TEXTAREA_MIN_ROWS: usize = 3;
const MCP_EDITOR_TEXTAREA_MAX_ROWS: usize = 8;

/// Parse space-separated command arguments (the TS `args.split(/\s+/)`).
pub fn parse_args_text(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_string).collect()
}

fn custom_oauth_actions_visible(
    transport: aiden_data::portable_config::McpTransport,
    preset_id: Option<&str>,
    oauth: bool,
) -> bool {
    transport == aiden_data::portable_config::McpTransport::Http && preset_id.is_none() && oauth
}

fn mcp_gallery_columns(viewport_width: f32) -> usize {
    if viewport_width >= 880.0 {
        2
    } else {
        1
    }
}

fn connection_result_is_current(current: u64, expected: u64) -> bool {
    current == expected
}

fn preset_key_removal_is_current(
    current_revision: u64,
    expected_revision: u64,
    current_server_id: Option<&str>,
    expected_server_id: &str,
) -> bool {
    current_revision == expected_revision && current_server_id == Some(expected_server_id)
}

impl SettingsView {
    /// The MCP section: server list + toggles + add form.
    pub(crate) fn mcp_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if !self.mcp.statuses_loaded {
            self.mcp.statuses_loaded = true;
            self.mcp.refresh_credential_statuses(&self.services, cx);
        }
        let theme = cx.theme().clone();
        let state = &self.mcp;
        let width: f32 = window.viewport_size().width.into();
        let two_columns = mcp_gallery_columns(width) == 2;

        v_flex()
            .id("mcp-section")
            .w_full()
            .gap_4()
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .flex_1()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("MCP servers"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .mt_0p5()
                                    .child(
                                    "Connect tool providers or add your own server. Tool inputs \
                                         may be shared with the configured server.",
                                ),
                            ),
                    )
                    .child(
                        Button::new("reset-mcp-connections")
                            .small()
                            .ghost()
                            .label("Reset connections")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.mcp.reset_connections(&this.services, cx);
                            })),
                    ),
            )
            .when_some(state.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .text_sm()
                        .text_color(theme.danger)
                        .child(message),
                )
            })
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("Configured MCP servers · {}", state.servers.len())),
                    )
                    .child(self.mcp_card(cx)),
            )
            .child(self.mcp_preset_gallery(two_columns, cx))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(
                        v_flex()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Manual MCP server setup"))
                            .child(div().text_xs().text_color(theme.muted_foreground).child("Add a local command, streamable HTTP server, or legacy MCP SSE endpoint.")),
                    )
                    .child(
                        Button::new("add-mcp-server")
                            .small()
                            .icon(IconName::Plus)
                            .label("Add custom MCP")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.mcp.open_draft(window, cx);
                            })),
                    ),
            )
            .when_some(state.modal, |el, modal| {
                el.child(self.mcp_modal(modal, cx))
            })
    }

    /// The server list card (empty state or rows).
    fn mcp_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let border = theme.border;
        let muted_foreground = theme.muted_foreground;
        let servers = self.mcp.servers.clone();
        if servers.is_empty() {
            return div()
                .w_full()
                .px_3()
                .py_3()
                .rounded_lg()
                .border_1()
                .border_color(border)
                .text_sm()
                .text_color(muted_foreground)
                .child("No MCP servers configured yet.")
                .into_any_element();
        }
        v_flex()
            .w_full()
            .rounded_lg()
            .border_1()
            .border_color(border)
            .children(servers.iter().enumerate().map(|(index, row)| {
                let row = row.clone();
                div()
                    .w_full()
                    .when(index > 0, |el| el.border_t_1().border_color(border))
                    .child(self.mcp_row(&row, cx))
            }))
            .into_any_element()
    }

    fn mcp_row(&self, row: &McpServerRow, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let id = row.id.clone();
        let name = row.name.clone();
        let transport = row.transport.clone();
        let subtitle = if transport == "stdio" {
            let mut parts = vec![row.command.clone().unwrap_or_default()];
            parts.extend(row.args.iter().cloned());
            parts.retain(|part| !part.is_empty());
            if parts.is_empty() {
                "No command".to_string()
            } else {
                parts.join(" ")
            }
        } else {
            row.url.clone().unwrap_or_else(|| "No URL".to_string())
        };
        let enabled = row.enabled;
        let oauth = row.oauth;
        let is_testing = self.mcp.testing.as_deref() == Some(id.as_str());
        let status = self.mcp.statuses.get(&id).cloned().unwrap_or_default();
        let preset = row.preset_id.is_some();

        h_flex()
            .id(ElementId::Name(SharedString::from(format!("mcp-row-{id}"))))
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .child(
                v_flex()
                    .flex_1()
                    .min_w(gpui::px(0.))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .child(if name.is_empty() {
                                        "Untitled server".to_string()
                                    } else {
                                        name
                                    }),
                            )
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.muted)
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(transport),
                            )
                            .when(preset, |el| {
                                el.child(
                                    div()
                                        .px_1p5()
                                        .py_0p5()
                                        .rounded_md()
                                        .bg(theme.info.opacity(0.14))
                                        .text_xs()
                                        .text_color(theme.info)
                                        .child("built-in"),
                                )
                            })
                            .when(oauth, |el| {
                                el.child(
                                    div()
                                        .px_1p5()
                                        .py_0p5()
                                        .rounded_md()
                                        .bg(theme.muted)
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("OAuth"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(subtitle),
                    )
                    .when_some(status.error, |el, error| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(theme.danger)
                                .mt_0p5()
                                .child(error),
                        )
                    })
                    .when_some(
                        status.connected.then_some(status.tool_count),
                        |el, tools| {
                            el.child(div().text_xs().text_color(theme.success).mt_0p5().child(
                                format!(
                                    "Connected — {tools} tool{} available.",
                                    if tools == 1 { "" } else { "s" }
                                ),
                            ))
                        },
                    ),
            )
            .child({
                let click_record = row.record.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "mcp-edit-{id}"
                ))))
                .small()
                .label(if preset { "Manage" } else { "Edit" })
                .on_click(cx.listener(move |this, _event, window, cx| {
                    this.mcp.open_edit(click_record.clone(), window, cx);
                }))
            })
            .child({
                let click_id = id.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "mcp-test-{id}"
                ))))
                .small()
                .ghost()
                .label(if is_testing { "Connecting…" } else { "Test" })
                .disabled(is_testing)
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.mcp.test_server(&click_id, &this.services, cx);
                }))
            })
            .child({
                let click_id = id.clone();
                Switch::new(ElementId::Name(SharedString::from(format!(
                    "mcp-enabled-{id}"
                ))))
                .checked(enabled)
                .label(if enabled { "Enabled" } else { "Disabled" })
                .on_click(cx.listener(move |this, checked, _window, cx| {
                    this.mcp
                        .toggle_server(&click_id, *checked, &this.services, cx);
                }))
            })
            .child({
                let click_id = id.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "mcp-remove-{id}"
                ))))
                .small()
                .ghost()
                .icon(IconName::Delete)
                .tooltip("Remove server")
                .on_click(cx.listener(move |this, _event, window, cx| {
                    this.mcp.return_focus = window.focused(cx);
                    this.mcp.prepare_modal_focus(cx);
                    this.mcp.removing = Some(click_id.clone());
                    this.mcp.modal = Some(McpModal::RemoveConfirm);
                    if let Some(focus) = this.mcp.modal_first_focus.clone() {
                        focus.focus(window);
                    }
                    cx.notify();
                }))
            })
            .child(if is_testing {
                Spinner::new()
                    .small()
                    .color(theme.accent)
                    .into_any_element()
            } else {
                div().into_any_element()
            })
    }

    fn mcp_preset_gallery(&self, two_columns: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .w_full()
            .gap_2()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Popular MCPs"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Hand-picked hosted servers with explicit credential setup."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .when(two_columns, |el| el.flex_row())
                    .when(!two_columns, |el| el.flex_col())
                    .gap_3()
                    .children(aiden_mcp::MCP_PRESETS.iter().map(|preset| {
                        let configured = self
                            .mcp
                            .servers
                            .iter()
                            .any(|row| row.preset_id.as_deref() == Some(preset.id));
                        let badge = self
                            .mcp
                            .preset_badges
                            .get(preset.id)
                            .cloned()
                            .unwrap_or_else(|| match preset.auth {
                                aiden_mcp::McpPresetAuth::ApiKey { .. } => "Needs key".into(),
                                aiden_mcp::McpPresetAuth::OAuth => "Needs sign-in".into(),
                            });
                        let preset_id = preset.id;
                        v_flex()
                            .id(ElementId::Name(format!("mcp-preset-{preset_id}").into()))
                            .flex_1()
                            .min_w(gpui::px(0.))
                            .gap_2()
                            .p_4()
                            .rounded_lg()
                            .border_1()
                            .border_color(theme.border)
                            .child(
                                h_flex()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(preset.name),
                                    )
                                    .child(
                                        div()
                                            .px_2()
                                            .py_0p5()
                                            .rounded_md()
                                            .bg(if badge == "Ready" {
                                                theme.success.opacity(0.14)
                                            } else {
                                                theme.muted
                                            })
                                            .text_xs()
                                            .text_color(if badge == "Ready" {
                                                theme.success
                                            } else {
                                                theme.muted_foreground
                                            })
                                            .child(badge),
                                    ),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(preset.tagline),
                            )
                            .child(
                                h_flex()
                                    .mt_1()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child(preset.vendor),
                                    )
                                    .child(
                                        Button::new(ElementId::Name(
                                            format!("mcp-preset-setup-{preset_id}").into(),
                                        ))
                                        .small()
                                        .label(if configured { "Manage" } else { "Set Up" })
                                        .on_click(
                                            cx.listener(move |this, _event, window, cx| {
                                                this.mcp.open_preset(preset_id, window, cx);
                                            }),
                                        ),
                                    ),
                            )
                    })),
            )
    }

    fn mcp_modal(&self, modal: McpModal, cx: &mut Context<Self>) -> impl IntoElement {
        let modal_background = cx.theme().background.opacity(0.74);
        let busy = self.mcp.removing_busy
            || self
                .mcp
                .adding
                .as_ref()
                .is_some_and(|draft| draft.saving || draft.authorizing || draft.revoking);
        let scope = self.mcp.modal_scope.clone();
        let key_scope = scope.clone();
        let first = match modal {
            McpModal::CustomEditor | McpModal::PresetSetup(_) => self
                .mcp
                .adding
                .as_ref()
                .map(|draft| draft.name.read(cx).focus_handle(cx)),
            McpModal::RemoveConfirm => self.mcp.modal_first_focus.clone(),
        };
        let last = self.mcp.modal_last_focus.clone();
        let content = match modal {
            McpModal::CustomEditor | McpModal::PresetSetup(_) => self
                .mcp
                .adding
                .as_ref()
                .map(|draft| self.mcp_editor(draft, cx).into_any_element()),
            McpModal::RemoveConfirm => self
                .mcp
                .removing
                .as_deref()
                .map(|server_id| self.mcp_remove_confirm(server_id, cx).into_any_element()),
        };
        div()
            .id("mcp-modal-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(modal_background)
            .p_6()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(|_event, _window, cx| cx.stop_propagation())
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    if event.keystroke.key.as_str() == "escape" && !busy {
                        this.mcp.close_modal(window);
                        cx.stop_propagation();
                        cx.notify();
                        return;
                    }
                    if event.keystroke.key.as_str() == "tab" {
                        let Some(first) = first.as_ref() else {
                            return;
                        };
                        let Some(last) = last.as_ref() else {
                            return;
                        };
                        let focused = window.focused(cx);
                        let backwards = event.keystroke.modifiers.shift;
                        let focus_inside = key_scope
                            .as_ref()
                            .is_some_and(|scope| scope.contains_focused(window, cx));
                        if backwards && focused.as_ref() == Some(first) {
                            last.focus(window);
                        } else if !backwards && focused.as_ref() == Some(last) {
                            first.focus(window);
                        } else if !focus_inside {
                            if backwards {
                                last.focus(window);
                            } else {
                                first.focus(window);
                            }
                        } else {
                            return;
                        }
                        cx.stop_propagation();
                    }
                }),
            )
            .when_some(content, |el, content| {
                el.child(
                    div()
                        .when_some(scope, |el, scope| el.track_focus(&scope))
                        .child(content),
                )
            })
    }

    /// The add-stdio-server form.
    fn mcp_editor(&self, draft: &McpDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let name_value = draft.name.read(cx).value().to_string();
        let command_value = draft.command.read(cx).value().to_string();
        let url_value = draft.url.read(cx).value().to_string();
        let remote = draft.transport != aiden_data::portable_config::McpTransport::Stdio;
        let can_save = !name_value.trim().is_empty()
            && if remote {
                !url_value.trim().is_empty()
            } else {
                !command_value.trim().is_empty()
            };
        let preset = draft
            .preset_id
            .as_deref()
            .and_then(aiden_mcp::get_mcp_preset);
        let title = preset
            .map(|preset| format!("{} setup", preset.name))
            .unwrap_or_else(|| {
                if draft.editing {
                    "Edit MCP server".into()
                } else {
                    "Add MCP server".into()
                }
            });
        let busy = draft.saving || draft.authorizing || draft.revoking || draft.preset_key_removing;

        v_flex()
            .id("mcp-editor")
            .w(gpui::px(620.))
            .max_w_full()
            .max_h(gpui::relative(0.9))
            .overflow_y_scrollbar()
            .gap_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .bg(theme.background)
            .occlude()
            .px_4()
            .py_3()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .child(
                        Button::new("close-mcp-editor")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .disabled(busy)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.mcp.close_modal(window);
                                cx.notify();
                            })),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Name"),
                            )
                            .child(Input::new(&draft.name).small().disabled(busy)),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Connection"),
                            )
                            .child(
                                Select::new(&draft.transport_select)
                                    .small()
                                    .disabled(
                                        busy
                                            || draft.preset_id.is_some()
                                            || draft.transport
                                                == aiden_data::portable_config::McpTransport::Sse,
                                    ),
                            ),
                    ),
            )
            .when(!remote, |el| el.child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Command"),
                    )
                    .child(Input::new(&draft.command).small().disabled(busy)),
            ))
            .when(!remote, |el| el.child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Arguments"),
                    )
                    .child(Input::new(&draft.args).small().disabled(busy)),
            ))
            .when(!remote, |el| el.child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme.muted_foreground).child("Environment · one KEY=VALUE per line"))
                    .child(Input::new(&draft.env).small().disabled(busy))
                    .child(div().text_xs().text_color(theme.muted_foreground).child("Environment values are portable plaintext in ~/.aiden/config.json. Use only values you intend to store there.")),
            ))
            .when(remote, |el| el
                .child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme.muted_foreground).child("Server URL"))
                        .child(Input::new(&draft.url).small().disabled(busy)),
                )
                .child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme.muted_foreground).child("Headers · one KEY=VALUE per line"))
                        .child(Input::new(&draft.headers).small().disabled(busy))
                        .child(div().text_xs().text_color(theme.muted_foreground).child("Manual headers are portable plaintext in ~/.aiden/config.json. OAuth tokens and preset keys are encrypted separately.")),
                )
                .when(draft.preset_id.is_none(), |el| el.child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(v_flex().child(div().text_sm().child("OAuth sign-in")).child(div().text_xs().text_color(theme.muted_foreground).child("Only explicit Authorize opens your browser.")))
                        .child(Switch::new("mcp-editor-oauth").checked(draft.oauth).disabled(busy).on_click(cx.listener(|this, checked, _window, cx| {
                            if let Some(draft) = this.mcp.adding.as_mut() {
                                draft.oauth = *checked;
                            }
                            cx.notify();
                        }))),
                ))
            )
            .when_some(preset, |el, preset| match preset.auth {
                aiden_mcp::McpPresetAuth::ApiKey { key_help_url, .. } => el.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("API key"))
                        .child(Input::new(&draft.preset_key).small().mask_toggle().disabled(busy))
                        .child(h_flex().gap_2()
                            .child(Button::new("mcp-key-help").link().small().label(format!("Get a key from {}", preset.name)).on_click(move |_, _, cx| cx.open_url(key_help_url)))
                        .child(Button::new("mcp-key-remove").small().ghost().label(if draft.preset_key_removing { "Removing…" } else { "Remove saved key" }).disabled(busy || draft.preset_key_removing).on_click(cx.listener(|this, _, _, cx| {
                                this.mcp.clear_draft_preset_key(&this.services, cx);
                            })))),
                ),
                aiden_mcp::McpPresetAuth::OAuth => el.child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(v_flex().child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Browser authorization")).child(div().text_xs().text_color(theme.muted_foreground).child("Aiden stores tokens encrypted on this device and never contacts userinfo.")))
                        .child(
                            h_flex()
                                .gap_2()
                                .child(Button::new("mcp-authorize").small().primary().label(if draft.authorizing { "Waiting for browser…" } else { "Authorize / Reauthorize" }).disabled(busy || !can_save).on_click(cx.listener(|this, _, _, cx| {
                                    this.mcp.authorize_draft(&this.services, cx);
                                })))
                                .child(Button::new("mcp-cancel-authorize").small().ghost().label("Cancel").disabled(!draft.authorizing).on_click(cx.listener(|this, _, _, cx| {
                                    this.mcp.cancel_authorization(&this.services, cx);
                                })))
                                .child(Button::new("mcp-revoke-oauth").small().danger().label(if draft.revoking { "Signing out…" } else { "Sign out" }).disabled(busy).on_click(cx.listener(|this, _, _, cx| {
                                    this.mcp.revoke_draft_oauth(&this.services, cx);
                                }))),
                        ),
                ),
            })
            .when(custom_oauth_actions_visible(draft.transport, draft.preset_id.as_deref(), draft.oauth), |el| el.child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(v_flex().child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Browser authorization")).child(div().text_xs().text_color(theme.muted_foreground).child("Aiden stores tokens encrypted on this device and never contacts userinfo.")))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Button::new("mcp-custom-authorize").small().primary().label(if draft.authorizing { "Waiting for browser…" } else { "Authorize / Reauthorize" }).disabled(busy || !can_save).on_click(cx.listener(|this, _, _, cx| {
                                this.mcp.authorize_draft(&this.services, cx);
                            })))
                            .child(Button::new("mcp-custom-cancel-authorize").small().ghost().label("Cancel").disabled(!draft.authorizing).on_click(cx.listener(|this, _, _, cx| {
                                this.mcp.cancel_authorization(&this.services, cx);
                            })))
                            .child(Button::new("mcp-custom-revoke-oauth").small().danger().label(if draft.revoking { "Signing out…" } else { "Sign out" }).disabled(busy).on_click(cx.listener(|this, _, _, cx| {
                                this.mcp.revoke_draft_oauth(&this.services, cx);
                            }))),
                    ),
            ))
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_xs().text_color(theme.muted_foreground).child(if draft.enabled { "Enabled" } else { "Disabled" }))
                    .child(Switch::new("mcp-editor-enabled").checked(draft.enabled).disabled(busy).on_click(cx.listener(|this, checked, _, cx| {
                        if let Some(draft) = this.mcp.adding.as_mut() {
                            draft.enabled = *checked;
                        }
                        cx.notify();
                    }))),
            )
            .when_some(self.mcp.error.clone(), |el, error| {
                el.child(
                    div()
                        .w_full()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .px_3()
                        .py_2()
                        .text_sm()
                        .text_color(theme.danger)
                        .child(error),
                )
            })
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("cancel-mcp-edit")
                            .small()
                            .ghost()
                            .label("Cancel")
                            .disabled(busy)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.mcp.close_modal(window);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("test-mcp-draft")
                            .small()
                            .label("Save & test")
                            .disabled(
                                !can_save
                                    || draft.saving
                                    || draft.authorizing
                                    || draft.revoking
                                    || draft.transport
                                        == aiden_data::portable_config::McpTransport::Sse,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.mcp.save_and_test_draft(&this.services, cx);
                            })),
                    )
                    .child(
                        h_flex()
                            .when_some(self.mcp.modal_last_focus.clone(), |el, focus| {
                                el.track_focus(&focus).tab_stop(true)
                            })
                            .child(Button::new("save-mcp-server")
                            .small()
                            .primary()
                            .label(if draft.saving { "Saving…" } else { "Save" })
                            .tab_stop(false)
                            .disabled(!can_save || busy || draft.preset_key_removing)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.mcp.save_draft(&this.services, window, cx);
                            }))),
                    ),
            )
    }

    /// Inline delete-confirmation card.
    fn mcp_remove_confirm(&self, removing: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let removing = removing.to_string();
        let label = self
            .mcp
            .servers
            .iter()
            .find(|row| row.id == removing)
            .map(|row| row.name.clone())
            .unwrap_or_else(|| "this server".to_string());
        v_flex()
            .id("mcp-remove-confirm")
            .gap_3()
            .px_4()
            .py_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.danger.opacity(0.5))
            .child(div().text_sm().child(format!(
                "Remove “{label}”? It will be disconnected and removed."
            )))
            .when_some(self.mcp.error.clone(), |el, error| {
                el.child(div().text_sm().text_color(theme.danger).child(error))
            })
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        h_flex()
                            .when_some(self.mcp.modal_first_focus.clone(), |el, focus| {
                                el.track_focus(&focus).tab_stop(true)
                            })
                            .child(
                                Button::new("cancel-mcp-remove")
                                    .small()
                                    .ghost()
                                    .tab_stop(false)
                                    .label("Cancel")
                                    .disabled(self.mcp.removing_busy)
                                    .on_click(cx.listener(|this, _event, window, cx| {
                                        this.mcp.close_modal(window);
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .when_some(self.mcp.modal_last_focus.clone(), |el, focus| {
                                el.track_focus(&focus).tab_stop(true)
                            })
                            .child(
                                Button::new("confirm-mcp-remove")
                                    .small()
                                    .danger()
                                    .tab_stop(false)
                                    .label("Remove")
                                    .disabled(self.mcp.removing_busy)
                                    .on_click(cx.listener(move |this, _event, window, cx| {
                                        this.mcp.confirm_remove(
                                            &removing,
                                            &this.services,
                                            window,
                                            cx,
                                        );
                                    })),
                            ),
                    ),
            )
    }
}

impl McpState {
    fn prepare_modal_focus(&mut self, cx: &mut Context<SettingsView>) {
        self.modal_scope = Some(cx.focus_handle());
        self.modal_first_focus = Some(cx.focus_handle());
        self.modal_last_focus = Some(cx.focus_handle());
        self.error = None;
        self.oauth_revision.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn leave_section(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        self.connection_revision = self.connection_revision.wrapping_add(1);
        self.oauth_revision.fetch_add(1, Ordering::SeqCst);
        if let Some(server_id) = self
            .adding
            .as_ref()
            .filter(|draft| draft.authorizing)
            .map(|draft| draft.id.clone())
        {
            let authority = services.mcp_mutation.clone();
            Tokio::spawn(cx, async move {
                authority.cancel_authorization(&server_id).await
            })
            .detach();
        }
        self.modal = None;
        self.adding = None;
        self.removing = None;
        self.removing_busy = false;
        self.return_focus = None;
        self.modal_scope = None;
        self.modal_first_focus = None;
        self.modal_last_focus = None;
        self.error = None;
        cx.notify();
    }

    fn close_modal(&mut self, window: &mut Window) {
        if self.removing_busy
            || self.adding.as_ref().is_some_and(|draft| {
                draft.saving || draft.authorizing || draft.revoking || draft.preset_key_removing
            })
        {
            return;
        }
        self.connection_revision = self.connection_revision.wrapping_add(1);
        self.oauth_revision.fetch_add(1, Ordering::SeqCst);
        self.modal = None;
        self.adding = None;
        self.removing = None;
        self.modal_scope = None;
        self.modal_first_focus = None;
        self.modal_last_focus = None;
        if let Some(focus) = self.return_focus.take() {
            focus.focus(window);
        }
    }

    fn authorize_draft(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.authorizing || draft.saving || draft.revoking {
            return;
        }
        let record = mcp_server_from_draft(draft, cx);
        if !record.oauth.unwrap_or(false) {
            return;
        }
        draft.authorizing = true;
        self.error = None;
        let services = services.clone();
        let server_id = record.id.clone();
        let revision = self.oauth_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.oauth_revision.clone();
        let task = Tokio::spawn(cx, async move {
            services.mcp_mutation.save(record).await?;
            let opener = |url: &str| {
                let status = std::process::Command::new("/usr/bin/open")
                    .arg(url)
                    .status()
                    .map_err(|_| {
                        aiden_mcp::McpError::OAuthRequest(
                            "the system browser could not be opened".into(),
                        )
                    })?;
                status.success().then_some(()).ok_or_else(|| {
                    aiden_mcp::McpError::OAuthRequest(
                        "the system browser could not be opened".into(),
                    )
                })
            };
            services
                .mcp_mutation
                .authorize(&server_id, &opener, &|| {
                    current.load(Ordering::SeqCst) == revision
                })
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.mcp.oauth_revision.load(Ordering::SeqCst) == revision {
                    if let Some(draft) = this.mcp.adding.as_mut() {
                        draft.authorizing = false;
                    }
                    this.mcp.error = match result {
                        Ok(Ok(())) => None,
                        Ok(Err(error)) => Some(error.to_string()),
                        Err(_) => Some("Authorization was interrupted.".into()),
                    };
                    this.mcp.statuses_loaded = false;
                    this.refresh(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn cancel_authorization(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let Some(server_id) = self.adding.as_ref().map(|draft| draft.id.clone()) else {
            return;
        };
        self.oauth_revision.fetch_add(1, Ordering::SeqCst);
        if let Some(draft) = self.adding.as_mut() {
            draft.authorizing = false;
        }
        let authority = services.mcp_mutation.clone();
        let task = Tokio::spawn(cx, async move {
            authority.cancel_authorization(&server_id).await
        });
        task.detach();
        self.error = Some("Authorization cancelled.".into());
        cx.notify();
    }

    fn revoke_draft_oauth(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving || draft.authorizing || draft.revoking {
            return;
        }
        let server_id = draft.id.clone();
        draft.revoking = true;
        self.error = None;
        let revision = self.oauth_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let authority = services.mcp_mutation.clone();
        let task = Tokio::spawn(cx, async move { authority.revoke_oauth(&server_id).await });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.mcp.oauth_revision.load(Ordering::SeqCst) != revision {
                    return;
                }
                if let Some(draft) = this.mcp.adding.as_mut() {
                    draft.revoking = false;
                }
                this.mcp.error = match result {
                    Ok(Ok(())) => None,
                    _ => Some("The OAuth session could not be removed.".into()),
                };
                this.mcp.statuses_loaded = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn clear_draft_preset_key(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving || draft.authorizing || draft.revoking || draft.preset_key_removing {
            return;
        }
        let server_id = draft.id.clone();
        let revision = self.oauth_revision.fetch_add(1, Ordering::SeqCst) + 1;
        draft.preset_key_removing = true;
        self.error = None;
        let authority = services.mcp_mutation.clone();
        let operation_server_id = server_id.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    authority.set_or_clear_preset_key(&operation_server_id, None)
                })
                .await;
            this.update(cx, |this, cx| {
                let current_server_id = this.mcp.adding.as_ref().map(|draft| draft.id.as_str());
                if !preset_key_removal_is_current(
                    this.mcp.oauth_revision.load(Ordering::SeqCst),
                    revision,
                    current_server_id,
                    &server_id,
                ) {
                    return;
                }
                let Some(draft) = this.mcp.adding.as_mut() else {
                    return;
                };
                draft.preset_key_removing = false;
                this.mcp.error = result
                    .err()
                    .map(|_| "The saved preset key could not be removed.".into());
                this.mcp.statuses_loaded = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_credential_statuses(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        self.status_revision = self.status_revision.wrapping_add(1);
        let revision = self.status_revision;
        let services = services.clone();
        let servers = self.servers.clone();
        cx.spawn(async move |this, cx| {
            let badges = cx
                .background_spawn(async move {
                    aiden_mcp::MCP_PRESETS
                        .iter()
                        .map(|preset| {
                            let server = servers
                                .iter()
                                .find(|row| row.preset_id.as_deref() == Some(preset.id));
                            let label = match server {
                                Some(server) if !server.enabled => "Disabled",
                                Some(server) => match preset.auth {
                                    aiden_mcp::McpPresetAuth::ApiKey { .. } => services
                                        .mcp_mutation
                                        .bound_preset_key(&server.record)
                                        .ok()
                                        .flatten()
                                        .map(|_| "Ready")
                                        .unwrap_or("Needs key"),
                                    aiden_mcp::McpPresetAuth::OAuth => services
                                        .mcp_mutation
                                        .oauth_status(&server.record)
                                        .ok()
                                        .filter(|status| {
                                            *status == aiden_mcp::oauth::McpOAuthStatus::Ready
                                        })
                                        .map(|_| "Ready")
                                        .unwrap_or("Needs sign-in"),
                                },
                                None => match preset.auth {
                                    aiden_mcp::McpPresetAuth::ApiKey { .. } => "Needs key",
                                    aiden_mcp::McpPresetAuth::OAuth => "Needs sign-in",
                                },
                            };
                            (preset.id.to_string(), label.to_string())
                        })
                        .collect::<BTreeMap<_, _>>()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.mcp.status_revision == revision {
                    this.mcp.preset_badges = badges;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn reset_connections(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        self.connection_revision = self.connection_revision.wrapping_add(1);
        let revision = self.connection_revision;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(async move {
                    debug_assert!(std::sync::Arc::ptr_eq(
                        &services.mcp,
                        services.mcp_mutation.manager(),
                    ));
                    services.mcp_mutation.reset_connections().await;
                    true
                })
                .await;
            this.update(cx, |this, cx| {
                if !connection_result_is_current(this.mcp.connection_revision, revision) {
                    return;
                }
                this.mcp.statuses.clear();
                this.mcp.testing = None;
                this.mcp.error = (!ok).then_some("Connections could not be reset.".to_string());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Open the add-stdio-server form.
    fn open_draft(&mut self, window: &mut Window, cx: &mut Context<SettingsView>) {
        self.open_record(
            McpServer {
                id: format!("mcp-{:x}", aiden_data::now_millis()),
                name: String::new(),
                transport: aiden_data::portable_config::McpTransport::Stdio,
                command: None,
                args: Some(Vec::new()),
                env: None,
                url: None,
                headers: None,
                oauth: None,
                preset_id: None,
                enabled: true,
            },
            false,
            McpModal::CustomEditor,
            window,
            cx,
        );
    }

    fn open_edit(
        &mut self,
        record: McpServer,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        let modal = record
            .preset_id
            .as_deref()
            .and_then(aiden_mcp::get_mcp_preset)
            .map(|preset| McpModal::PresetSetup(preset.id))
            .unwrap_or(McpModal::CustomEditor);
        self.open_record(record, true, modal, window, cx);
    }

    fn open_preset(
        &mut self,
        preset_id: &'static str,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        let Some(preset) = aiden_mcp::get_mcp_preset(preset_id) else {
            return;
        };
        let existing = self
            .servers
            .iter()
            .find(|row| row.preset_id.as_deref() == Some(preset_id))
            .map(|row| row.record.clone());
        let editing = existing.is_some();
        let record = existing.or_else(|| aiden_mcp::server_from_preset(preset, None).ok());
        if let Some(record) = record {
            self.open_record(
                record,
                editing,
                McpModal::PresetSetup(preset.id),
                window,
                cx,
            );
        }
    }

    fn open_record(
        &mut self,
        record: McpServer,
        editing: bool,
        modal: McpModal,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        self.return_focus = window.focused(cx);
        self.prepare_modal_focus(cx);
        let make_input = |cx: &mut Context<SettingsView>,
                          window: &mut Window,
                          placeholder: &str,
                          value: String| {
            let placeholder = placeholder.to_string();
            cx.new(move |cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value)
            })
        };
        let make_multiline_input = |cx: &mut Context<SettingsView>,
                                    window: &mut Window,
                                    placeholder: &str,
                                    value: String| {
            let placeholder = placeholder.to_string();
            cx.new(move |cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value)
                    .auto_grow(MCP_EDITOR_TEXTAREA_MIN_ROWS, MCP_EDITOR_TEXTAREA_MAX_ROWS)
            })
        };
        let name = make_input(cx, window, "My MCP server", record.name.clone());
        let command = make_input(
            cx,
            window,
            "npx",
            record.command.clone().unwrap_or_default(),
        );
        let args = make_input(
            cx,
            window,
            "-y @modelcontextprotocol/server-filesystem /path",
            record.args.clone().unwrap_or_default().join(" "),
        );
        let env = make_multiline_input(
            cx,
            window,
            "API_KEY=...",
            format_env_lines(&record.env.clone().unwrap_or_default()),
        );
        let url = make_input(
            cx,
            window,
            "https://example.com/mcp",
            record.url.clone().unwrap_or_default(),
        );
        let headers = make_multiline_input(
            cx,
            window,
            "Authorization=Bearer ...",
            format_env_lines(&record.headers.clone().unwrap_or_default()),
        );
        let preset_key = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste API key")
                .masked(true)
        });
        for input in [
            name.clone(),
            command.clone(),
            args.clone(),
            env.clone(),
            url.clone(),
            headers.clone(),
            preset_key.clone(),
        ] {
            let subscription =
                cx.subscribe_in(&input, window, |_this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                });
            self._subscriptions.push(subscription);
        }
        let transport_items = vec![
            TransportItem {
                value: aiden_data::portable_config::McpTransport::Stdio,
                label: "Local command (stdio)",
            },
            TransportItem {
                value: aiden_data::portable_config::McpTransport::Http,
                label: "Remote URL (HTTP)",
            },
            TransportItem {
                value: aiden_data::portable_config::McpTransport::Sse,
                label: "Remote URL (legacy SSE)",
            },
        ];
        let selected = transport_items
            .iter()
            .position(|item| item.value == record.transport)
            .map(|row| gpui_component::IndexPath::default().row(row));
        let transport_select = cx.new(|cx| SelectState::new(transport_items, selected, window, cx));
        self._subscriptions.push(cx.subscribe_in(
            &transport_select,
            window,
            |this, _state, event, _window, cx| {
                let SelectEvent::Confirm(Some(transport)) = event else {
                    return;
                };
                if let Some(draft) = this.mcp.adding.as_mut() {
                    if *transport != aiden_data::portable_config::McpTransport::Sse {
                        draft.transport = *transport;
                        if *transport == aiden_data::portable_config::McpTransport::Stdio {
                            draft.oauth = false;
                        }
                    }
                }
                cx.notify();
            },
        ));
        let autofocus = name.clone();
        self.adding = Some(McpDraft {
            id: record.id,
            name,
            transport: record.transport,
            transport_select,
            command,
            args,
            env,
            url,
            headers,
            preset_key,
            oauth: record.oauth.unwrap_or(false),
            enabled: record.enabled,
            preset_id: record.preset_id,
            editing,
            saving: false,
            authorizing: false,
            revoking: false,
            preset_key_removing: false,
        });
        self.modal = Some(modal);
        autofocus.update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    /// Toggle a server's enabled state through the portable config.
    fn toggle_server(
        &mut self,
        server_id: &str,
        enabled: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let server_id = server_id.to_string();
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(async move {
                    services
                        .mcp_mutation
                        .toggle(&server_id, enabled)
                        .await
                        .is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.mcp.error = if ok {
                    None
                } else {
                    Some("The server could not be updated.".to_string())
                };
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn save_and_test_draft(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving || draft.authorizing || draft.revoking {
            return;
        }
        let record = mcp_server_from_draft(draft, cx);
        let server_id = record.id.clone();
        let preset_key = draft.preset_key.read(cx).value().trim().to_string();
        draft.saving = true;
        self.testing = Some(server_id.clone());
        self.connection_revision = self.connection_revision.wrapping_add(1);
        let revision = self.connection_revision;
        let services = services.clone();
        let task = Tokio::spawn(cx, async move {
            let saved = services.mcp_mutation.save(record).await?;
            if saved.preset_id.is_some() && !preset_key.is_empty() {
                services
                    .mcp_mutation
                    .set_or_clear_preset_key(&saved.id, Some(&preset_key))?;
            }
            Ok::<_, crate::services::mcp_mutation::McpMutationError>(
                services.mcp_mutation.status(&saved).await,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if !connection_result_is_current(this.mcp.connection_revision, revision) {
                    return;
                }
                if let Some(draft) = this.mcp.adding.as_mut() {
                    draft.saving = false;
                    draft.editing = true;
                }
                this.mcp.testing = None;
                match result {
                    Ok(Ok(status)) => {
                        this.mcp.statuses.insert(
                            server_id,
                            McpTestStatus {
                                connected: status.connected,
                                tool_count: status.tool_count,
                                error: status.error,
                            },
                        );
                        this.mcp.error = None;
                    }
                    _ => {
                        this.mcp.error =
                            Some("The MCP server could not be saved and tested.".into())
                    }
                }
                this.mcp.statuses_loaded = false;
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Persist the add form as a new stdio server.
    fn save_draft(
        &mut self,
        services: &SettingsServices,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving || draft.authorizing || draft.revoking {
            return;
        }
        let name = draft.name.read(cx).value().to_string();
        let command = draft.command.read(cx).value().to_string();
        let args = parse_args_text(&draft.args.read(cx).value());
        let env = parse_env_lines(&draft.env.read(cx).value());
        let url = draft.url.read(cx).value().to_string();
        let headers = parse_env_lines(&draft.headers.read(cx).value());
        let preset_key = draft.preset_key.read(cx).value().to_string();
        let transport = draft.transport;
        let id = draft.id.clone();
        let oauth = draft.oauth;
        let enabled = draft.enabled;
        let preset_id = draft.preset_id.clone();
        draft.saving = true;
        self.connection_revision = self.connection_revision.wrapping_add(1);
        let revision = self.connection_revision;
        let services = services.clone();
        let record = McpServer {
            id: id.clone(),
            name: name.trim().to_string(),
            transport,
            command: (transport == aiden_data::portable_config::McpTransport::Stdio)
                .then(|| command.trim().to_string())
                .filter(|command| !command.is_empty()),
            args: (transport == aiden_data::portable_config::McpTransport::Stdio).then_some(args),
            env: (transport == aiden_data::portable_config::McpTransport::Stdio).then_some(env),
            url: (transport != aiden_data::portable_config::McpTransport::Stdio)
                .then(|| url.trim().to_string())
                .filter(|url| !url.is_empty()),
            headers: (transport != aiden_data::portable_config::McpTransport::Stdio)
                .then_some(headers),
            oauth: (transport != aiden_data::portable_config::McpTransport::Stdio && oauth)
                .then_some(true),
            preset_id,
            enabled,
        };
        cx.spawn_in(window, async move |this, cx| {
            let preset_slot = record.preset_id.is_some().then_some(id);
            let ok = cx
                .background_spawn(async move {
                    services.mcp_mutation.save(record).await?;
                    if let Some(server_id) = preset_slot {
                        if !preset_key.trim().is_empty() {
                            services
                                .mcp_mutation
                                .set_or_clear_preset_key(&server_id, Some(preset_key.trim()))?;
                        }
                    }
                    Ok::<_, crate::services::mcp_mutation::McpMutationError>(())
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if !connection_result_is_current(this.mcp.connection_revision, revision) {
                    return;
                }
                if ok.is_ok() {
                    this.mcp.adding = None;
                    this.mcp.modal = None;
                    if let Some(focus) = this.mcp.return_focus.take() {
                        focus.focus(window);
                    }
                } else if let Some(draft) = this.mcp.adding.as_mut() {
                    draft.saving = false;
                }
                this.mcp.error = if ok.is_ok() {
                    None
                } else {
                    Some("The MCP server could not be saved.".to_string())
                };
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Remove a configured server.
    fn confirm_remove(
        &mut self,
        server_id: &str,
        services: &SettingsServices,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        if self.removing_busy {
            return;
        }
        self.connection_revision = self.connection_revision.wrapping_add(1);
        let revision = self.connection_revision;
        self.removing_busy = true;
        let services = services.clone();
        let server_id = server_id.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let ok = cx
                .background_spawn(
                    async move { services.mcp_mutation.remove(&server_id).await.is_ok() },
                )
                .await;
            this.update_in(cx, |this, window, cx| {
                if !connection_result_is_current(this.mcp.connection_revision, revision) {
                    return;
                }
                this.mcp.removing_busy = false;
                if ok {
                    this.mcp.removing = None;
                    this.mcp.modal = None;
                    if let Some(focus) = this.mcp.return_focus.take() {
                        focus.focus(window);
                    }
                }
                this.mcp.error = if ok {
                    None
                } else {
                    Some("The MCP server could not be removed.".to_string())
                };
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Test-connect a server through the MCP client manager (async on the
    /// tokio bridge; the spinner shows while pending).
    fn test_server(
        &mut self,
        server_id: &str,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let server_id = server_id.to_string();
        let servers = self.servers.clone();
        let Some(row) = servers.iter().find(|row| row.id == server_id) else {
            return;
        };
        let record = mcp_server_from_row(row, row.enabled);
        self.connection_revision = self.connection_revision.wrapping_add(1);
        let revision = self.connection_revision;
        self.testing = Some(server_id.clone());
        self.statuses.remove(&server_id);

        let task = Tokio::spawn(
            cx,
            async move { services.mcp_mutation.status(&record).await },
        );
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let status = match result {
                Ok(status) => status,
                Err(_) => aiden_mcp::McpStatus {
                    connected: false,
                    tool_count: 0,
                    tools: Vec::new(),
                    error: Some("The connection attempt was interrupted.".to_string()),
                },
            };
            this.update(cx, |this, cx| {
                if !connection_result_is_current(this.mcp.connection_revision, revision) {
                    return;
                }
                this.mcp.testing = None;
                this.mcp.statuses.insert(
                    server_id.clone(),
                    McpTestStatus {
                        connected: status.connected,
                        tool_count: status.tool_count,
                        error: status.error.clone(),
                    },
                );
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// Rebuild a portable `McpServer` record from a row. The stored record is the
/// source of truth; only the enabled flag is patched (used for toggles/tests).
fn mcp_server_from_draft(draft: &McpDraft, cx: &gpui::App) -> McpServer {
    let transport = draft.transport;
    let stdio = transport == aiden_data::portable_config::McpTransport::Stdio;
    McpServer {
        id: draft.id.clone(),
        name: draft.name.read(cx).value().trim().to_string(),
        transport,
        command: stdio
            .then(|| draft.command.read(cx).value().trim().to_string())
            .filter(|value| !value.is_empty()),
        args: stdio.then(|| parse_args_text(&draft.args.read(cx).value())),
        env: stdio.then(|| parse_env_lines(&draft.env.read(cx).value())),
        url: (!stdio)
            .then(|| draft.url.read(cx).value().trim().to_string())
            .filter(|value| !value.is_empty()),
        headers: (!stdio).then(|| parse_env_lines(&draft.headers.read(cx).value())),
        oauth: (!stdio && draft.oauth).then_some(true),
        preset_id: draft.preset_id.clone(),
        enabled: draft.enabled,
    }
}

fn mcp_server_from_row(row: &McpServerRow, enabled: bool) -> McpServer {
    let mut record = row.record.clone();
    record.enabled = enabled;
    record
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    use aiden_computer_use::foundation_models::FoundationModelsConnection;
    use aiden_core::appearance::create_default_appearance_config;
    use aiden_data::chat_store::{create_chat_store, ChatStoreDurability};
    use aiden_data::config_store::ConfigStore;
    use aiden_data::pi_credential_store::{
        EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions,
    };
    use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
    use aiden_data::schedule_store::{create_schedule_store, DataStorePersistence};
    use aiden_data::secret_map::{ProviderKeysStore, SecretCipher, SecretCipherError};
    use aiden_data::usage_store::UsageStore;
    use aiden_mac::hotkey::ShortcutRegistrationPort;
    use gpui::TestAppContext;

    use crate::services::chat_service::ChatService;
    use crate::services::codex_auth::PiCodexAuthStore;
    use crate::services::mcp_mutation::McpMutationAuthority;
    use crate::services::native_appearance::{NativeAppearance, PreparedNativeAppearance};
    use crate::services::stores::{StoreSecretsPort, Stores};
    use crate::shortcut_runtime::ShortcutRuntime;

    #[derive(Default)]
    struct MemoryCipher {
        vault: std::sync::Mutex<HashMap<String, String>>,
    }

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.vault
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(format!("encrypted:{value}").into_bytes())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            let value = String::from_utf8_lossy(value);
            let Some(plaintext) = value.strip_prefix("encrypted:") else {
                return Err(SecretCipherError::NeedsRotation);
            };
            match self.vault.lock().unwrap().get(account) {
                Some(stored) if stored == plaintext => Ok(plaintext.to_string()),
                _ => Err(SecretCipherError::UnrecognizedFormat),
            }
        }
    }

    struct NoopShortcutPort;

    impl ShortcutRegistrationPort for NoopShortcutPort {
        fn register(&self, _accelerator: &str) -> bool {
            true
        }

        fn unregister(&self, _accelerator: &str) {}
    }

    fn test_stores(portable: &tempfile::TempDir, local: &tempfile::TempDir) -> Stores {
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().to_path_buf(),
            "aiden-settings-mcp-test",
            cipher.clone(),
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                portable.path().to_path_buf(),
                Some(local.path().to_path_buf()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(StoreSecretsPort::new(keys.clone())),
            None,
        ));
        let credentials = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: local.path().join("pi-provider-credentials.json"),
                cipher,
                sync_directory: None,
                on_durability_warning: None,
                before_document_write: None,
            },
        ));
        let codex_auth = Arc::new(PiCodexAuthStore::new(credentials.clone()));
        let pi_providers =
            crate::services::pi_provider_setup::PiProviderSetupAuthority::new(credentials);
        let foundation_models = Arc::new(FoundationModelsConnection::new(
            "linux",
            "x86_64",
            "0",
            Arc::new(|| 0),
            Arc::new(|_, _| Box::pin(async { unreachable!("platform gate") })),
        ));
        let schedules = Arc::new(create_schedule_store(
            DataStorePersistence::new("schedules.json", Some(local.path().to_path_buf())),
            DataStorePersistence::new("schedule-runs.json", Some(local.path().to_path_buf())),
            Box::new(aiden_data::now_millis),
            None,
        ));
        let mcp = Arc::new(aiden_mcp::McpClientManager::new());
        let mcp_mutation = Arc::new(McpMutationAuthority::new(
            config.clone(),
            keys.clone(),
            mcp.clone(),
        ));
        let chats_path = local.path().join("chats");
        let (config_changed, _) = tokio::sync::watch::channel(0);
        let chat = Arc::new(create_chat_store(
            Box::new(move || chats_path.clone()),
            None,
            ChatStoreDurability::default(),
        ));
        let computer_use = crate::services::computer_use::ComputerUseAuthority::new(
            config.clone(),
            chat.clone(),
            crate::services::computer_use::production_status_dependencies(config.clone()),
        );
        let usage = Arc::new(UsageStore::new_data_store(Some(local.path().to_path_buf())));
        let voice = crate::services::voice::VoiceAuthority::new(
            config.clone(),
            pi_providers.clone(),
            usage.clone(),
        );
        voice.reconcile_boot().unwrap();
        let scheduler_executor =
            crate::services::scheduled_execution::ProductionScheduledExecutor::new(
                config.clone(),
                schedules.clone(),
                chat.clone(),
                usage.clone(),
                codex_auth.clone(),
                mcp.clone(),
                mcp_mutation.clone(),
            );
        let scheduler = aiden_scheduler::runtime::SchedulerCore::new(
            schedules.clone(),
            scheduler_executor.clone(),
            None,
            Box::new(aiden_data::now_millis),
            Box::new(|| Box::pin(async { false })),
            Box::new(|_| {}),
            Box::new(|_| {}),
            aiden_scheduler::runtime::SchedulerConfig::default(),
        );
        let subagents = crate::services::subagents::SubagentAuthority::new(None);
        Stores {
            chat,
            config,
            appearance_intent_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            keys,
            codex_auth,
            pi_providers,
            foundation_models,
            computer_use,
            voice,
            schedules,
            usage,
            mcp,
            mcp_mutation,
            scheduler,
            scheduler_executor,
            quit_barrier: Arc::new(aiden_mac::quit_barrier::QuitBarrier::new()),
            config_watcher: None,
            config_changed: Arc::new(config_changed),
            runs: None,
            subagents,
            app_updates: crate::services::app_updates::AppUpdateAuthority::new(Arc::new(
                aiden_mac::updater::NoopUpdateProvider,
            )),
        }
    }

    fn test_settings_view(
        services: SettingsServices,
        cx: &mut Context<SettingsView>,
    ) -> SettingsView {
        let shortcuts = crate::settings::shortcuts::ShortcutsState::default();
        let recorder_drop_guard = crate::settings::shortcuts::RecorderDropGuard::new(
            services.shortcuts.clone(),
            shortcuts.owner_signal(),
            cx.to_async(),
        );
        SettingsView {
            services,
            // These tests drive MCP state directly; keep gpui-component Inputs
            // out of the painted tree because the lightweight test window is
            // not wrapped in the production `Root`.
            active: crate::settings::SettingsSection::About,
            booted: true,
            error: None,
            _subscriptions: Vec::new(),
            _recorder_drop_guard: recorder_drop_guard,
            providers: crate::settings::providers::ProvidersState::default(),
            model_data: crate::settings::model_data::ModelDataState::default(),
            model_pad: crate::settings::model_pad::ModelPadState::default(),
            assistant: crate::settings::assistant::AssistantState::default(),
            web_search: crate::settings::web_search::WebSearchState::default(),
            voice: crate::settings::voice::VoiceState::default(),
            computer_use: crate::settings::computer_use::ComputerUseState::default(),
            appearance: crate::settings::appearance::AppearanceState::default(),
            shortcuts,
            mcp: McpState::default(),
            scheduled: crate::settings::scheduled::ScheduledState::default(),
            skills: crate::settings::skills::SkillsState::new(cx, None),
        }
    }

    #[test]
    fn parses_key_value_env_lines() {
        let parsed = parse_env_lines("API_KEY=secret\nFOO = bar\n\n=ignored\nbaz");
        assert_eq!(parsed.get("API_KEY").map(String::as_str), Some("secret"));
        assert_eq!(parsed.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(parsed.len(), 2);
        assert!(parse_env_lines("").is_empty());
    }

    #[test]
    fn env_lines_roundtrip_through_format() {
        let record = BTreeMap::from([
            ("API_KEY".to_string(), "s3cr3t".to_string()),
            ("BASE".to_string(), "http://localhost".to_string()),
            ("AUTH".to_string(), "Bearer token=with=equals".to_string()),
        ]);
        let lines = format_env_lines(&record);
        assert_eq!(parse_env_lines(&lines), record);
    }

    #[test]
    fn mcp_editor_uses_bounded_multiline_textareas_for_env_and_headers() {
        let source = include_str!("mcp.rs");
        assert!(source.contains("let make_multiline_input"));
        assert!(source.contains("let env = make_multiline_input("));
        assert!(source.contains("let headers = make_multiline_input("));
        assert!(source
            .contains(".auto_grow(MCP_EDITOR_TEXTAREA_MIN_ROWS, MCP_EDITOR_TEXTAREA_MAX_ROWS)"));
        assert!(source.contains("Environment · one KEY=VALUE per line"));
        assert!(source.contains("Headers · one KEY=VALUE per line"));
        assert!(source.contains(".disabled(busy)"));
    }

    #[test]
    fn parses_space_separated_args() {
        assert_eq!(
            parse_args_text("  -y   @modelcontextprotocol/server-filesystem /tmp  "),
            vec!["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
        );
        assert_eq!(parse_args_text("  "), Vec::<String>::new());
    }

    #[test]
    fn gallery_geometry_compacts_at_the_exact_breakpoint() {
        assert_eq!(mcp_gallery_columns(879.0), 1);
        assert_eq!(mcp_gallery_columns(880.0), 2);
        assert_eq!(mcp_gallery_columns(1440.0), 2);
    }

    #[test]
    fn stale_connection_status_cannot_publish_after_a_newer_edit() {
        assert!(connection_result_is_current(7, 7));
        assert!(!connection_result_is_current(8, 7));
    }

    #[test]
    fn preset_key_removal_is_fenced_to_revision_and_server() {
        assert!(preset_key_removal_is_current(
            4,
            4,
            Some("preset-server"),
            "preset-server"
        ));
        assert!(!preset_key_removal_is_current(
            5,
            4,
            Some("preset-server"),
            "preset-server"
        ));
        assert!(!preset_key_removal_is_current(
            4,
            4,
            Some("reopened-server"),
            "preset-server"
        ));
        let source = include_str!("mcp.rs");
        assert!(source.contains("preset_key_removing"));
        assert!(source.contains("oauth_revision.fetch_add(1, Ordering::SeqCst) + 1"));
        assert!(
            source.contains("connection_result_is_current(this.mcp.connection_revision, revision)")
        );
    }

    #[gpui::test]
    fn manual_http_draft_roundtrips_and_transport_switch_clears_irrelevant_fields(
        cx: &mut TestAppContext,
    ) {
        cx.update(gpui_component::init);
        cx.update(gpui_tokio_bridge::init);
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = test_stores(&portable, &local);
        let config = stores.config.clone();
        let shortcuts =
            cx.new(|cx| ShortcutRuntime::new(config.clone(), Arc::new(NoopShortcutPort), cx));
        let appearance_service = {
            let stores = stores.clone();
            cx.new(|cx| {
                ChatService::new(
                    stores,
                    create_default_appearance_config(),
                    PreparedNativeAppearance {
                        native: NativeAppearance::new(),
                        restored: None,
                    },
                    cx,
                )
            })
        };
        let services = SettingsServices::from_stores(&stores, shortcuts, appearance_service);
        let (view, cx) = cx.add_window_view(move |_window, cx| test_settings_view(services, cx));
        let remote = McpServer {
            id: "manual-http".into(),
            name: "Remote".into(),
            transport: aiden_data::portable_config::McpTransport::Http,
            command: Some("must-clear".into()),
            args: Some(vec!["must-clear".into()]),
            env: Some(BTreeMap::from([("OLD".into(), "must-clear".into())])),
            url: Some("https://mcp.example.test/mcp".into()),
            headers: Some(BTreeMap::from([("X-Tenant".into(), "one".into())])),
            oauth: Some(true),
            preset_id: None,
            enabled: true,
        };

        cx.update(|window, app| {
            view.update(app, |this, cx| {
                this.mcp
                    .open_record(remote, true, McpModal::CustomEditor, window, cx);
                let draft = this.mcp.adding.as_ref().unwrap();
                let env = draft.env.clone();
                let headers = draft.headers.clone();
                env.update(cx, |input, cx| {
                    input.set_value("TOKEN=secret=with=equals\nSECOND=two", window, cx);
                });
                headers.update(cx, |input, cx| {
                    input.set_value("Authorization=Bearer token\nX-Trace=one=two", window, cx);
                });
                let rebuilt = mcp_server_from_draft(draft, cx);
                assert_eq!(rebuilt.url.as_deref(), Some("https://mcp.example.test/mcp"));
                assert_eq!(
                    rebuilt
                        .headers
                        .as_ref()
                        .unwrap()
                        .get("Authorization")
                        .map(String::as_str),
                    Some("Bearer token")
                );
                assert_eq!(
                    rebuilt
                        .headers
                        .as_ref()
                        .unwrap()
                        .get("X-Trace")
                        .map(String::as_str),
                    Some("one=two")
                );
                assert_eq!(rebuilt.oauth, Some(true));
                assert!(rebuilt.command.is_none());
                assert!(rebuilt.args.is_none());
                assert!(rebuilt.env.is_none());

                let draft = this.mcp.adding.as_mut().unwrap();
                draft.transport = aiden_data::portable_config::McpTransport::Stdio;
                draft.oauth = false;
                let rebuilt = mcp_server_from_draft(draft, cx);
                assert!(rebuilt.url.is_none());
                assert!(rebuilt.headers.is_none());
                assert!(rebuilt.oauth.is_none());
                assert_eq!(rebuilt.command.as_deref(), Some("must-clear"));
                assert_eq!(
                    rebuilt
                        .env
                        .as_ref()
                        .unwrap()
                        .get("TOKEN")
                        .map(String::as_str),
                    Some("secret=with=equals")
                );
                assert_eq!(
                    rebuilt
                        .env
                        .as_ref()
                        .unwrap()
                        .get("SECOND")
                        .map(String::as_str),
                    Some("two")
                );
            });
        });
    }

    #[test]
    fn stdio_row_rebuilds_a_portable_record() {
        let record = McpServer {
            id: "mcp-1".into(),
            name: "Files".into(),
            transport: aiden_data::portable_config::McpTransport::Stdio,
            command: Some("npx".into()),
            args: Some(vec!["-y".into()]),
            env: Some(BTreeMap::from([("K".into(), "V".into())])),
            url: None,
            headers: None,
            oauth: Some(true),
            preset_id: None,
            enabled: true,
        };
        let row = McpServerRow::from(&record);
        let rebuilt = mcp_server_from_row(&row, false);
        assert_eq!(rebuilt.id, "mcp-1");
        assert_eq!(rebuilt.command.as_deref(), Some("npx"));
        assert_eq!(rebuilt.args, Some(vec!["-y".to_string()]));
        assert_eq!(
            rebuilt.env.as_ref().unwrap().get("K").map(String::as_str),
            Some("V")
        );
        // Only the enabled flag changes; the rest of the stored record
        // (including fields not surfaced in the row UI) survives.
        assert!(!rebuilt.enabled);
        assert_eq!(rebuilt.oauth, Some(true));
        assert_eq!(rebuilt.headers, None);
    }

    #[gpui::test]
    fn failed_add_keeps_inputs_and_real_async_retry_succeeds(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(gpui_tokio_bridge::init);
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = test_stores(&portable, &local);
        let config = stores.config.clone();
        let shortcuts =
            cx.new(|cx| ShortcutRuntime::new(config.clone(), Arc::new(NoopShortcutPort), cx));
        let appearance_service = {
            let stores = stores.clone();
            cx.new(|cx| {
                ChatService::new(
                    stores,
                    create_default_appearance_config(),
                    PreparedNativeAppearance {
                        native: NativeAppearance::new(),
                        restored: None,
                    },
                    cx,
                )
            })
        };
        let services = SettingsServices::from_stores(&stores, shortcuts, appearance_service);
        let (view, cx) = cx.add_window_view(move |_window, cx| test_settings_view(services, cx));

        cx.update(|window, app| {
            view.update(app, |this, cx| {
                this.mcp.open_draft(window, cx);
                let draft = this.mcp.adding.as_ref().unwrap();
                let name = draft.name.clone();
                let command = draft.command.clone();
                let args = draft.args.clone();
                let env = draft.env.clone();
                name.update(cx, |input, cx| input.set_value("n".repeat(257), window, cx));
                command.update(cx, |input, cx| input.set_value("npx", window, cx));
                args.update(cx, |input, cx| input.set_value("-y package", window, cx));
                env.update(cx, |input, cx| input.set_value("TOKEN=value", window, cx));
                let services = this.services.clone();
                this.mcp.save_draft(&services, window, cx);
                assert!(this.mcp.adding.as_ref().unwrap().saving);
            });
        });
        cx.run_until_parked();

        cx.read(|app| {
            let this = view.read(app);
            let draft = this.mcp.adding.as_ref().expect("failed draft remains open");
            assert!(!draft.saving);
            assert_eq!(
                this.mcp.error.as_deref(),
                Some("The MCP server could not be saved.")
            );
            assert_eq!(draft.name.read(app).value().len(), 257);
            assert_eq!(draft.command.read(app).value(), "npx");
            assert_eq!(draft.args.read(app).value(), "-y package");
            assert_eq!(draft.env.read(app).value(), "TOKEN=value");
        });

        cx.update(|window, app| {
            view.update(app, |this, cx| {
                let name = this.mcp.adding.as_ref().unwrap().name.clone();
                name.update(cx, |input, cx| input.set_value("Retry server", window, cx));
                let services = this.services.clone();
                this.mcp.save_draft(&services, window, cx);
            });
        });
        cx.run_until_parked();
        cx.read(|app| {
            let this = view.read(app);
            assert!(this.mcp.adding.is_none());
            assert!(this.mcp.error.is_none());
        });
        let saved = stores.config.list_mcp_servers().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Retry server");
        assert_eq!(saved[0].command.as_deref(), Some("npx"));
        assert_eq!(
            saved[0].args.as_deref(),
            Some(&["-y".into(), "package".into()][..])
        );
        assert_eq!(
            saved[0]
                .env
                .as_ref()
                .unwrap()
                .get("TOKEN")
                .map(String::as_str),
            Some("value")
        );
    }

    #[gpui::test]
    fn modal_restores_focus_and_busy_oauth_blocks_concurrent_save(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(gpui_tokio_bridge::init);
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = test_stores(&portable, &local);
        let config = stores.config.clone();
        let shortcuts =
            cx.new(|cx| ShortcutRuntime::new(config.clone(), Arc::new(NoopShortcutPort), cx));
        let appearance_service = {
            let stores = stores.clone();
            cx.new(|cx| {
                ChatService::new(
                    stores,
                    create_default_appearance_config(),
                    PreparedNativeAppearance {
                        native: NativeAppearance::new(),
                        restored: None,
                    },
                    cx,
                )
            })
        };
        let services = SettingsServices::from_stores(&stores, shortcuts, appearance_service);
        let (view, cx) = cx.add_window_view(move |_window, cx| test_settings_view(services, cx));
        cx.update(|window, app| {
            view.update(app, |this, cx| {
                let focus = cx.focus_handle();
                focus.focus(window);
                this.mcp.open_draft(window, cx);
                assert_eq!(
                    window.focused(cx),
                    Some(
                        this.mcp
                            .adding
                            .as_ref()
                            .unwrap()
                            .name
                            .read(cx)
                            .focus_handle(cx)
                    )
                );
                this.mcp.adding.as_mut().unwrap().authorizing = true;
                let services = this.services.clone();
                this.mcp.save_draft(&services, window, cx);
                assert!(!this.mcp.adding.as_ref().unwrap().saving);
                this.mcp.adding.as_mut().unwrap().authorizing = false;
                this.mcp.close_modal(window);
                assert_eq!(window.focused(cx), Some(focus));
            });
        });

        cx.read(|app| {
            assert!(stores.config.list_mcp_servers().unwrap().is_empty());
            assert!(view.read(app).mcp.modal.is_none());
        });
    }

    #[gpui::test]
    fn configured_sse_test_enters_the_shared_runtime_status_path(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(gpui_tokio_bridge::init);
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = test_stores(&portable, &local);
        let config = stores.config.clone();
        let shortcuts =
            cx.new(|cx| ShortcutRuntime::new(config.clone(), Arc::new(NoopShortcutPort), cx));
        let appearance_service = {
            let stores = stores.clone();
            cx.new(|cx| {
                ChatService::new(
                    stores,
                    create_default_appearance_config(),
                    PreparedNativeAppearance {
                        native: NativeAppearance::new(),
                        restored: None,
                    },
                    cx,
                )
            })
        };
        let services = SettingsServices::from_stores(&stores, shortcuts, appearance_service);
        let (view, cx) = cx.add_window_view(move |_window, cx| test_settings_view(services, cx));

        cx.update(|_window, app| {
            view.update(app, |this, cx| {
                let server = McpServer {
                    id: "legacy-sse".into(),
                    name: "Legacy SSE".into(),
                    transport: aiden_data::portable_config::McpTransport::Sse,
                    command: None,
                    args: None,
                    env: None,
                    url: Some("https://mcp.example.test/sse".into()),
                    headers: None,
                    oauth: None,
                    preset_id: None,
                    enabled: true,
                };
                this.mcp.servers = vec![McpServerRow::from(&server)];
                let services = this.services.clone();
                this.mcp.test_server("legacy-sse", &services, cx);
                assert_eq!(this.mcp.testing.as_deref(), Some("legacy-sse"));
                assert!(this.mcp.error.is_none());
            });
        });
    }

    #[test]
    fn custom_http_oauth_draft_exposes_explicit_authorization_path() {
        assert!(custom_oauth_actions_visible(
            aiden_data::portable_config::McpTransport::Http,
            None,
            true
        ));
        assert!(!custom_oauth_actions_visible(
            aiden_data::portable_config::McpTransport::Stdio,
            None,
            true
        ));
    }
}
