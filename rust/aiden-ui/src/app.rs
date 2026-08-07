//! The application shell: window root, title bar, and orchestration of the
//! sidebar + chat pane. All render helpers live on `AppState` but are defined
//! in per-surface modules (`shell::sidebar`, `chat::chat_pane`,
//! `chat::message_list`) so each file stays small.

use gpui::{
    actions, div, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, Styled as _, Subscription, Window,
};
use gpui_component::{
    h_flex,
    input::{InputEvent, InputState},
    select::{SelectEvent, SelectItem as _, SelectState},
    v_flex, ActiveTheme,
};

use crate::chat::composer::{decode_model_key, model_items, model_key, ModelItem};
use crate::services::chat_service::ChatService;
use crate::services::stores::Stores;

actions!(aiden, [NewChat, Quit]);

/// The per-window root view.
pub struct AppState {
    pub(crate) service: Entity<ChatService>,
    /// Multiline auto-growing composer input.
    pub(crate) composer_input: Entity<InputState>,
    /// Sidebar chat search input.
    pub(crate) search_input: Entity<InputState>,
    /// Model picker (created once; items sync with the provider catalog).
    pub(crate) model_select: Option<Entity<SelectState<Vec<ModelItem>>>>,
    model_select_dirty: bool,
    pub(crate) message_scroll: ScrollHandle,
    last_message_len: usize,
    last_catalog: Vec<String>,
    appearance_applied: bool,
    _subscriptions: Vec<Subscription>,
}

impl AppState {
    pub fn new(stores: Stores, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let service = cx.new(|cx| ChatService::new(stores, cx));
        service.update(cx, |service, cx| service.boot(cx));

        let composer_input = cx.new(|cx| {
            InputState::new(window, cx)
                .auto_grow(1, 8)
                .placeholder("Message Aiden…")
        });
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search chats"));

        let mut this = Self {
            service,
            composer_input,
            search_input,
            model_select: None,
            model_select_dirty: true,
            message_scroll: ScrollHandle::new(),
            last_message_len: 0,
            last_catalog: Vec::new(),
            appearance_applied: false,
            _subscriptions: Vec::new(),
        };

        // Composer: re-render on change; Enter (without shift) sends.
        this._subscriptions.push(cx.subscribe_in(
            &this.composer_input,
            window,
            |this, _source, event, window, cx| match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { secondary: false } => {
                    let text = this.composer_input.read(cx).value().to_string();
                    this.send_composer(&text, window, cx);
                }
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));

        // Search: filter the sidebar list on change.
        this._subscriptions.push(cx.subscribe_in(
            &this.search_input,
            window,
            |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    let query = this.search_input.read(cx).value().to_string();
                    this.service.update(cx, |service, cx| {
                        service.set_search_query(&query, cx);
                    });
                }
            },
        ));

        // Model picker confirmations (the select is created lazily on first
        // render once the provider catalog has loaded).
        let model_select = this.model_select_entity(window, cx);
        this._subscriptions.push(cx.subscribe(
            &model_select,
            |this, _source, event: &SelectEvent<Vec<ModelItem>>, cx| {
                if let SelectEvent::Confirm(Some(key)) = event {
                    if let Some((provider_id, model)) = decode_model_key(key) {
                        this.service.update(cx, |service, cx| {
                            service.select_model(&provider_id, &model, cx);
                        });
                    }
                }
            },
        ));

        // Service changes: apply appearance once booted, sync the model picker
        // catalog, and follow streaming output.
        this._subscriptions
            .push(cx.observe(&this.service, |this, _service, cx| {
                this.sync_from_service(cx);
            }));

        this
    }

    /// Create (once) the model-picker select state. Needs a window, so it is
    /// called from `AppState::new` (which has one) and cached.
    fn model_select_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SelectState<Vec<ModelItem>>> {
        if let Some(state) = &self.model_select {
            return state.clone();
        }
        let providers = self.service.read(cx).providers.clone();
        let items = model_items(&providers);
        let selected = self
            .service
            .read(cx)
            .selection
            .as_ref()
            .and_then(|selection| {
                let key = model_key(&selection.provider_id, &selection.model);
                items
                    .iter()
                    .position(|item| item.value() == &key)
                    .map(|row| gpui_component::IndexPath::default().row(row))
            });
        let state = cx.new(|cx| SelectState::new(items, selected, window, cx));
        self.model_select = Some(state.clone());
        state
    }

    /// Central sync point driven by service notifications (no window access
    /// here — window-dependent work is deferred to render).
    fn sync_from_service(&mut self, cx: &mut Context<Self>) {
        let booted = self.service.read(cx).booted;
        if booted && !self.appearance_applied {
            self.appearance_applied = true;
            self.service
                .update(cx, |service, inner| service.apply_appearance(inner));
        }

        let service = self.service.read(cx);
        let catalog: Vec<String> = service
            .providers
            .iter()
            .map(|provider| {
                format!(
                    "{}:{}:{}",
                    provider.id,
                    provider.models.len(),
                    provider.has_key
                )
            })
            .collect();
        if catalog != self.last_catalog {
            self.last_catalog = catalog;
            self.model_select_dirty = true;
        }

        let message_len = service
            .active_chat
            .as_ref()
            .map_or(0, |chat| chat.messages.len());
        if message_len != self.last_message_len || service.generation_active() {
            self.last_message_len = message_len;
            self.message_scroll.scroll_to_bottom();
        }
    }

    /// Apply the model-picker catalog + selection; called from render with
    /// window access, deferred until the current update completes.
    fn sync_model_select(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_select_dirty {
            return;
        }
        self.model_select_dirty = false;
        let Some(select) = self.model_select.clone() else {
            return;
        };
        let providers = self.service.read(cx).providers.clone();
        let selection_key = self
            .service
            .read(cx)
            .selection
            .as_ref()
            .map(|selection| model_key(&selection.provider_id, &selection.model));
        let items = model_items(&providers);
        cx.defer_in(window, move |_this, window, cx| {
            select.update(cx, |state, cx| state.set_items(items, window, cx));
            if let Some(key) = selection_key {
                select.update(cx, |state, cx| state.set_selected_value(&key, window, cx));
            }
        });
    }

    /// Send the composer contents (Enter or the send button).
    pub fn send_composer(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.composer_input
            .update(cx, |input, inner| input.set_value("", window, inner));
        self.service
            .update(cx, |service, cx| service.send_message(&text, cx));
    }

    fn on_new_chat(&mut self, _: &NewChat, _: &mut Window, cx: &mut Context<Self>) {
        self.service.update(cx, |service, cx| service.new_chat(cx));
    }

    fn on_quit(&mut self, _: &Quit, _: &mut Window, cx: &mut Context<Self>) {
        cx.quit();
    }
}

impl Render for AppState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_model_select(window, cx);
        let theme = cx.theme();

        // Title bar: traffic lights are OS-provided; the bar shows the chat
        // title (or the workspace name when no chat is open).
        let title: String = self
            .service
            .read(cx)
            .active_chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_else(|| "Aiden".to_string());

        v_flex()
            .id("aiden-root")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context("App")
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_quit))
            .child(
                gpui_component::TitleBar::new().child(
                    h_flex()
                        .id("titlebar-content")
                        .size_full()
                        .items_center()
                        .px_3()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .truncate()
                                .child(title),
                        ),
                ),
            )
            .child(
                h_flex()
                    .id("app-body")
                    .flex_1()
                    .size_full()
                    .child(self.sidebar(window, cx))
                    .child(self.chat_pane(window, cx)),
            )
    }
}
