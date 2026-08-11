//! Onboarding flow rendering. The step content mirrors the TS card copy; the
//! motion is a quiet 180ms opacity crossfade per step, gated by the reduced
//! motion preference (GPUI 0.2 has no transform animations, so the design
//! docs' scale/offset recipes are approximated with opacity only).

use std::sync::Arc;
use std::time::Duration;

use aiden_core::appearance::{
    get_preset_variant, theme_presets, Mode, PresetId, ReduceMotion, Selection,
};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, img, px, Animation, AnimationExt as _, AnyElement, Context, FontWeight, Image,
    ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, Theme,
};

use super::state::{ProviderChoice, Step};
use super::OnboardingView;

const PROFILE_TOUR_PNG: &[u8] =
    include_bytes!("../../../../renderer/assets/onboarding/profile.png");
const PROVIDERS_TOUR_PNG: &[u8] =
    include_bytes!("../../../../renderer/assets/onboarding/providers.png");
const SUBAGENTS_TOUR_PNG: &[u8] =
    include_bytes!("../../../../renderer/assets/onboarding/subagents.png");
const PRIVACY_TOUR_PNG: &[u8] =
    include_bytes!("../../../../renderer/assets/onboarding/privacy.png");
const MACOS_TOUR_PNG: &[u8] = include_bytes!("../../../../renderer/assets/onboarding/macos.png");
const BENTO_TOUR_PNG: &[u8] = include_bytes!("../../../../renderer/assets/onboarding/bento.png");

struct TourFeature {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    image: &'static [u8],
}

const TOUR_FEATURES: [TourFeature; 6] = [
    TourFeature {
        id: "profile",
        title: "Local profile",
        description: "Personalize model-facing context while your profile stays on this Mac.",
        image: PROFILE_TOUR_PNG,
    },
    TourFeature {
        id: "providers",
        title: "Provider choice",
        description: "Connect hosted or local providers explicitly, then switch models in chat.",
        image: PROVIDERS_TOUR_PNG,
    },
    TourFeature {
        id: "subagents",
        title: "Delegated tasks",
        description: "Run focused fresh or fork tasks; writes, shell, and remote MCP reads wait for Allow once.",
        image: SUBAGENTS_TOUR_PNG,
    },
    TourFeature {
        id: "privacy",
        title: "Private by design",
        description: "Settings and encrypted credentials stay device-local unless you act.",
        image: PRIVACY_TOUR_PNG,
    },
    TourFeature {
        id: "macos",
        title: "Native macOS feel",
        description: "Quiet motion, visible keyboard focus, and responsive native surfaces.",
        image: MACOS_TOUR_PNG,
    },
    TourFeature {
        id: "bento",
        title: "One focused workspace",
        description: "Chat, files, review, terminal, usage, and settings stay close at hand.",
        image: BENTO_TOUR_PNG,
    },
];

fn tour_tile_consumes_key(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

/// Selection cards live inside the onboarding root's Enter key context. Stop
/// that bubbling action while a card owns focus so Enter activates the card
/// (via GPUI's native keyboard click) instead of advancing the whole flow.
fn selection_card_consumes_key(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

/// Whether motion is allowed for this appearance preference + the injected
/// OS flag (mirrors the pill's `MotionGate`; GPUI cannot probe the OS).
fn motion_allowed(reduce_motion: ReduceMotion, system_reduced: bool) -> bool {
    match reduce_motion {
        ReduceMotion::On => false,
        ReduceMotion::Off => true,
        ReduceMotion::System => !system_reduced,
    }
}

/// Parse a `#RRGGBB` preset token into an `Hsla` for swatch rendering. The hex
/// always comes from the appearance tokens (`aiden_core`), never hardcoded.
fn hsla_from_hex(hex: &str) -> Option<gpui::Hsla> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some(gpui::rgba(value).into())
}

fn selection_matches(selection: Selection, preset: PresetId) -> bool {
    matches!(
        (selection, preset),
        (Selection::Aiden, PresetId::Aiden)
            | (Selection::Slate, PresetId::Slate)
            | (Selection::Berry, PresetId::Berry)
            | (Selection::Moss, PresetId::Moss)
    )
}

/// A quiet 180ms ease-out cubic (the design docs' restrained entrance).
fn quiet_ease(t: f32) -> f32 {
    1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t)
}

const PERMISSION_ROWS: [(&str, &str); 8] = [
    (
        "Dictation",
        "Aiden requests microphone access only when you explicitly start recording and never \
         saves or logs the audio. On-device transcription stays on this Mac; if you select \
         configured OpenAI or Google Gemini voice, the completed recording is sent only to that \
         provider for transcription.",
    ),
    (
        "Computer Use",
        "Computer Use is off by default. When enabled for a chat, transient screenshots and \
         accessibility text may be sent to the selected model but are not saved or logged by \
         Aiden. Every input action asks for Allow once or Deny.",
    ),
    (
        "Delegated workspace tasks",
        "A delegated task, its bounded fresh or fork context projection, and bounded workspace \
         file or tool results may be sent to your selected provider. Reads stay within your \
         workspace permission, and every write or edit pauses for Allow once or Deny. A proposed \
         shell command also pauses for per-command Allow once or Deny. If allowed, it runs with \
         unsandboxed workspace and host access in a scrubbed environment, so it can still have \
         arbitrary network and process effects; detached descendants may outlive cancellation and \
         there is no rollback. At generation start, enabled remote MCP servers may receive a \
         bounded connection and tools-list request. Every exact server/tool call and its displayed \
         arguments then waits for Allow once or Deny; credentials remain host-owned, and the \
         configured server controls the actual effect. Mutating calls show their effect profile \
         and prior-unknown warning; an uncertain result is never retried automatically. Nested \
         and background subagents remain unavailable in this release.",
    ),
    (
        "Local by default",
        "Your profile name, providers, keys, and settings stay on this Mac. Aiden never bundles \
         your credentials anywhere else.",
    ),
    (
        "No silent network access",
        "This onboarding step makes no network calls. Providers are contacted only for actions \
         you explicitly start, such as chat, model-data refresh, or cloud voice transcription \
         after recording.",
    ),
    (
        "MCP connections",
        "MCP servers can expose remote tools and may receive relevant request data. Aiden connects \
         only after you configure a server; OAuth opens only when you explicitly choose Authorize, \
         and its tokens stay encrypted on this Mac.",
    ),
    (
        "Scheduled tasks",
        "Scheduled execution is off until you enable it in Settings. Enabled tasks run only while \
         Aiden is open: pinned prompts may be sent to their selected provider and approved MCP \
         servers, while local scripts require Full access and are time/output limited.",
    ),
    (
        "Skills",
        "Skill names, descriptions, and tool disclosure may be sent to the selected model before \
         invocation. Detailed instructions and supporting-file content are sent only when invoked. \
         Skills never expand workspace access or bypass approvals.",
    ),
];

impl Render for OnboardingView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let step = self.machine.current();
        let step_index = self.machine.step_index();
        let total = self.machine.total_steps();
        // System is a live process preference, not a baked-in false. This is
        // also refreshed by the native accessibility observer while the main
        // window is open; onboarding uses the same conservative probe before
        // it has a ChatService owner.
        let motion = motion_allowed(
            self.machine.reduce_motion,
            crate::services::appearance::current_system_reduced_motion(cx),
        );
        let finish = step == Step::Finish;

        // Focus management: the name field on Welcome, the primary action
        // everywhere else (macOS-style forward focus on step change).
        self.manage_focus(step, window, cx);

        let step_content = v_flex()
            .id("onboarding-step-content")
            .flex_1()
            .w_full()
            .min_h(px(360.0))
            .justify_center()
            .child(self.step_content(step, cx));
        let step_content: AnyElement = if motion {
            step_content
                .with_animation(
                    ("onboarding-crossfade", step_index),
                    Animation::new(Duration::from_millis(180)).with_easing(quiet_ease),
                    |el, progress| el.opacity(progress),
                )
                .into_any_element()
        } else {
            step_content.into_any_element()
        };

        div()
            .id("onboarding-root")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context("onboarding")
            .on_action(cx.listener(Self::on_next))
            .on_action(cx.listener(Self::on_back))
            .on_action(cx.listener(Self::on_skip))
            .child(
                v_flex()
                    .id("onboarding-card")
                    .size_full()
                    .max_w(px(820.0))
                    .mx_auto()
                    .p_8()
                    .gap_4()
                    .child(self.card_header(step_index, total, &theme, cx))
                    .child(
                        div()
                            .w_full()
                            .h(px(6.0))
                            .flex()
                            .gap_2()
                            .children((0..total).map(|index| {
                                let active = index <= step_index;
                                div()
                                    .id(("onboarding-progress", index))
                                    .flex_1()
                                    .h(px(6.0))
                                    .rounded_full()
                                    .bg(if active { theme.accent } else { theme.border })
                            })),
                    )
                    .child(step_content)
                    .when_some(self.machine.error, |el, message| {
                        el.child(
                            div()
                                .w_full()
                                .text_sm()
                                .text_color(theme.danger)
                                .child(message),
                        )
                    })
                    .child(self.card_footer(finish, &theme, cx)),
            )
    }
}

impl OnboardingView {
    /// Focus the name input on Welcome and the primary action elsewhere, once
    /// per step change.
    fn manage_focus(&mut self, step: Step, window: &mut Window, cx: &mut Context<Self>) {
        if self.focused_step == self.machine.step_index() {
            return;
        }
        self.focused_step = self.machine.step_index();
        if step == Step::Welcome {
            let name = self.name_input.clone();
            name.update(cx, |input, inner| input.focus(window, inner));
        } else {
            window.focus(&self.next_focus);
        }
    }

    fn card_header(
        &self,
        step_index: usize,
        total: usize,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .id("onboarding-header")
            .w_full()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.muted_foreground)
                    .child(format!("Step {} of {}", step_index + 1, total)),
            )
            .child(
                Button::new("onboarding-skip")
                    .ghost()
                    .small()
                    .label("Skip")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.skip_pressed(cx);
                    })),
            )
    }

    fn card_footer(&self, finish: bool, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .id("onboarding-footer")
            .w_full()
            .items_center()
            .justify_between()
            .pt_4()
            .border_t_1()
            .border_color(theme.border)
            .child(
                Button::new("onboarding-back")
                    .ghost()
                    .icon(IconName::ChevronLeft)
                    .label("Back")
                    .disabled(self.machine.step_index() == 0 || self.busy)
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.back_pressed(cx);
                    })),
            )
            .child(
                Button::new("onboarding-next")
                    .primary()
                    .label(if finish { "Start using Aiden" } else { "Next" })
                    .icon(IconName::ChevronRight)
                    .track_focus(&self.next_focus)
                    .disabled(!self.machine.can_continue() || self.busy)
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.on_next_pressed(cx);
                    })),
            )
    }

    fn step_content(&mut self, step: Step, cx: &mut Context<Self>) -> AnyElement {
        match step {
            Step::Welcome => self.welcome_step(cx),
            Step::Provider => self.provider_step(cx),
            Step::Model => self.model_step(cx),
            Step::Appearance => self.appearance_step(cx),
            Step::Permissions => self.permissions_step(cx),
            Step::Finish => self.finish_step(cx),
        }
    }

    fn step_heading(&self, title: &str, body: &str, theme: &Theme) -> AnyElement {
        v_flex()
            .gap_1()
            .child(
                div()
                    .text_2xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.to_string()),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(body.to_string()),
            )
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // Welcome (TS "profile" step)
    // -----------------------------------------------------------------------

    fn welcome_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("onboarding-welcome")
            .w_full()
            .max_w(px(480.0))
            .gap_4()
            .child(
                div()
                    .size(px(48.0))
                    .items_center()
                    .justify_center()
                    .rounded_2xl()
                    .bg(theme.accent.alpha(0.12))
                    .child(Icon::new(IconName::User).small().text_color(theme.accent)),
            )
            .child(self.step_heading(
                "What should Aiden call you?",
                "Your name is used only in Profile and model-facing personalization. This data stays on this device.",
                &theme,
            ))
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Name"),
                    )
                    .child(Input::new(&self.name_input)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .rounded_lg()
                    .bg(theme.muted)
                    .px_3()
                    .py_2p5()
                    .child(
                        Icon::new(IconName::CircleCheck)
                            .small()
                            .text_color(theme.accent),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("Stored privately on this Mac."),
                    ),
            )
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // Provider (TS "provider" step)
    // -----------------------------------------------------------------------

    fn provider_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();

        v_flex()
            .id("onboarding-provider")
            .w_full()
            .gap_4()
            .child(self.step_heading(
                "Add your first model provider",
                "Choose an API-key provider, ChatGPT sign-in, or a local/private model server.",
                &theme,
            ))
            .child(
                v_flex()
                    .w_full()
                    .gap_2p5()
                    .children(ProviderChoice::ALL.chunks(2).map(|row| {
                        h_flex()
                            .w_full()
                            .gap_2p5()
                            .children(row.iter().map(|choice| {
                                self.provider_card(
                                    *choice,
                                    *choice == self.machine.choice,
                                    &theme,
                                    cx,
                                )
                            }))
                    })),
            )
            .when(self.machine.choice.requires_key(), |el| {
                el.child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(if self.machine.defer_pi_setup {
                                    "Provider setup will open after onboarding. No key is stored in portable settings."
                                } else {
                                    "Continue with Aiden's encrypted, provider-bound setup after onboarding."
                                }),
                        )
                        .child(
                            Button::new("onboarding-defer-pi-provider-setup")
                                .primary()
                                .label(if self.machine.defer_pi_setup {
                                    "Setup queued"
                                } else {
                                    "Set up securely"
                                })
                                .disabled(self.busy || self.machine.defer_pi_setup)
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.machine.defer_pi_provider_setup();
                                    this.open_pi_provider_setup_on_complete = true;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when(self.machine.choice == ProviderChoice::ChatGpt, |el| {
                el.child(
                    h_flex()
                        .gap_3()
                        .items_center()
                        .child(
                            Button::new("onboarding-chatgpt-sign-in")
                                .primary()
                                .label(if self.machine.codex_configured {
                                    "Signed in"
                                } else {
                                    "Sign in with ChatGPT"
                                })
                                .disabled(self.busy || self.machine.codex_configured)
                                .loading(self.busy)
                                .on_click(cx.listener(|this, _event, window, cx| {
                                    this.start_codex_sign_in(window, cx);
                                })),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("A browser opens only after you choose Sign in."),
                        ),
                )
            })
            .into_any_element()
    }

    fn provider_card(
        &self,
        choice: ProviderChoice,
        selected: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .id(SharedString::from(
                format!("provider-{:?}", choice).to_ascii_lowercase(),
            ))
            .flex_1()
            .gap_1()
            .p_4()
            .rounded_lg()
            .border_1()
            .border_color(if selected { theme.accent } else { theme.border })
            .bg(if selected {
                theme.accent.alpha(0.10)
            } else {
                theme.popover
            })
            .when(
                crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .hover(|style| style.bg(theme.muted))
            .focusable()
            .tab_stop(true)
            .focus(|style| style.bg(theme.list_active).border_color(theme.ring))
            .on_key_down(|event: &gpui::KeyDownEvent, _window, cx| {
                if selection_card_consumes_key(event.keystroke.key.as_str()) {
                    cx.stop_propagation();
                }
            })
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.machine.choice = choice;
                this.machine.defer_pi_setup = false;
                this.open_pi_provider_setup_on_complete = false;
                cx.notify();
            }))
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(choice.title()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(choice.description()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .mt_1()
                    .child(choice.footnote()),
            )
    }

    // -----------------------------------------------------------------------
    // Model (port-only step; persists `modelSelection`)
    // -----------------------------------------------------------------------

    fn model_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let options = self.machine.model_options();
        let selected = self.machine.selected_model.clone();

        v_flex()
            .id("onboarding-model")
            .w_full()
            .max_w(px(520.0))
            .gap_4()
            .child(self.step_heading(
                "Choose your first model",
                "Aiden starts every chat with this model. You can refine providers and models later in Settings.",
                &theme,
            ))
            .when(options.is_empty(), |el| {
                el.child(
                    div()
                        .rounded_lg()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .px_4()
                        .py_3()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(
                            "No models discovered yet — models appear here once a provider reports \
                             its catalog. You can also pick a model later in Settings.",
                        ),
                )
            })
            .children(options.iter().map(|option| {
                let active = selected.as_deref() == Some(option.id.as_str());
                let id = option.id.clone();
                let click_id = id.clone();
                let is_default = option.is_default;
                h_flex()
                    .id(SharedString::from(format!("model-{}", id)))
                    .w_full()
                    .px_3()
                    .py_2p5()
                    .gap_2()
                    .items_center()
                    .rounded_lg()
                    .border_1()
                    .border_color(if active { theme.accent } else { theme.border })
                    .when(crate::services::appearance::pointer_cursors_enabled(cx), |el| el.cursor_pointer())
                    .hover(|style| style.bg(theme.muted))
                    .focusable()
                    .tab_stop(true)
                    .focus(|style| style.bg(theme.list_active).border_color(theme.ring))
                    .on_key_down(|event: &gpui::KeyDownEvent, _window, cx| {
                        if selection_card_consumes_key(event.keystroke.key.as_str()) {
                            cx.stop_propagation();
                        }
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.machine.set_model(Some(click_id.clone()));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(id),
                    )
                    .when(is_default, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Default"),
                        )
                    })
                    .when(active, |el| {
                        el.child(Icon::new(IconName::Check).small().text_color(theme.accent))
                    })
            }))
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // Appearance (port-only step; live preview via services::appearance)
    // -----------------------------------------------------------------------

    fn appearance_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let config = self.machine.appearance_config();
        let scheme =
            crate::services::appearance::resolve_scheme(config.mode, cx.window_appearance());
        let presets = theme_presets();

        v_flex()
            .id("onboarding-appearance")
            .w_full()
            .max_w(px(520.0))
            .gap_4()
            .child(self.step_heading(
                "Pick a look for Aiden",
                "Presets define the light and dark palettes. The preview updates live.",
                &theme,
            ))
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Theme mode"),
                    )
                    .child(
                        h_flex().w_full().gap_2().children(
                            [
                                (Mode::System, IconName::Palette),
                                (Mode::Light, IconName::Sun),
                                (Mode::Dark, IconName::Moon),
                            ]
                            .into_iter()
                            .map(|(mode, icon)| {
                                let active = config.mode == mode;
                                let mut button = Button::new(SharedString::from(
                                    format!("appearance-mode-{:?}", mode).to_ascii_lowercase(),
                                ))
                                .outline()
                                .small()
                                .icon(icon);
                                if active {
                                    button = button.primary();
                                }
                                button
                                    .label(match mode {
                                        Mode::System => "System",
                                        Mode::Light => "Light",
                                        Mode::Dark => "Dark",
                                    })
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        this.machine.set_mode(mode);
                                        this.preview_appearance(cx);
                                        cx.notify();
                                    }))
                            }),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Preset"),
                    )
                    .child(
                        v_flex()
                            .w_full()
                            .gap_2()
                            .children(presets.iter().map(|preset| {
                                let active = selection_matches(config.light.preset, preset.id);
                                let preset_id = preset.id;
                                let label = preset.label.clone();
                                let variant = get_preset_variant(preset_id, scheme);
                                let swatches = [
                                    variant.background.as_str(),
                                    variant.accent.as_str(),
                                    variant.foreground.as_str(),
                                ]
                                .into_iter()
                                .filter_map(hsla_from_hex)
                                .collect::<Vec<_>>();
                                h_flex()
                                    .id(SharedString::from(
                                        format!("appearance-preset-{:?}", preset_id)
                                            .to_ascii_lowercase(),
                                    ))
                                    .w_full()
                                    .px_3()
                                    .py_2p5()
                                    .gap_3()
                                    .items_center()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(if active { theme.accent } else { theme.border })
                                    .when(
                                        crate::services::appearance::pointer_cursors_enabled(cx),
                                        |el| el.cursor_pointer(),
                                    )
                                    .hover(|style| style.bg(theme.muted))
                                    .focusable()
                                    .tab_stop(true)
                                    .focus(|style| {
                                        style.bg(theme.list_active).border_color(theme.ring)
                                    })
                                    .on_key_down(|event: &gpui::KeyDownEvent, _window, cx| {
                                        if selection_card_consumes_key(event.keystroke.key.as_str())
                                        {
                                            cx.stop_propagation();
                                        }
                                    })
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        this.machine.set_preset(preset_id);
                                        this.preview_appearance(cx);
                                        cx.notify();
                                    }))
                                    .child(h_flex().gap_0p5().children(
                                        swatches.into_iter().map(|color| {
                                            div().size(px(14.0)).rounded_sm().bg(color)
                                        }),
                                    ))
                                    .child(
                                        div()
                                            .flex_1()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(label),
                                    )
                                    .when(active, |el| {
                                        el.child(
                                            Icon::new(IconName::Check)
                                                .small()
                                                .text_color(theme.accent),
                                        )
                                    })
                            })),
                    ),
            )
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // Permissions (port-only step; copy ported from the TS sources)
    // -----------------------------------------------------------------------

    fn permissions_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("onboarding-permissions")
            .w_full()
            .max_w(px(560.0))
            .gap_4()
            .child(self.step_heading(
                "Privacy by default",
                "What Aiden can access, and what stays on this Mac.",
                &theme,
            ))
            .child(
                v_flex()
                    .w_full()
                    .gap_2p5()
                    .children(PERMISSION_ROWS.into_iter().map(|(title, body)| {
                        v_flex()
                            .id(SharedString::from(format!(
                                "permission-{}",
                                title.to_ascii_lowercase().replace(' ', "-")
                            )))
                            .gap_0p5()
                            .rounded_lg()
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.popover)
                            .px_4()
                            .py_3()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(title.to_string()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(body.to_string()),
                            )
                    })),
            )
            .when_some(
                self.pi_provider_setup_target(),
                |el, (_id, label, _revision)| {
                    el.child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                format!("Want to rotate or review {label}'s encrypted credential?"),
                            ))
                            .child(
                                Button::new("onboarding-open-provider-setup")
                                    .outline()
                                    .label("Open provider setup")
                                    .disabled(self.busy)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.finish_with_pi_provider_setup(cx);
                                    })),
                            ),
                    )
                },
            )
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // Finish (TS "tour" step + the first-run marker write)
    // -----------------------------------------------------------------------

    fn finish_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();

        v_flex()
            .id("onboarding-finish")
            .w_full()
            .max_w(px(640.0))
            .gap_4()
            .child(self.step_heading(
                "Aiden is ready",
                "A quick tour of what you can explore next.",
                &theme,
            ))
            .child(
                h_flex()
                    .w_full()
                    .flex_wrap()
                    .justify_center()
                    .gap_3()
                    .children(TOUR_FEATURES.iter().map(|feature| {
                        let bytes = feature.image;
                        v_flex()
                            .id(SharedString::from(format!("feature-{}", feature.id)))
                            .h(px(190.0))
                            .min_w(px(180.0))
                            .max_w(px(200.0))
                            .flex_1()
                            .gap_1p5()
                            .rounded_lg()
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.popover)
                            .px_3()
                            .py_3()
                            .tab_stop(true)
                            .hover(|style| style.bg(theme.muted).border_color(theme.accent))
                            .focus(|style| style.bg(theme.list_active).border_color(theme.ring))
                            .on_key_down(|event: &gpui::KeyDownEvent, _window, cx| {
                                if tour_tile_consumes_key(event.keystroke.key.as_str()) {
                                    cx.stop_propagation();
                                }
                            })
                            .child(
                                h_flex().w_full().justify_center().child(
                                    div().size(px(92.0)).rounded_lg().overflow_hidden().child(
                                        img(Arc::new(Image::from_bytes(
                                            ImageFormat::Png,
                                            bytes.to_vec(),
                                        )))
                                        .size_full(),
                                    ),
                                ),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(feature.title.to_string()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(feature.description.to_string()),
                            )
                    })),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{
        selection_card_consumes_key, tour_tile_consumes_key, PERMISSION_ROWS, TOUR_FEATURES,
    };

    #[test]
    fn permissions_disclose_exact_foreground_subagent_boundary() {
        let (_, copy) = PERMISSION_ROWS
            .iter()
            .find(|(title, _)| *title == "Delegated workspace tasks")
            .unwrap();
        assert!(copy.contains("selected provider"));
        assert!(copy.contains("workspace permission"));
        assert!(copy.contains("fresh or fork context projection"));
        assert!(copy.contains("bounded workspace file or tool results"));
        assert!(copy.contains("every write or edit pauses for Allow once or Deny"));
        assert!(copy.contains("per-command Allow once or Deny"));
        assert!(copy.contains("unsandboxed workspace and host access"));
        assert!(copy.contains("scrubbed environment"));
        assert!(copy.contains("arbitrary network and process effects"));
        assert!(copy.contains("detached descendants may outlive cancellation"));
        assert!(copy.contains("there is no rollback"));
        assert!(copy.contains("generation start"));
        assert!(copy.contains("tools-list request"));
        assert!(copy.contains("Every exact server/tool call"));
        assert!(copy.contains("credentials remain host-owned"));
        assert!(copy.contains("configured server controls the actual effect"));
        assert!(copy.contains("Mutating calls show their effect profile"));
        assert!(copy.contains("uncertain result is never retried automatically"));
        assert!(copy.contains("Nested and background subagents remain unavailable"));
    }

    #[test]
    fn every_advertised_tour_feature_has_a_bounded_square_rgba_png() {
        assert_eq!(TOUR_FEATURES.len(), 6);

        let mut ids = BTreeSet::new();
        for feature in &TOUR_FEATURES {
            assert!(ids.insert(feature.id), "duplicate tile id: {}", feature.id);
            assert!(!feature.title.trim().is_empty());
            assert!(!feature.description.trim().is_empty());
            assert!(!feature.description.contains("Hover any tile"));

            let png = feature.image;
            assert!(png.len() < 600_000, "{} asset is oversized", feature.id);
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{} signature", feature.id);
            assert_eq!(&png[12..16], b"IHDR", "{} IHDR", feature.id);
            assert_eq!(
                u32::from_be_bytes(png[16..20].try_into().unwrap()),
                1024,
                "{} width",
                feature.id
            );
            assert_eq!(
                u32::from_be_bytes(png[20..24].try_into().unwrap()),
                1024,
                "{} height",
                feature.id
            );
            assert_eq!(png[24], 8, "{} bit depth", feature.id);
            assert_eq!(png[25], 6, "{} must be RGBA", feature.id);
        }

        assert_eq!(ids.len(), TOUR_FEATURES.len());
    }

    #[test]
    fn informational_tour_tiles_contain_activation_keys() {
        assert!(tour_tile_consumes_key("enter"));
        assert!(tour_tile_consumes_key("space"));
        assert!(!tour_tile_consumes_key("tab"));
        assert!(!tour_tile_consumes_key("escape"));
    }

    #[test]
    fn selection_cards_consume_enter_and_space_without_advancing_onboarding() {
        assert!(selection_card_consumes_key("enter"));
        assert!(selection_card_consumes_key("space"));
        assert!(!selection_card_consumes_key("tab"));
        assert!(!selection_card_consumes_key("escape"));
    }

    #[test]
    fn onboarding_selection_cards_keep_native_focus_and_keyboard_click_contract() {
        let source = include_str!("view.rs");
        for marker in ["fn provider_card", "fn model_step", "fn appearance_step"] {
            let block = source
                .split_once(marker)
                .and_then(|(_, rest)| rest.split_once("fn "))
                .map(|(body, _)| body)
                .unwrap_or(source);
            assert!(block.contains(".focusable()"), "{marker} must be focusable");
            assert!(
                block.contains(".tab_stop(true)"),
                "{marker} must be keyboard reachable"
            );
            assert!(
                block.contains("selection_card_consumes_key"),
                "{marker} must consume Enter/Space"
            );
        }
    }
}
