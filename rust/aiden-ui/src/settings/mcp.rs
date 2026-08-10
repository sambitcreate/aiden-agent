//! MCP servers settings (port of `mcp-settings.tsx`).
//!
//! Lists the configured servers from the portable config, toggles each
//! server's enabled state, adds stdio servers (command/args/env), removes
//! them, and tests connections through `aiden_mcp::client::McpClientManager`
//! (async, run on the tokio bridge with a spinner while pending). OAuth
//! servers render a placeholder badge; the interactive OAuth flow is out of
//! scope for this pass.

use std::collections::BTreeMap;

use aiden_data::portable_config::McpServer;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
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

/// Inline add-server draft (input entities created when the form opens).
pub struct McpDraft {
    pub name: Entity<InputState>,
    pub command: Entity<InputState>,
    pub args: Entity<InputState>,
    pub env: Entity<InputState>,
    pub saving: bool,
}

#[derive(Default)]
pub struct McpState {
    pub servers: Vec<McpServerRow>,
    pub adding: Option<McpDraft>,
    pub removing: Option<String>,
    pub testing: Option<String>,
    pub statuses: BTreeMap<String, McpTestStatus>,
    pub error: Option<String>,
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

/// Parse space-separated command arguments (the TS `args.split(/\s+/)`).
pub fn parse_args_text(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_string).collect()
}

impl SettingsView {
    /// The MCP section: server list + toggles + add form.
    pub(crate) fn mcp_section(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.mcp;

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
                        Button::new("add-mcp-server")
                            .small()
                            .icon(IconName::Plus)
                            .label("Add custom MCP")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.mcp.open_draft(window, cx);
                            })),
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
            .when_some(state.adding.as_ref(), |el, draft| {
                el.child(self.mcp_editor(draft, cx))
            })
            .when_some(state.removing.clone(), |el, removing| {
                el.child(self.mcp_remove_confirm(&removing, cx))
            })
    }

    /// The server list card (empty state or rows).
    fn mcp_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
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
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.mcp.removing = Some(click_id.clone());
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

    /// The add-stdio-server form.
    fn mcp_editor(&self, draft: &McpDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let name_value = draft.name.read(cx).value().to_string();
        let command_value = draft.command.read(cx).value().to_string();
        let can_save = !name_value.trim().is_empty() && !command_value.trim().is_empty();

        v_flex()
            .id("mcp-editor")
            .w_full()
            .gap_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
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
                            .child("Add MCP server"),
                    )
                    .child(
                        Button::new("close-mcp-editor")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.mcp.adding = None;
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
                            .child(Input::new(&draft.name).small()),
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
                                    .child("Command"),
                            )
                            .child(Input::new(&draft.command).small()),
                    ),
            )
            .child(
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
                    .child(Input::new(&draft.args).small()),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Environment (one KEY=VALUE per line)"),
                    )
                    .child(Input::new(&draft.env).small()),
            )
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
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.mcp.adding = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("save-mcp-server")
                            .small()
                            .primary()
                            .label(if draft.saving { "Saving…" } else { "Save" })
                            .disabled(!can_save || draft.saving)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.mcp.save_draft(&this.services, cx);
                            })),
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
        h_flex()
            .id("mcp-remove-confirm")
            .w_full()
            .gap_3()
            .items_center()
            .px_4()
            .py_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.danger.opacity(0.5))
            .child(div().flex_1().text_sm().child(format!(
                "Remove “{label}”? It will be disconnected and removed."
            )))
            .child(
                Button::new("cancel-mcp-remove")
                    .small()
                    .ghost()
                    .label("Cancel")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.mcp.removing = None;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("confirm-mcp-remove")
                    .small()
                    .danger()
                    .label("Remove")
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.mcp.confirm_remove(&removing, &this.services, cx);
                    })),
            )
    }
}

impl McpState {
    fn reset_connections(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
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
        let make_input =
            |cx: &mut Context<SettingsView>, window: &mut Window, placeholder: &str| {
                let placeholder = placeholder.to_string();
                cx.new(move |cx| InputState::new(window, cx).placeholder(placeholder))
            };
        let name = make_input(cx, window, "My MCP server");
        let command = make_input(cx, window, "npx");
        let args = make_input(
            cx,
            window,
            "-y @modelcontextprotocol/server-filesystem /path",
        );
        let env = make_input(cx, window, "API_KEY=...");
        for input in [name.clone(), command.clone(), args.clone(), env.clone()] {
            let subscription =
                cx.subscribe_in(&input, window, |_this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                });
            self._subscriptions.push(subscription);
        }
        self.adding = Some(McpDraft {
            name,
            command,
            args,
            env,
            saving: false,
        });
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

    /// Persist the add form as a new stdio server.
    fn save_draft(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving {
            return;
        }
        let name = draft.name.read(cx).value().to_string();
        let command = draft.command.read(cx).value().to_string();
        let args = parse_args_text(&draft.args.read(cx).value());
        let env = parse_env_lines(&draft.env.read(cx).value());
        draft.saving = true;
        let services = services.clone();
        let record = McpServer {
            id: format!("mcp-{:x}", aiden_data::now_millis()),
            name: name.trim().to_string(),
            transport: aiden_data::portable_config::McpTransport::Stdio,
            command: Some(command.trim().to_string()),
            args: Some(args),
            env: Some(env),
            url: None,
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        };
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(async move { services.mcp_mutation.save(record).await.is_ok() })
                .await;
            this.update(cx, |this, cx| {
                if ok {
                    this.mcp.adding = None;
                } else if let Some(draft) = this.mcp.adding.as_mut() {
                    draft.saving = false;
                }
                this.mcp.error = if ok {
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
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let server_id = server_id.to_string();
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(
                    async move { services.mcp_mutation.remove(&server_id).await.is_ok() },
                )
                .await;
            this.update(cx, |this, cx| {
                if ok {
                    this.mcp.removing = None;
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
    use aiden_scheduler::runtime::create_scheduler;
    use gpui::TestAppContext;

    use crate::services::chat_service::ChatService;
    use crate::services::codex_auth::PiCodexAuthStore;
    use crate::services::mcp_mutation::McpMutationAuthority;
    use crate::services::native_appearance::{NativeAppearance, PreparedNativeAppearance};
    use crate::services::stores::{DisabledTaskExecutor, StoreSecretsPort, Stores};
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
        let codex_auth = Arc::new(PiCodexAuthStore::new(credentials));
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
        let scheduler = create_scheduler(
            schedules.clone(),
            Arc::new(DisabledTaskExecutor),
            None,
            Box::new(aiden_data::now_millis),
        );
        let chats_path = local.path().join("chats");
        let (config_changed, _) = tokio::sync::watch::channel(0);
        Stores {
            chat: Arc::new(create_chat_store(
                Box::new(move || chats_path.clone()),
                None,
                ChatStoreDurability::default(),
            )),
            config,
            appearance_intent_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            keys,
            codex_auth,
            foundation_models,
            schedules,
            usage: Arc::new(UsageStore::new_data_store(Some(local.path().to_path_buf()))),
            mcp,
            mcp_mutation,
            scheduler,
            quit_barrier: Arc::new(aiden_mac::quit_barrier::QuitBarrier::new()),
            config_watcher: None,
            config_changed: Arc::new(config_changed),
            runs: None,
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
            active: crate::settings::SettingsSection::Mcp,
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
        ]);
        let lines = format_env_lines(&record);
        assert_eq!(parse_env_lines(&lines), record);
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
                this.mcp.save_draft(&services, cx);
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
                this.mcp.save_draft(&services, cx);
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
}
