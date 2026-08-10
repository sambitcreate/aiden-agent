//! The assistant panel entity: the proactive-assistant surface routed as
//! `AppView::Assistant`. Ports `renderer/components/assistant/assistant-panel.tsx`
//! and `use-assistant-chat.ts`, driven by `aiden_agent::run_agent` instead of
//! the renderer IPC bridge.
//!
//! The panel owns the transcript view state, the approval bridge, and the run
//! lifecycle: a user message → `build_assistant_system_prompt` + the assembled
//! tool surface → `AgentEvent` stream folded into the view state by the
//! foreground watcher.
//!
//! Mutating proposals (`schedule_task` / `edit_automation`) pause on the
//! [`ApprovalBridge`] and render as inline cards; the user's decision resolves
//! the runner over the one-shot channel. MCP connector tools come from the
//! shared [`aiden_mcp::McpClientManager`] inventory, collected on panel open
//! and via the refresh button. All store I/O and the provider stream run on the
//! background executor.

use std::rc::Rc;
use std::sync::Arc;

use aiden_agent::system_prompt::{AssistantMcpServer, AssistantPromptInput};
use aiden_agent::{run_agent, AgentEvent, RunnerConfig};
use aiden_data::portable_config::McpServer;
use aiden_data::schedule_store::ScheduledTask;
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};
use gpui_tokio_bridge::{JoinError, Tokio};
use tokio::sync::mpsc;

use crate::approvals::approval_bridge::{ApprovalBridge, ApprovalDecision};
use crate::approvals::mcp_mutation_approval::mcp_mutation_approval_section;
use crate::approvals::queue::{
    approval_kind, decide_approval, queue_head, ApprovalKind, PendingApproval,
};
use crate::approvals::shell_approval::shell_approval_section;
use crate::approvals::tool_approval_card::tool_approval_card;
use crate::assistant::automation_approval::{automation_approval_card, enrich_automation_details};
use crate::assistant::thread::render_thread;
use crate::assistant::tool_executor::{
    collect_assistant_mcp_tools, enabled_mcp_servers, AssistantToolExecutor, StoreMcpServerLister,
    StoreScheduleSource, StoreWorkspaceLister,
};
use crate::assistant::view_state::{
    can_send, history_to_messages, AssistantPhase, AssistantViewState,
};
use crate::services::mcp_tools::{ChatMcpTools, McpStreamContext};
use crate::services::provider_availability::require_available_selection;
use crate::services::provider_kit::{resolve_api_key, ConfiguredProvider, ModelSelection};
use crate::services::stores::Stores;

/// The persisted model-selection settings key (shared with the chat service).
const MODEL_SELECTION_KEY: &str = "modelSelection";

/// The "Try asking" starter prompts (spirit of `ASSISTANT_SUGGESTED_PROMPTS`).
const SUGGESTED_PROMPTS: &[&str] = &[
    "Create a daily summary automation for my project",
    "List my saved automations",
    "What can you automate in Aiden?",
];

/// Cap for the recent-automations list.
const RECENT_AUTOMATIONS_LIMIT: usize = 5;

/// An event the panel emits; the shell routes it (today only refresh signals
/// are emitted — execution/approval are self-contained in the panel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantPanelEvent {
    Refresh,
}

impl gpui::EventEmitter<AssistantPanelEvent> for AssistantPanel {}

/// Dependencies for [`AssistantPanel::new`]: the shared durable stores (which
/// carry the shared [`aiden_mcp::McpClientManager`]).
pub struct AssistantPanelDeps {
    pub stores: Stores,
}

impl AssistantPanelDeps {
    pub fn new(stores: Stores) -> Self {
        Self { stores }
    }
}

/// The assistant surface entity.
pub struct AssistantPanel {
    stores: Stores,
    state: AssistantViewState,
    bridge: Arc<ApprovalBridge>,
    draft: Entity<InputState>,
    message_scroll: ScrollHandle,

    /// Provider catalog + selection (booted from the config store on the
    /// background executor; the composer picker's live selection is a later
    /// phase).
    providers: Vec<ConfiguredProvider>,
    selection: Option<ModelSelection>,
    ready: bool,
    loading: bool,

    /// Recent automations from the schedule store (newest first).
    recent: Vec<ScheduledTask>,
    /// Enabled MCP servers + collected tool inventory (panel open + refresh).
    mcp_servers: Vec<McpServer>,
    mcp_tools: ChatMcpTools,

    /// Decision channel: the approval cards' callbacks (plain `Fn`s without a
    /// context) park their decision here; the foreground watcher applies it.
    decision_tx: mpsc::UnboundedSender<(String, ApprovalDecision)>,

    /// Intent counter: incrementing invalidates in-flight watchers (stop /
    /// new turn), mirroring `ChatService`.
    turn: u64,

    _subscriptions: Vec<Subscription>,
    _driver: Option<Task<Result<(), JoinError>>>,
    _watcher: Option<Task<anyhow::Result<()>>>,
    _decision_watcher: Option<Task<anyhow::Result<()>>>,
}

impl AssistantPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, deps: AssistantPanelDeps) -> Self {
        let draft = cx.new(|cx| {
            InputState::new(window, cx)
                .auto_grow(1, 8)
                .placeholder("Ask about Aiden")
        });
        let (decision_tx, mut decision_rx) =
            mpsc::unbounded_channel::<(String, ApprovalDecision)>();

        let mut this = Self {
            stores: deps.stores,
            state: AssistantViewState::default(),
            bridge: Arc::new(ApprovalBridge::new()),
            draft,
            message_scroll: ScrollHandle::new(),
            providers: Vec::new(),
            selection: None,
            ready: false,
            loading: true,
            recent: Vec::new(),
            mcp_servers: Vec::new(),
            mcp_tools: ChatMcpTools::default(),
            decision_tx,
            turn: 0,
            _subscriptions: Vec::new(),
            _driver: None,
            _watcher: None,
            _decision_watcher: None,
        };

        // Composer: re-render on change; Enter (without shift) sends.
        this._subscriptions.push(cx.subscribe_in(
            &this.draft,
            window,
            |this, _source, event, window, cx| match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { secondary: false } => {
                    let text = this.draft.read(cx).value().to_string();
                    this.send(&text, window, cx);
                }
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));

        // The decision watcher: applies approval-card decisions on the
        // foreground thread (the card callbacks only have a channel).
        this._decision_watcher = Some(cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            while let Some((approval_id, decision)) = decision_rx.recv().await {
                this.update(cx, |this, cx| {
                    this.decide_approval(&approval_id, decision, cx)
                })?;
            }
            Ok(())
        }));

        this.boot(cx);
        this
    }

    /// Load providers/selection, recent automations, and the MCP inventory on
    /// the background executor, then flip `ready`.
    fn boot(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        cx.notify();
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_spawn(async move {
                    let providers = stores
                        .config
                        .list_providers()
                        .map(|list| list.iter().map(ConfiguredProvider::from).collect())
                        .unwrap_or_default();
                    let settings = stores.config.get_settings().unwrap_or_default();
                    let recent = stores.schedules.list().unwrap_or_default();
                    let enabled = enabled_mcp_servers(&stores.config);
                    let preset_key = preset_key_resolver(&stores.mcp_mutation, &enabled);
                    let context = McpStreamContext {
                        manager: stores.mcp.clone(),
                        servers: enabled.clone(),
                        preset_key: Some(preset_key),
                    };
                    let tools = collect_assistant_mcp_tools(&context).await;
                    (providers, settings, recent, enabled, tools)
                })
                .await;
            this.update(cx, |this, cx| {
                this.providers = snapshot.0;
                this.selection = resolve_selection(&snapshot.1, &this.providers);
                this.ready = selection_ready(&this.selection, &this.providers);
                this.recent = newest_first(snapshot.2);
                this.mcp_servers = snapshot.3;
                this.mcp_tools = snapshot.4;
                this.loading = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Re-collect the MCP connector inventory (refresh button). Connections and
    /// `tools/list` run on the background executor; failing servers are
    /// skipped, never failing the refresh.
    pub fn refresh_mcp_inventory(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let (servers, tools) = cx
                .background_spawn(async move {
                    let enabled = enabled_mcp_servers(&stores.config);
                    let preset_key = preset_key_resolver(&stores.mcp_mutation, &enabled);
                    let context = McpStreamContext {
                        manager: stores.mcp.clone(),
                        servers: enabled.clone(),
                        preset_key: Some(preset_key),
                    };
                    let tools = collect_assistant_mcp_tools(&context).await;
                    (enabled, tools)
                })
                .await;
            this.update(cx, |this, cx| {
                this.mcp_servers = servers;
                this.mcp_tools = tools;
                cx.emit(AssistantPanelEvent::Refresh);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Refresh the recent-automations list (after an approved proposal saves).
    fn refresh_recent(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let list = cx
                .background_spawn(async move { stores.schedules.list().unwrap_or_default() })
                .await;
            this.update(cx, |this, cx| {
                this.recent = newest_first(list);
                cx.emit(AssistantPanelEvent::Refresh);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The current readiness text (mirrors `READINESS_TEXT`).
    fn readiness_text(&self) -> Option<&'static str> {
        if self.ready {
            return None;
        }
        if self.loading {
            return Some("Loading your providers…");
        }
        if self.providers.is_empty() {
            return Some("Aiden could not load your providers. Try again in a moment.");
        }
        Some("Choose a provider and model in the main composer before chatting here.")
    }

    /// The system-prompt inputs for one run (the attended assistant contract).
    fn prompt_input(&self, executor: &AssistantToolExecutor) -> AssistantPromptInput {
        let mut input = AssistantPromptInput::new(
            vec![
                "appearance".to_string(),
                "providers".to_string(),
                "shortcuts".to_string(),
                "mcp".to_string(),
                "scheduled-tasks".to_string(),
                "about".to_string(),
            ],
            // The assistant surface has no settings tools yet; the fail-closed
            // default posture is "ask" for any future change.
            "ask",
            executor
                .tool_defs()
                .iter()
                .map(|def| def.name.clone())
                .collect(),
            false,
        );
        input.mcp_servers = self
            .mcp_servers
            .iter()
            .map(|server| AssistantMcpServer {
                id: server.id.clone(),
                name: server.name.clone(),
            })
            .collect();
        input.mcp_server_total = Some(self.mcp_servers.len());
        input.mcp_inventory_truncated = Some(false);
        input.mcp_omitted_invalid_identities = Some(0);
        input
    }

    /// Assemble the runner inputs and spawn the background agent run + the
    /// foreground watcher. Mirrors the chat service's driver/watcher split.
    fn start_turn(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(selection) = self.selection.clone() else {
            self.state.error = Some("Choose a provider and model before chatting here.".into());
            cx.notify();
            return;
        };
        let provider = match require_available_selection(&self.providers, &selection) {
            Ok(provider) => provider,
            Err(error) => {
                self.state.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        if provider.needs_key && !provider.has_key {
            self.state.error = Some(format!(
                "No API key set for {}. Add one in Settings → Providers.",
                provider.label
            ));
            cx.notify();
            return;
        }

        self.turn += 1;
        let turn = self.turn;
        self.state.start_turn(text);
        cx.notify();

        let stores = self.stores.clone();
        let bridge = self.bridge.clone();
        let mcp_tools = self.mcp_tools.clone();
        let executor = Arc::new(AssistantToolExecutor::new(
            Arc::new(StoreMcpServerLister(stores.config.clone())),
            Arc::new(StoreWorkspaceLister(stores.config.clone())),
            stores.mcp.clone(),
            mcp_tools,
            Arc::new(StoreScheduleSource(stores.scheduler.clone())),
        ));
        let system_prompt =
            aiden_agent::build_assistant_system_prompt(&self.prompt_input(&executor));
        let config = RunnerConfig {
            provider_id: selection.provider_id.clone(),
            model: selection.model.clone(),
            system_prompt: Some(system_prompt),
            // Resolved on the background driver thread (keychain access).
            api_key: None,
            max_tool_iterations: 10,
            max_repeated_calls: 3,
            attended_tool_error_guard: true,
        };
        let messages = history_to_messages(
            &self.state.messages,
            &selection.provider_id,
            &selection.model,
        );

        let (tx, rx) = mpsc::channel(128);
        let provider_config = stores.config.clone();
        let transport = provider.transport_with_codex_auth(stores.codex_auth.clone());
        let driver = Tokio::spawn(cx, async move {
            // Keychain access + the provider stream run on the background
            // driver thread, never the GPUI foreground.
            let api_key = resolve_api_key(&provider_config, &provider);
            let config = RunnerConfig { api_key, ..config };
            let _ = run_agent(
                transport.as_ref(),
                executor.as_ref(),
                bridge.as_ref(),
                &config,
                messages,
                tx,
            )
            .await;
        });
        self._driver = Some(driver);

        let watcher = cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                let alive = this.read_with(cx, |this, _| this.turn == turn)?;
                if !alive {
                    break;
                }
                this.update(cx, |this, cx| this.apply_agent_event(event, cx))?;
            }
            Ok(())
        });
        self._watcher = Some(watcher);
    }

    /// Fold one runner event into the view state; terminal events refresh the
    /// recent automations (an approved proposal just landed in the store).
    fn apply_agent_event(&mut self, event: AgentEvent, cx: &mut Context<Self>) {
        let terminal = matches!(event, AgentEvent::Done { .. });
        self.state.apply_event(&event);
        self.message_scroll.scroll_to_bottom();
        if terminal {
            self.refresh_recent(cx);
        }
        cx.notify();
    }

    /// Stop the in-flight run: invalidate the watcher, abort the driver (the
    /// gpui Task drop cancels the tokio task), and settle every pending
    /// approval with the cancelled path.
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        self.turn += 1;
        self._driver = None;
        self._watcher = None;
        self.bridge.cancel_all();
        self.bridge.reset_session();
        self.state.stop_turn();
        self.message_scroll.scroll_to_bottom();
        cx.notify();
    }

    /// Reset to an empty thread (new conversation).
    pub fn new_thread(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
        self.state = AssistantViewState::default();
        cx.notify();
    }

    /// Send the composer draft (Enter or the send button).
    pub fn send(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty()
            || !self.state.can_start_turn()
            || !self.ready
            || !can_send(&text, self.streaming(), self.ready)
        {
            return;
        }
        self.draft
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.start_turn(&text, cx);
    }

    fn streaming(&self) -> bool {
        self.state.phase == AssistantPhase::Streaming
    }

    /// Resolve the queue head's approval: deliver the decision to the bridge
    /// (one-shot) and drop the card from the queue.
    pub fn decide_approval(
        &mut self,
        approval_id: &str,
        decision: ApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        if self.state.deciding_approval_id.is_some() {
            return;
        }
        self.state.deciding_approval_id = Some(approval_id.to_string());
        self.bridge.decide(approval_id, decision);
        let (approvals, _) = decide_approval(self.state.approvals.clone(), approval_id);
        self.state.approvals = approvals;
        self.state.deciding_approval_id = None;
        cx.notify();
    }
}

/// The preset-key resolver used by MCP connector collection (keychain access
/// on the background executor only).
#[allow(clippy::type_complexity)] // shared with the chat driver's context shape
fn preset_key_resolver(
    authority: &Arc<crate::services::mcp_mutation::McpMutationAuthority>,
    servers: &[aiden_data::portable_config::McpServer],
) -> Arc<dyn Fn(&str) -> Option<String> + Send + Sync> {
    let authority = authority.clone();
    let servers = servers.to_vec();
    Arc::new(move |server_id: &str| {
        let server = servers.iter().find(|server| server.id == server_id)?;
        authority.bound_preset_key(server).ok().flatten()
    })
}

/// Resolve the persisted model selection, falling back to the first configured
/// provider's default (mirrors `ChatService::resolve_selection`).
fn resolve_selection(
    settings: &serde_json::Map<String, serde_json::Value>,
    providers: &[ConfiguredProvider],
) -> Option<ModelSelection> {
    if let Some(value) = settings.get(MODEL_SELECTION_KEY) {
        if let Some(selection) = ModelSelection::from_settings(value) {
            if require_available_selection(providers, &selection).is_ok() {
                return Some(selection);
            }
        }
    }
    let provider = providers.first()?;
    let model = provider
        .default_model
        .clone()
        .or_else(|| provider.models.first().cloned())?;
    Some(ModelSelection {
        provider_id: provider.id.clone(),
        model,
    })
}

fn selection_ready(selection: &Option<ModelSelection>, providers: &[ConfiguredProvider]) -> bool {
    let Some(selection) = selection else {
        return false;
    };
    require_available_selection(providers, selection)
        .ok()
        .is_some_and(|provider| !provider.needs_key || provider.has_key)
}

/// Newest-updated first (the renderer's `chats:list` order proxy).
fn newest_first(mut tasks: Vec<ScheduledTask>) -> Vec<ScheduledTask> {
    tasks.sort_by_key(|task| std::cmp::Reverse(task.updated_at));
    tasks
}

/// Owned render data (cloned once so render closures never borrow the panel).
struct AssistantRenderSnapshot {
    messages_len: usize,
    streaming: bool,
    can_send: bool,
    deciding: bool,
    head: Option<PendingApproval>,
    recent: Vec<ScheduledTask>,
    mcp_servers: Vec<McpServer>,
    mcp_tool_count: usize,
}

impl AssistantPanel {
    /// Clone the render inputs (owned so `cx.listener` closures never borrow
    /// the panel across `render`).
    fn render_snapshot(&self, cx: &mut Context<Self>) -> AssistantRenderSnapshot {
        let draft = self.draft.read(cx).value().to_string();
        AssistantRenderSnapshot {
            messages_len: self.state.messages.len(),
            streaming: self.streaming(),
            can_send: can_send(&draft, self.streaming(), self.ready),
            deciding: self.state.deciding_approval_id.is_some(),
            head: queue_head(&self.state.approvals).cloned(),
            recent: self.recent.clone(),
            mcp_servers: self.mcp_servers.clone(),
            mcp_tool_count: self.mcp_tools.defs.len(),
        }
    }
}

impl Render for AssistantPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snapshot = self.render_snapshot(cx);
        let theme = cx.theme();
        let readiness = self.readiness_text();
        let empty = snapshot.messages_len == 0;

        v_flex()
            .id("assistant-panel")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(self.header(&snapshot, cx))
            .child(if empty {
                self.empty_state(&snapshot, cx).into_any_element()
            } else {
                render_thread(&self.state, &self.message_scroll, window, cx).into_any_element()
            })
            .when_some(snapshot.head.clone(), |el, head| {
                el.child(self.approval_section(&head, &snapshot, cx))
            })
            .child(self.composer(&snapshot, readiness, cx))
    }
}

impl AssistantPanel {
    /// The panel header: Aiden mark, MCP inventory refresh, new thread.
    fn header(
        &self,
        snapshot: &AssistantRenderSnapshot,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        h_flex()
            .id("assistant-header")
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .size(px(20.))
                            .rounded_md()
                            .bg(theme.sidebar_primary)
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::Bot)
                                    .xsmall()
                                    .text_color(theme.sidebar_primary_foreground),
                            ),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Aiden"),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("{} MCP tools", snapshot.mcp_tool_count)),
                    )
                    .child(
                        Button::new("assistant-refresh-mcp")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Redo2)
                            .tooltip("Refresh MCP tools")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.refresh_mcp_inventory(cx);
                            })),
                    )
                    .child(
                        Button::new("assistant-new-thread")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Plus)
                            .tooltip("New conversation")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.new_thread(cx);
                            })),
                    ),
            )
    }

    /// The empty state: suggested prompts + recent automations.
    fn empty_state(
        &self,
        snapshot: &AssistantRenderSnapshot,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let recent: Vec<ScheduledTask> = snapshot
            .recent
            .iter()
            .take(RECENT_AUTOMATIONS_LIMIT)
            .cloned()
            .collect();

        v_flex()
            .id("assistant-empty")
            .flex_1()
            .w_full()
            .overflow_y_scroll()
            .px_3()
            .py_3()
            .gap_3()
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .px_1()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Try asking"),
                    )
                    .children(SUGGESTED_PROMPTS.iter().enumerate().map(|(index, prompt)| {
                        let click_text = (*prompt).to_string();
                        let display = click_text.clone();
                        div()
                            .id(ElementId::Name(SharedString::from(format!(
                                "assistant-suggested-{index}"
                            ))))
                            .w_full()
                            .px_2()
                            .py_1p5()
                            .rounded_md()
                            .cursor_pointer()
                            .hover(|style| style.bg(theme.list_hover))
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .on_click(cx.listener(move |this, _event, window, cx| {
                                this.send(&click_text, window, cx);
                            }))
                            .child(display)
                    })),
            )
            .when(!recent.is_empty(), |el| {
                el.child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(
                            div()
                                .px_1()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .child("Recent automations"),
                        )
                        .children(recent.into_iter().map(|task| {
                            div()
                                .w_full()
                                .px_2()
                                .py_1p5()
                                .rounded_md()
                                .bg(theme.list)
                                .border_1()
                                .border_color(theme.border)
                                .text_sm()
                                .truncate()
                                .child(format!("{} · {}", task.name, task.cron))
                        })),
                )
            })
    }

    /// The approval queue head, dispatched by details kind.
    fn approval_section(
        &self,
        head: &PendingApproval,
        snapshot: &AssistantRenderSnapshot,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let deciding = snapshot.deciding;
        let id = head.approval_id.clone();
        let decision_tx = self.decision_tx.clone();

        match approval_kind(head.details.as_ref()) {
            ApprovalKind::AssistantAutomation => {
                let enriched = head
                    .details
                    .as_ref()
                    .map(|details| {
                        // Workspace names resolve from the config at render
                        // time; the panel does not hold the workspace list, so
                        // only server names are enriched here (workspace names
                        // come straight from the proposal args).
                        enrich_automation_details(details, &[], &snapshot.mcp_servers)
                    })
                    .unwrap_or_default();
                let pending = PendingApproval {
                    approval_id: head.approval_id.clone(),
                    tool_call_id: head.tool_call_id.clone(),
                    tool_name: head.tool_name.clone(),
                    summary: head.summary.clone(),
                    details: Some(enriched),
                };
                automation_approval_card(
                    theme,
                    &pending,
                    deciding,
                    Rc::new(move |allow: bool| {
                        let decision = if allow {
                            ApprovalDecision::AllowOnce
                        } else {
                            ApprovalDecision::Deny
                        };
                        let _ = decision_tx.send((id.clone(), decision));
                    }),
                )
                .into_any_element()
            }
            ApprovalKind::Tool => tool_approval_card(
                theme,
                head,
                deciding,
                Rc::new(move |decision| {
                    let _ = decision_tx.send((id.clone(), decision));
                }),
            )
            .into_any_element(),
            ApprovalKind::Shell => shell_approval_section(
                theme,
                head.details.as_ref().unwrap_or(&serde_json::Value::Null),
            )
            .into_any_element(),
            ApprovalKind::McpMutation => mcp_mutation_approval_section(
                theme,
                head.details.as_ref().unwrap_or(&serde_json::Value::Null),
            )
            .into_any_element(),
            ApprovalKind::Unknown => v_flex()
                .id("approval-invalid")
                .w_full()
                .rounded_md()
                .bg(theme.background)
                .px_3()
                .py_2()
                .border_1()
                .border_color(theme.danger)
                .text_xs()
                .text_color(theme.danger)
                .child("This approval request is invalid and cannot be confirmed.")
                .into_any_element(),
        }
    }

    /// The composer: multiline input + send/stop button.
    fn composer(
        &self,
        snapshot: &AssistantRenderSnapshot,
        readiness: Option<&'static str>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("assistant-composer")
            .w_full()
            .px_3()
            .pb_3()
            .pt_2()
            .child(
                v_flex()
                    .w_full()
                    .rounded_2xl()
                    .bg(theme.popover)
                    .border_1()
                    .border_color(theme.border)
                    .px_3()
                    .py_2()
                    .gap_1()
                    .child(
                        Input::new(&self.draft)
                            .appearance(false)
                            .bordered(false)
                            .focus_bordered(true),
                    )
                    .when_some(readiness, |el, message| {
                        el.child(
                            div()
                                .px_1p5()
                                .pb_1()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(message),
                        )
                    })
                    .child(h_flex().w_full().items_center().justify_end().child(
                        if snapshot.streaming {
                            Button::new("assistant-stop")
                                .ghost()
                                .small()
                                .icon(IconName::Close)
                                .tooltip("Stop generating")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.stop(cx);
                                }))
                                .into_any_element()
                        } else {
                            Button::new("assistant-send")
                                .primary()
                                .small()
                                .icon(IconName::ArrowUp)
                                .disabled(!snapshot.can_send)
                                .tooltip("Send message (Enter)")
                                .on_click(cx.listener(|this, _event, window, cx| {
                                    let text = this.draft.read(cx).value().to_string();
                                    this.send(&text, window, cx);
                                }))
                                .into_any_element()
                        },
                    )),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::ProviderKind;
    use std::collections::HashMap;

    fn provider() -> ConfiguredProvider {
        ConfiguredProvider {
            id: "custom:test".into(),
            label: "Test".into(),
            kind: ProviderKind::Openai,
            base_url: "https://example.test/v1".into(),
            deployment: None,
            models: vec!["current-model".into()],
            default_model: Some("current-model".into()),
            model_metadata: HashMap::new(),
            catalog_models: Vec::new(),
            needs_key: false,
            has_key: false,
        }
    }

    #[test]
    fn stale_assistant_selection_is_not_ready_to_start() {
        let selection = Some(ModelSelection {
            provider_id: "custom:test".into(),
            model: "removed-model".into(),
        });

        assert!(!selection_ready(&selection, &[provider()]));
    }

    #[test]
    fn stale_persisted_assistant_selection_falls_back_to_an_available_model() {
        let settings = serde_json::json!({
            (MODEL_SELECTION_KEY): {
                "providerId": "custom:test",
                "model": "removed-model"
            }
        })
        .as_object()
        .unwrap()
        .clone();

        assert_eq!(
            resolve_selection(&settings, &[provider()]),
            Some(ModelSelection {
                provider_id: "custom:test".into(),
                model: "current-model".into(),
            })
        );
    }
}
