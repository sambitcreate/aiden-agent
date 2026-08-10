//! Appearance settings.
//!
//! The editor deliberately keeps light and dark variants independent. Every
//! safe edit is routed through `ChatService`, the one authority that previews
//! and persists appearance. Native-only preferences remain visibly pending
//! until a platform bridge is injected; this UI never pretends they applied.

use aiden_core::appearance::{
    get_preset_variant, parse_theme_variant_json, serialize_theme_variant, theme_presets,
    AppearanceConfig, CodeFont, DiffMarkers, DockIcon, Mode, PresetId, ReduceMotion, Scheme,
    Selection, UiFont,
};
use gpui::{
    div, img, prelude::FluentBuilder as _, px, AppContext as _, Context, FontWeight, Image,
    ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    radio::Radio,
    select::{Select, SelectEvent, SelectState},
    slider::{Slider, SliderEvent, SliderState},
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, PixelsExt as _, Sizable as _,
};
use std::{io::Read, sync::Arc};

use super::{SettingsServices, SettingsView};

const AIDEN_ICON_PNG: &[u8] = include_bytes!("../../../../resources/app-icon.png");
const MONOCHROME_ICON_PNG: &[u8] = include_bytes!("../../../../resources/app-icon-monochrome.png");
const MODE_PREVIEW_ASPECT_RATIO: f32 = 1.52;

fn preset_activation_key(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

fn rove_index(current: usize, key: &str, len: usize) -> Option<usize> {
    match key {
        "left" | "up" => Some((current + len - 1) % len),
        "right" | "down" => Some((current + 1) % len),
        "home" => Some(0),
        "end" => Some(len - 1),
        _ => None,
    }
}

fn focus_button(id: SharedString, window: &mut Window, cx: &mut gpui::App) {
    let focus = window
        .use_keyed_state(id, cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    focus.focus(window);
}

fn mode_preview(
    mode: Mode,
    config: &AppearanceConfig,
    theme: &gpui_component::theme::Theme,
) -> impl IntoElement {
    let variant = match mode {
        Mode::Dark => &config.dark,
        Mode::System | Mode::Light => &config.light,
    };
    let canvas = hsla_from_hex(&variant.background).unwrap_or(theme.background);
    let ink = hsla_from_hex(&variant.foreground).unwrap_or(theme.foreground);
    let accent = hsla_from_hex(&variant.accent).unwrap_or(theme.accent);
    let system_dark_canvas = hsla_from_hex(&config.dark.background).unwrap_or(theme.background);
    let system_dark_ink = hsla_from_hex(&config.dark.foreground).unwrap_or(theme.foreground);
    let system_dark_accent = hsla_from_hex(&config.dark.accent).unwrap_or(theme.accent);
    let preview_height = 76.0;
    v_flex()
        .relative()
        .w_full()
        .h(px(preview_height))
        .min_w(px(preview_height * MODE_PREVIEW_ASPECT_RATIO))
        .rounded_lg()
        .overflow_hidden()
        .border_1()
        .border_color(theme.border)
        .bg(canvas)
        .child(
            h_flex()
                .h(px(16.))
                .px_1p5()
                .gap_1()
                .bg(accent.alpha(0.16))
                .children((0..3).map(|_| div().size(px(4.)).rounded_full().bg(accent))),
        )
        .child(
            h_flex()
                .flex_1()
                .child(div().w(px(28.)).h_full().bg(accent.alpha(0.10)))
                .child(
                    v_flex()
                        .flex_1()
                        .p_2()
                        .gap_1()
                        .child(div().h(px(4.)).w_3_4().rounded_full().bg(ink.alpha(0.34)))
                        .child(div().h(px(4.)).w_1_2().rounded_full().bg(ink.alpha(0.22)))
                        .child(div().h(px(4.)).w_2_3().rounded_full().bg(ink.alpha(0.22))),
                ),
        )
        .when(mode == Mode::System, |el| {
            el.child(
                v_flex()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom_0()
                    .w_1_2()
                    .bg(system_dark_canvas)
                    .border_l_1()
                    .border_color(theme.border)
                    .child(
                        h_flex()
                            .h(px(16.))
                            .px_1p5()
                            .gap_1()
                            .bg(system_dark_accent.alpha(0.16))
                            .children(
                                (0..3).map(|_| {
                                    div().size(px(4.)).rounded_full().bg(system_dark_accent)
                                }),
                            ),
                    )
                    .child(
                        h_flex()
                            .flex_1()
                            .child(div().w(px(14.)).h_full().bg(system_dark_accent.alpha(0.10)))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .p_2()
                                    .gap_1()
                                    .child(
                                        div()
                                            .h(px(4.))
                                            .w_3_4()
                                            .rounded_full()
                                            .bg(system_dark_ink.alpha(0.34)),
                                    )
                                    .child(
                                        div()
                                            .h(px(4.))
                                            .w_1_2()
                                            .rounded_full()
                                            .bg(system_dark_ink.alpha(0.22)),
                                    ),
                            ),
                    ),
            )
        })
}

/// The Appearance panel follows the renderer's two compact breakpoints. Keep
/// this pure because a window can cross either threshold while the retained
/// Settings entity remains alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppearanceLayout {
    Desktop,
    StackHeaders,
    StackPanes,
}

fn appearance_layout_for_width(width: f32) -> AppearanceLayout {
    if width <= 520.0 {
        AppearanceLayout::StackPanes
    } else if width <= 620.0 {
        AppearanceLayout::StackHeaders
    } else {
        AppearanceLayout::Desktop
    }
}

/// Parse a `#RRGGBB` token hex into an `Hsla` for swatch rendering. The hex
/// comes from the appearance tokens (`aiden_core`), never hardcoded here.
fn hsla_from_hex(hex: &str) -> Option<gpui::Hsla> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some(gpui::rgba(value).into())
}

/// Whether a persisted variant selection matches a preset id.
fn selection_matches(selection: Selection, preset: PresetId) -> bool {
    matches!(
        (selection, preset),
        (Selection::Aiden, PresetId::Aiden)
            | (Selection::Slate, PresetId::Slate)
            | (Selection::Berry, PresetId::Berry)
            | (Selection::Moss, PresetId::Moss)
    )
}

pub struct AppearanceState {
    /// Scheme currently being edited. This is intentionally independent from
    /// the effective system scheme so a user can prepare the other appearance.
    editing_scheme: Scheme,
    color_inputs: Vec<ColorInputs>,
    invalid_color: Option<String>,
    feedback: Option<String>,
    /// A complete but not-yet-safe draft. It is intentionally never sent to
    /// the live service or durable store, which lets related fields be fixed
    /// together (for example foreground and background contrast).
    unsafe_draft: Option<AppearanceConfig>,
    contrast_sliders: Vec<(Scheme, gpui::Entity<SliderState>)>,
    ui_font_selects: Vec<(Scheme, gpui::Entity<SelectState<Vec<&'static str>>>)>,
    code_font_selects: Vec<(Scheme, gpui::Entity<SelectState<Vec<&'static str>>>)>,
    import_generation: u64,
    _subscriptions: Vec<gpui::Subscription>,
}

struct ColorInputs {
    scheme: Scheme,
    accent: gpui::Entity<InputState>,
    background: gpui::Entity<InputState>,
    foreground: gpui::Entity<InputState>,
}

#[derive(Clone, Copy)]
enum TextSizeKind {
    Ui,
    Code,
}

#[derive(Clone, Copy)]
struct NumberControlArgs {
    label: &'static str,
    id: &'static str,
    value: u8,
    min: u8,
    max: u8,
    kind: TextSizeKind,
}

impl Default for AppearanceState {
    fn default() -> Self {
        Self {
            editing_scheme: Scheme::Light,
            color_inputs: Vec::new(),
            invalid_color: None,
            feedback: None,
            unsafe_draft: None,
            contrast_sliders: Vec::new(),
            ui_font_selects: Vec::new(),
            code_font_selects: Vec::new(),
            import_generation: 0,
            _subscriptions: Vec::new(),
        }
    }
}

impl AppearanceState {
    fn ensure_editor_controls(
        &mut self,
        scheme: Scheme,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
        config: &AppearanceConfig,
    ) {
        if self
            .color_inputs
            .iter()
            .any(|inputs| inputs.scheme == scheme)
        {
            return;
        }
        let variant = match scheme {
            Scheme::Light => &config.light,
            Scheme::Dark => &config.dark,
        };
        let accent_value = variant.accent.clone();
        let accent = cx.new(|cx| InputState::new(window, cx).default_value(accent_value));
        let background_value = variant.background.clone();
        let background = cx.new(|cx| InputState::new(window, cx).default_value(background_value));
        let foreground_value = variant.foreground.clone();
        let foreground = cx.new(|cx| InputState::new(window, cx).default_value(foreground_value));
        for (input, field) in [
            (accent.clone(), 0_u8),
            (background.clone(), 1),
            (foreground.clone(), 2),
        ] {
            self._subscriptions.push(cx.subscribe_in(
                &input,
                window,
                move |this, source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.appearance.set_color(
                            scheme,
                            field,
                            source.read(cx).value().to_string(),
                            &this.services,
                            cx,
                        );
                    }
                },
            ));
        }
        self.color_inputs.push(ColorInputs {
            scheme,
            accent,
            background,
            foreground,
        });
        let contrast = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(100.)
                .step(1.)
                .default_value(variant.contrast as f32)
        });
        self._subscriptions.push(cx.subscribe_in(
            &contrast,
            window,
            move |this, source, event, _window, cx| {
                if matches!(event, SliderEvent::Change(_)) {
                    let value = source.read(cx).value().end().round().clamp(0., 100.) as i32;
                    this.appearance
                        .set_contrast(scheme, value, &this.services, cx);
                }
            },
        ));
        self.contrast_sliders.push((scheme, contrast));
        let ui_items = vec!["System", "Rounded", "Humanist"];
        let ui_index = match variant.ui_font {
            UiFont::System => 0,
            UiFont::Rounded => 1,
            UiFont::Humanist => 2,
        };
        let ui_select = cx.new(|cx| {
            SelectState::new(
                ui_items,
                Some(gpui_component::IndexPath::default().row(ui_index)),
                window,
                cx,
            )
        });
        self._subscriptions.push(cx.subscribe_in(
            &ui_select,
            window,
            move |this, _, event, _window, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                let font = match *value {
                    "Rounded" => UiFont::Rounded,
                    "Humanist" => UiFont::Humanist,
                    _ => UiFont::System,
                };
                this.appearance
                    .set_ui_font(scheme, font, &this.services, cx);
            },
        ));
        self.ui_font_selects.push((scheme, ui_select));
        let code_items = vec!["SF Mono", "Menlo", "Monaco"];
        let code_index = match variant.code_font {
            CodeFont::SfMono => 0,
            CodeFont::Menlo => 1,
            CodeFont::Monaco => 2,
        };
        let code_select = cx.new(|cx| {
            SelectState::new(
                code_items,
                Some(gpui_component::IndexPath::default().row(code_index)),
                window,
                cx,
            )
        });
        self._subscriptions.push(cx.subscribe_in(
            &code_select,
            window,
            move |this, _, event, _window, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                let font = match *value {
                    "Menlo" => CodeFont::Menlo,
                    "Monaco" => CodeFont::Monaco,
                    _ => CodeFont::SfMono,
                };
                this.appearance
                    .set_code_font(scheme, font, &this.services, cx);
            },
        ));
        self.code_font_selects.push((scheme, code_select));
    }

    fn set_color(
        &mut self,
        scheme: Scheme,
        field: u8,
        value: String,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.config(services, cx);
        let variant = match scheme {
            Scheme::Light => &mut config.light,
            Scheme::Dark => &mut config.dark,
        };
        match field {
            0 => variant.accent = value.to_ascii_uppercase(),
            1 => variant.background = value.to_ascii_uppercase(),
            _ => variant.foreground = value.to_ascii_uppercase(),
        }
        if !aiden_core::appearance::is_hex_color(&value) {
            self.unsafe_draft = Some(config);
            self.invalid_color = Some("Use a #RRGGBB color.".into());
            cx.notify();
            return;
        }
        self.mutate(config, false, services, cx);
    }

    fn edit_variant(&self, services: &SettingsServices, cx: &gpui::App) -> AppearanceConfig {
        self.config(services, cx)
    }
    fn set_ui_font(
        &mut self,
        scheme: Scheme,
        font: UiFont,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        let variant = match scheme {
            Scheme::Light => &mut config.light,
            Scheme::Dark => &mut config.dark,
        };
        variant.ui_font = font;
        self.mutate(config, false, services, cx);
    }
    fn set_code_font(
        &mut self,
        scheme: Scheme,
        font: CodeFont,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        let variant = match scheme {
            Scheme::Light => &mut config.light,
            Scheme::Dark => &mut config.dark,
        };
        variant.code_font = font;
        self.mutate(config, false, services, cx);
    }
    fn toggle_sidebar(
        &mut self,
        scheme: Scheme,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        let variant = match scheme {
            Scheme::Light => &mut config.light,
            Scheme::Dark => &mut config.dark,
        };
        variant.translucent_sidebar = !variant.translucent_sidebar;
        self.mutate(config, false, services, cx);
    }
    fn set_contrast(
        &mut self,
        scheme: Scheme,
        value: i32,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        let variant = match scheme {
            Scheme::Light => &mut config.light,
            Scheme::Dark => &mut config.dark,
        };
        variant.contrast = value.clamp(0, 100);
        self.mutate(config, false, services, cx);
    }
    fn toggle_pointer(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let mut config = self.edit_variant(services, cx);
        config.pointer_cursors = !config.pointer_cursors;
        self.mutate(config, false, services, cx);
    }
    fn set_diff_markers(
        &mut self,
        value: DiffMarkers,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        config.diff_markers = value;
        self.mutate(config, false, services, cx);
    }
    fn adjust_ui_size(
        &mut self,
        amount: i8,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        config.ui_font_size =
            (i16::from(config.ui_font_size) + i16::from(amount)).clamp(12, 18) as u8;
        self.mutate(config, false, services, cx);
    }
    fn adjust_code_size(
        &mut self,
        amount: i8,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.edit_variant(services, cx);
        config.code_font_size =
            (i16::from(config.code_font_size) + i16::from(amount)).clamp(10, 18) as u8;
        self.mutate(config, false, services, cx);
    }
    fn set_dock_icon(
        &mut self,
        dock_icon: DockIcon,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.config(services, cx);
        if config.dock_icon != dock_icon {
            config.dock_icon = dock_icon;
            self.mutate(config, false, services, cx);
        }
    }
    fn copy_theme(
        &mut self,
        scheme: Scheme,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let config = self.config(services, cx);
        let variant = match scheme {
            Scheme::Light => &config.light,
            Scheme::Dark => &config.dark,
        };
        if let Ok(text) = serialize_theme_variant(variant, scheme) {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            self.feedback = Some("Theme JSON copied to the clipboard.".into());
            cx.notify();
        }
    }
    fn import_theme(
        &mut self,
        scheme: Scheme,
        window: &mut Window,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        self.import_generation = self.import_generation.saturating_add(1);
        let generation = self.import_generation;
        let services = services.clone();
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import theme JSON".into()),
        });
        cx.spawn(async move |this, cx| {
            let Some(path) = (match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            }) else {
                return;
            };
            let result = cx
                .background_spawn(async move {
                    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
                    let mut bytes = Vec::new();
                    file.by_ref()
                        .take(65_537)
                        .read_to_end(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    if bytes.len() > 65_536 {
                        return Err("Theme files must be 64 KiB or smaller.".into());
                    }
                    let text = String::from_utf8(bytes)
                        .map_err(|_| "The selected file is not UTF-8 JSON.".to_string())?;
                    parse_theme_variant_json(&text, scheme)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.appearance.import_generation != generation {
                    return;
                }
                match result {
                    Ok(variant) => {
                        let mut config = this.appearance.config(&services, cx);
                        match scheme {
                            Scheme::Light => config.light = variant,
                            Scheme::Dark => config.dark = variant,
                        };
                        this.appearance.invalid_color = None;
                        this.appearance.mutate(config, false, &services, cx);
                        this.appearance.feedback = Some("Theme JSON imported and applied.".into());
                    }
                    Err(error) => {
                        this.appearance.invalid_color = Some(error);
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
        let _ = window;
    }
    /// Read the persisted appearance config and apply it live.
    pub fn hydrate(
        &mut self,
        _settings: &serde_json::Map<String, serde_json::Value>,
        _cx: &mut gpui::App,
    ) {
    }

    fn config(&self, services: &SettingsServices, cx: &gpui::App) -> AppearanceConfig {
        self.unsafe_draft.clone().unwrap_or_else(|| {
            services
                .appearance_service
                .read(cx)
                .appearance_for_editing()
                .clone()
        })
    }

    fn save_failure(&self, services: &SettingsServices, cx: &gpui::App) -> Option<String> {
        services
            .appearance_service
            .read(cx)
            .appearance_save_failure()
            .map(str::to_string)
    }

    fn variant<'a>(
        &self,
        config: &'a AppearanceConfig,
    ) -> &'a aiden_core::appearance::ThemeVariantConfig {
        match self.editing_scheme {
            Scheme::Light => &config.light,
            Scheme::Dark => &config.dark,
        }
    }
}

impl SettingsView {
    /// The complete durable appearance surface. Native Dock controls are
    /// intentionally marked unavailable until the injected bridge exists.
    pub(crate) fn appearance_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // Cloned (not borrowed) so `theme` stays usable after the
        // `cx`-capturing row/button closures below.
        let theme = cx.theme().clone();
        let config = self.appearance.config(&self.services, cx);
        let native_supported = self
            .services
            .appearance_service
            .read(cx)
            .native_appearance_supported();
        let layout = appearance_layout_for_width(window.viewport_size().width.as_f32());
        let pointer = crate::services::appearance::pointer_cursors_enabled(cx);
        let presets = theme_presets();
        let editing_scheme = self.appearance.editing_scheme;
        let variant = self.appearance.variant(&config).clone();
        self.appearance
            .ensure_editor_controls(Scheme::Light, window, cx, &config);
        self.appearance
            .ensure_editor_controls(Scheme::Dark, window, cx, &config);

        v_flex()
            .id("appearance-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Appearance"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                            "Shape Aiden's look. Changes apply live and are saved automatically.",
                        ),
                    ),
            )
            .when_some(
                self.appearance.save_failure(&self.services, cx),
                |el, message| {
                    el.child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .child(div().text_sm().text_color(theme.danger).child(message))
                            .child(
                                Button::new("appearance-retry-save")
                                    .ghost()
                                    .small()
                                    .label("Retry save")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.services
                                            .appearance_service
                                            .update(cx, |service, cx| {
                                                service.retry_appearance_save(cx)
                                            });
                                    })),
                            ),
                    )
                },
            )
            .when_some(
                self.services.appearance_service.read(cx).appearance_native_failure().map(str::to_string),
                |el, message| {
                    el.child(h_flex().items_center().justify_between().gap_3()
                        .child(div().text_sm().text_color(theme.danger).child(format!("Native appearance: {message}")))
                        .child(Button::new("appearance-retry-native").ghost().small().label("Retry").on_click(cx.listener(|this, _, _, cx| {
                            this.services.appearance_service.update(cx, |service, cx| service.retry_native_appearance(cx));
                        }))))
                },
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Theme mode"),
                    )
                    .child(
                        h_flex().w_full().gap(px(12.)).when(layout == AppearanceLayout::StackPanes, |el| el.flex_col()).children(
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
                                .outline();
                                if active {
                                    button = button.primary();
                                }
                                button
                                    .flex_1()
                                    .flex_col()
                                    .gap_2()
                                    .tab_stop(active)
                                    .when(pointer, |el| el.cursor_pointer())
                                    // The renderer's preview cards use a 1.52
                                    // aspect ratio; this is the matching
                                    // compact-height floor for the retained
                                    // GPUI grid at its 672 px content cap.
                                    .min_h(px(126.))
                                    .child(mode_preview(mode, &config, &theme))
                                    .child(h_flex().gap_1().items_center().child(Icon::new(icon).small()).child(match mode {
                                        Mode::System => "System",
                                        Mode::Light => "Light",
                                        Mode::Dark => "Dark",
                                    }))
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        this.appearance.set_mode(mode, &this.services, cx);
                                    }))
                                    .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                                        let modes = [Mode::System, Mode::Light, Mode::Dark];
                                        let current = modes.iter().position(|candidate| *candidate == mode).unwrap_or(0);
                                        if let Some(next) = rove_index(current, event.keystroke.key.as_str(), modes.len()) { this.appearance.set_mode(modes[next], &this.services, cx); focus_button(SharedString::from(format!("appearance-mode-{:?}", modes[next]).to_ascii_lowercase()), window, cx); cx.stop_propagation(); }
                                    }))
                            }),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_3()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Theme editor"),
                    )
                    .child(self.scheme_overview_cards(&config, layout, cx))
                    .child(h_flex().w_full().gap_2().when(layout != AppearanceLayout::Desktop, |el| el.flex_col()).children([Scheme::Light, Scheme::Dark].into_iter().map(|scheme| {
                        let active = editing_scheme == scheme;
                        let mut button = Button::new(SharedString::from(format!("appearance-edit-{scheme:?}").to_ascii_lowercase())).outline().small();
                        if active { button = button.primary(); }
                        button.label(match scheme { Scheme::Light => "Light", Scheme::Dark => "Dark" })
                            .on_click(cx.listener(move |this, _, _, cx| { this.appearance.editing_scheme = scheme; cx.notify(); }))
                    })))
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Light and Dark remain separate drafts. Safe changes preview immediately.",
                    ))
                    .child(
                        h_flex()
                            .w_full()
                            .gap(px(12.))
                            .when(layout == AppearanceLayout::StackPanes, |el| el.flex_col())
                            .children(presets.iter().map(|preset| {
                                let active = selection_matches(variant.preset, preset.id);
                                self.preset_row(
                                    preset.id,
                                    &preset.label,
                                    editing_scheme,
                                    active,
                                    window,
                                    cx,
                                )
                            })),
                    )
                    .child(self.theme_code_panes(&config, &theme, layout)),
            )
            .child(h_flex().w_full().gap_3().when(layout == AppearanceLayout::StackPanes, |el| el.flex_col()).child(self.variant_controls(Scheme::Light, &config, &theme, window, cx)).child(self.variant_controls(Scheme::Dark, &config, &theme, window, cx)))
            .child(self.preference_controls(&config, &theme, cx))
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Reduced motion"),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Reduce or remove motion throughout the app. System follows the \
                             macOS accessibility setting (Reduce Motion in System Settings → \
                             Accessibility → Display).",
                    ))
                    .child(
                        h_flex().w_full().gap_2().children(
                            [ReduceMotion::System, ReduceMotion::On, ReduceMotion::Off]
                                .into_iter()
                                .map(|preference| {
                                    let active = config.reduce_motion == preference;
                                    let mut button = Button::new(SharedString::from(
                                        format!("reduce-motion-{:?}", preference)
                                            .to_ascii_lowercase(),
                                    ))
                                    .outline()
                                    .small();
                                    if active {
                                        button = button.primary();
                                    }
                                    // "System" shows the live OS probe so the
                                    // choice is never a mystery.
                                    let label: &str =
                                        match (preference, crate::services::appearance::current_system_reduced_motion(cx)) {
                                            (ReduceMotion::System, true) => "System (reduced)",
                                            (ReduceMotion::System, false) => "System",
                                            (ReduceMotion::On, _) => "On",
                                            (ReduceMotion::Off, _) => "Off",
                                        };
                                    button.tab_stop(active).when(pointer, |el| el.cursor_pointer()).label(label).on_click(cx.listener(
                                        move |this, _event, _window, cx| {
                                            this.appearance.set_reduce_motion(
                                                preference,
                                                &this.services,
                                                cx,
                                            );
                                        },
                                    )).on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                                        let choices = [ReduceMotion::System, ReduceMotion::On, ReduceMotion::Off];
                                        let current = choices.iter().position(|candidate| *candidate == preference).unwrap_or(0);
                                        if let Some(next) = rove_index(current, event.keystroke.key.as_str(), choices.len()) {
                                            this.appearance.set_reduce_motion(choices[next], &this.services, cx);
                                            focus_button(SharedString::from(format!("reduce-motion-{:?}", choices[next]).to_ascii_lowercase()), window, cx);
                                            cx.stop_propagation();
                                        }
                                    }))
                                }),
                        ),
                    ),
            )
            .child(
                v_flex().w_full().gap_2().mt_2()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Dock icon"))
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        if native_supported {
                            "Changes apply to the macOS Dock immediately. If applying fails, Aiden keeps the last confirmed native state and offers Retry."
                        } else {
                            "Dock icon changes are unavailable on this platform; the saved choice remains pending for macOS."
                        },
                    ))
                    .child(h_flex().gap_2().children([DockIcon::Aiden, DockIcon::Monochrome].into_iter().map(|dock_icon| {
                        let active = config.dock_icon == dock_icon;
                        let mut button = Button::new(SharedString::from(format!("appearance-dock-{dock_icon:?}").to_ascii_lowercase())).outline().small();
                        if active { button = button.primary(); }
                        let bytes = match dock_icon { DockIcon::Aiden => AIDEN_ICON_PNG, DockIcon::Monochrome => MONOCHROME_ICON_PNG };
                        button.tab_stop(active && native_supported).disabled(!native_supported).when(pointer && native_supported, |el| el.cursor_pointer()).child(h_flex().gap_2().items_center().child(div().size(px(32.)).rounded_lg().overflow_hidden().child(img(Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec()))).size_full())).child(match dock_icon { DockIcon::Aiden => "Aiden", DockIcon::Monochrome => "Monochrome" })).on_click(cx.listener(move |this, _, _, cx| this.appearance.set_dock_icon(dock_icon, &this.services, cx))).on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                            let icons = [DockIcon::Aiden, DockIcon::Monochrome];
                            let current = icons.iter().position(|candidate| *candidate == dock_icon).unwrap_or(0);
                            if let Some(next) = rove_index(current, event.keystroke.key.as_str(), icons.len()) { this.appearance.set_dock_icon(icons[next], &this.services, cx); focus_button(SharedString::from(format!("appearance-dock-{:?}", icons[next]).to_ascii_lowercase()), window, cx); cx.stop_propagation(); }
                        }))
                    }))),
            )
    }

    fn variant_controls(
        &self,
        scheme: Scheme,
        config: &AppearanceConfig,
        theme: &gpui_component::theme::Theme,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) -> impl IntoElement {
        let variant = match scheme {
            Scheme::Light => &config.light,
            Scheme::Dark => &config.dark,
        };
        let inputs = self
            .appearance
            .color_inputs
            .iter()
            .find(|inputs| inputs.scheme == scheme);
        let stacked = appearance_layout_for_width(window.viewport_size().width.as_f32())
            == AppearanceLayout::StackPanes;
        let color_preview =
            |label: &'static str, color: &str, input: Option<&gpui::Entity<InputState>>| {
                let input_for_action = input.cloned();
                let swatch_id = SharedString::from(
                    format!("appearance-{scheme:?}-{label}-color")
                        .to_ascii_lowercase()
                        .replace(' ', "-"),
                );
                h_flex()
                    .when(stacked, |el| el.flex_col().items_start())
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .min_h(px(52.))
                    .child(div().text_sm().child(label))
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                Button::new(swatch_id)
                                    .small()
                                    .outline()
                                    .label("Edit")
                                    .disabled(input_for_action.is_none())
                                    .child(
                                        div()
                                            .size(px(20.))
                                            .rounded_sm()
                                            .bg(hsla_from_hex(color).unwrap_or(theme.border)),
                                    )
                                    .on_click(move |_, window, cx| {
                                        if let Some(input) = &input_for_action {
                                            input.update(cx, |input, cx| input.focus(window, cx));
                                        }
                                    }),
                            )
                            .child(match input {
                                Some(input) => Input::new(input).small().into_any_element(),
                                None => div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(color.to_string())
                                    .into_any_element(),
                            }),
                    )
            };
        v_flex().w_full().gap_2().p_3().rounded(px(16.)).border_1().border_color(theme.border)
            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(format!("{} palette", match scheme { Scheme::Light => "Light", Scheme::Dark => "Dark" })))
            .child(color_preview("Accent", &variant.accent, inputs.map(|i| &i.accent)))
            .child(color_preview("Background", &variant.background, inputs.map(|i| &i.background)))
            .child(color_preview("Foreground", &variant.foreground, inputs.map(|i| &i.foreground)))
            .when_some(self.appearance.invalid_color.clone(), |el, error| el.child(div().text_xs().text_color(theme.danger).child(error)))
            .when_some(self.appearance.feedback.clone(), |el, feedback| el.child(div().text_xs().text_color(theme.success).child(feedback)))
            .child(div().text_xs().text_color(theme.muted_foreground).child("Enter #RRGGBB values directly or import a theme file. Malformed or unsafe colors are never previewed or saved."))
            .child(h_flex().items_center().justify_between().gap_3().child(div().text_sm().child("UI font")).when_some(self.appearance.ui_font_selects.iter().find(|(candidate, _)| *candidate == scheme).map(|(_, state)| state.clone()), |el, state| el.child(Select::new(&state).small().w(px(150.)))))
            .child(h_flex().items_center().justify_between().gap_3().child(div().text_sm().child("Code font")).when_some(self.appearance.code_font_selects.iter().find(|(candidate, _)| *candidate == scheme).map(|(_, state)| state.clone()), |el, state| el.child(Select::new(&state).small().w(px(150.)))))
            .child(h_flex().items_center().justify_between().child(div().text_sm().child("Sidebar translucency")).child(Switch::new(SharedString::from(format!("appearance-sidebar-translucency-{scheme:?}").to_ascii_lowercase())).checked(variant.translucent_sidebar).on_click(cx.listener(move |this, _, _, cx| this.appearance.toggle_sidebar(scheme, &this.services, cx)))))
            .child(v_flex().gap_1().child(h_flex().justify_between().child(div().text_sm().child("Contrast")).child(div().text_xs().child(variant.contrast.to_string()))).when_some(self.appearance.contrast_sliders.iter().find(|(candidate, _)| *candidate == scheme).map(|(_, state)| state.clone()), |el, state| el.child(Slider::new(&state).w_full())))
            .child(Button::new(SharedString::from(format!("appearance-copy-theme-{scheme:?}").to_ascii_lowercase())).small().outline().label("Copy theme JSON").on_click(cx.listener(move |this, _, _, cx| this.appearance.copy_theme(scheme, &this.services, cx))))
            .child(Button::new(SharedString::from(format!("appearance-import-theme-{scheme:?}").to_ascii_lowercase())).small().outline().label("Import theme JSON").on_click(cx.listener(move |this, _, window, cx| this.appearance.import_theme(scheme, window, &this.services, cx))))
    }

    fn scheme_overview_cards(
        &self,
        config: &AppearanceConfig,
        layout: AppearanceLayout,
        cx: &mut Context<SettingsView>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let active_scheme = self.appearance.editing_scheme;
        let pointer = crate::services::appearance::pointer_cursors_enabled(cx);
        h_flex()
            .w_full()
            .gap_3()
            .when(layout == AppearanceLayout::StackPanes, |el| el.flex_col())
            .children([Scheme::Light, Scheme::Dark].into_iter().map(|scheme| {
                let variant = match scheme {
                    Scheme::Light => &config.light,
                    Scheme::Dark => &config.dark,
                };
                let selected = active_scheme == scheme;
                let swatches = [&variant.background, &variant.accent, &variant.foreground]
                    .into_iter()
                    .filter_map(|value| hsla_from_hex(value))
                    .collect::<Vec<_>>();
                v_flex()
                    .id(SharedString::from(
                        format!("appearance-scheme-{scheme:?}").to_ascii_lowercase(),
                    ))
                    .flex_1()
                    .min_w(px(0.))
                    .p_3()
                    .gap_2()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(if selected { theme.accent } else { theme.border })
                    .when(pointer, |el| el.cursor_pointer())
                    .tab_stop(false)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.appearance.editing_scheme = scheme;
                        cx.notify();
                    }))
                    .child(
                        h_flex()
                            .justify_between()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(
                                match scheme {
                                    Scheme::Light => "Light",
                                    Scheme::Dark => "Dark",
                                },
                            ))
                            .child(
                                h_flex().gap_1().children(
                                    swatches
                                        .into_iter()
                                        .map(|color| div().size(px(14.)).rounded_sm().bg(color)),
                                ),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} · {}",
                                ui_font_label(variant.ui_font),
                                code_font_label(variant.code_font)
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "Contrast {} · Sidebar {}",
                                variant.contrast,
                                if variant.translucent_sidebar {
                                    "translucent"
                                } else {
                                    "solid"
                                }
                            )),
                    )
            }))
    }

    fn preference_controls(
        &self,
        config: &AppearanceConfig,
        theme: &gpui_component::theme::Theme,
        cx: &mut Context<SettingsView>,
    ) -> impl IntoElement {
        v_flex().w_full().gap_2().p_3().rounded(px(16.)).border_1().border_color(theme.border)
            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Preferences"))
            .child(
                h_flex().items_center().justify_between().child(div().text_sm().child("Pointer cursors"))
                    .child(Switch::new("appearance-pointer-cursors").checked(config.pointer_cursors).on_click(cx.listener(|this, _checked, _window, cx| this.appearance.toggle_pointer(&this.services, cx)))),
            )
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(div().text_sm().child("Diff markers"))
                    .child(
                        h_flex()
                            .gap_3()
                            .child(
                                Radio::new("appearance-diff-symbols")
                                    .label("Symbols")
                                    .checked(config.diff_markers == DiffMarkers::Symbols)
                                    .tab_stop(config.diff_markers == DiffMarkers::Symbols)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.appearance.set_diff_markers(
                                            DiffMarkers::Symbols,
                                            &this.services,
                                            cx,
                                        )
                                    })),
                            )
                            .child(
                                Radio::new("appearance-diff-color")
                                    .label("Color only")
                                    .checked(config.diff_markers == DiffMarkers::Color)
                                    .tab_stop(config.diff_markers == DiffMarkers::Color)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.appearance.set_diff_markers(
                                            DiffMarkers::Color,
                                            &this.services,
                                            cx,
                                        )
                                    })),
                            ),
                    ),
            )
            .child(self.number_control(NumberControlArgs {
                label: "UI text size",
                id: "appearance-ui-size",
                value: config.ui_font_size,
                min: 12,
                max: 18,
                kind: TextSizeKind::Ui,
            }, cx))
            .child(self.number_control(NumberControlArgs {
                label: "Code text size",
                id: "appearance-code-size",
                value: config.code_font_size,
                min: 10,
                max: 18,
                kind: TextSizeKind::Code,
            }, cx))
            .child(div().text_xs().text_color(theme.muted_foreground).child("Font smoothing has no GPUI runtime hook and is unavailable rather than misrepresented."))
    }

    /// A compact number-like control with explicit reversible bounds. GPUI's
    /// bundled NumberInput is text-oriented; this keeps the renderer's
    /// stepper geometry while exposing exact current/min/max values.
    fn number_control(
        &self,
        args: NumberControlArgs,
        cx: &mut Context<SettingsView>,
    ) -> impl IntoElement {
        let NumberControlArgs {
            label,
            id,
            value,
            min,
            max,
            kind,
        } = args;
        h_flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(div().text_sm().child(label))
            .child(
                h_flex()
                    .items_center()
                    .gap_1()
                    .child(
                        Button::new(SharedString::from(format!("{id}-decrease")))
                            .small()
                            .outline()
                            .label("−")
                            .disabled(value <= min)
                            .on_click(cx.listener(move |this, _, _, cx| match kind {
                                TextSizeKind::Ui => {
                                    this.appearance.adjust_ui_size(-1, &this.services, cx)
                                }
                                TextSizeKind::Code => {
                                    this.appearance.adjust_code_size(-1, &this.services, cx)
                                }
                            })),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("{id}-value")))
                            .min_w(px(32.))
                            .text_center()
                            .text_sm()
                            .child(value.to_string()),
                    )
                    .child(
                        Button::new(SharedString::from(format!("{id}-increase")))
                            .small()
                            .outline()
                            .label("+")
                            .disabled(value >= max)
                            .on_click(cx.listener(move |this, _, _, cx| match kind {
                                TextSizeKind::Ui => {
                                    this.appearance.adjust_ui_size(1, &this.services, cx)
                                }
                                TextSizeKind::Code => {
                                    this.appearance.adjust_code_size(1, &this.services, cx)
                                }
                            })),
                    ),
            )
    }

    /// Live syntax/diff specimen rendered independently with both variants.
    /// This mirrors the renderer's two-pane code preview rather than exposing
    /// implementation JSON as the primary visual proof.
    fn theme_code_panes(
        &self,
        config: &AppearanceConfig,
        theme: &gpui_component::theme::Theme,
        layout: AppearanceLayout,
    ) -> impl IntoElement {
        h_flex()
            .w_full()
            .gap(px(12.))
            .when(layout == AppearanceLayout::StackPanes, |el| el.flex_col())
            .children([Scheme::Light, Scheme::Dark].into_iter().map(|scheme| {
                let variant = match scheme {
                    Scheme::Light => &config.light,
                    Scheme::Dark => &config.dark,
                };
                let background = hsla_from_hex(&variant.background).unwrap_or(theme.background);
                let foreground = hsla_from_hex(&variant.foreground).unwrap_or(theme.foreground);
                let accent = hsla_from_hex(&variant.accent).unwrap_or(theme.accent);
                v_flex()
                    .flex_1()
                    .min_h(px(132.))
                    .p_3()
                    .gap_2()
                    .rounded(px(13.))
                    .bg(background)
                    .border_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(match scheme {
                                Scheme::Light => "Light editor",
                                Scheme::Dark => "Dark editor",
                            }),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .flex_1()
                            .overflow_hidden()
                            .font_family("monospace")
                            .text_xs()
                            .text_color(foreground)
                            .child(
                                v_flex()
                                    .flex_1()
                                    .p_2()
                                    .gap_1()
                                    .bg(theme.danger.alpha(0.10))
                                    .child(
                                        div().text_color(theme.danger).child("− const old = true;"),
                                    )
                                    .child(div().child("  fn render() {"))
                                    .child(div().child("    panel.open();"))
                                    .child(div().child("  }")),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .p_2()
                                    .gap_1()
                                    .bg(accent.alpha(0.10))
                                    .child(div().text_color(accent).child("+ const ready = true;"))
                                    .child(div().child("  fn render() {"))
                                    .child(div().child("    panel.open();"))
                                    .child(div().child("  }")),
                            ),
                    )
            }))
    }

    /// One preset choice row with a color swatch strip.
    fn preset_row(
        &self,
        preset: PresetId,
        label: &str,
        scheme: Scheme,
        active: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let pointer_cursors = crate::services::appearance::pointer_cursors_enabled(cx);
        let id = SharedString::from(format!("preset-{preset:?}").to_ascii_lowercase());
        let focus = window
            .use_keyed_state(id.clone(), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let variant = get_preset_variant(preset, scheme);
        let swatches = [
            variant.background.as_str(),
            variant.accent.as_str(),
            variant.foreground.as_str(),
        ]
        .into_iter()
        .filter_map(hsla_from_hex)
        .collect::<Vec<_>>();
        h_flex()
            .id(id)
            .track_focus(&focus)
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .rounded_lg()
            .border_1()
            .border_color(if active { theme.accent } else { theme.border })
            .when(pointer_cursors, |el| el.cursor_pointer())
            .tab_stop(active)
            .hover(|style| style.bg(theme.muted))
            .focus(|style| style.bg(theme.list_active).border_color(theme.ring))
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.appearance.set_preset(preset, &this.services, cx);
            }))
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    if preset_activation_key(event.keystroke.key.as_str()) {
                        this.appearance.set_preset(preset, &this.services, cx);
                        cx.stop_propagation();
                        return;
                    }
                    let choices = [
                        PresetId::Aiden,
                        PresetId::Slate,
                        PresetId::Berry,
                        PresetId::Moss,
                    ];
                    let current = choices
                        .iter()
                        .position(|candidate| *candidate == preset)
                        .unwrap_or(0);
                    if let Some(next) =
                        rove_index(current, event.keystroke.key.as_str(), choices.len())
                    {
                        let next = choices[next];
                        this.appearance.set_preset(next, &this.services, cx);
                        focus_button(
                            SharedString::from(format!("preset-{next:?}").to_ascii_lowercase()),
                            window,
                            cx,
                        );
                        cx.stop_propagation();
                    }
                }),
            )
            .child(
                h_flex().gap_0p5().children(
                    swatches
                        .into_iter()
                        .map(|color| div().size(px(14.)).rounded_sm().bg(color)),
                ),
            )
            .child(
                div()
                    .flex_1()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(label.to_string()),
            )
            .child(if active {
                Icon::new(IconName::Check)
                    .small()
                    .text_color(theme.accent)
                    .into_any_element()
            } else {
                div().into_any_element()
            })
    }
}

fn ui_font_label(font: UiFont) -> &'static str {
    match font {
        UiFont::System => "System",
        UiFont::Rounded => "Rounded",
        UiFont::Humanist => "Humanist",
    }
}

fn code_font_label(font: CodeFont) -> &'static str {
    match font {
        CodeFont::SfMono => "SF Mono",
        CodeFont::Menlo => "Menlo",
        CodeFont::Monaco => "Monaco",
    }
}

impl AppearanceState {
    fn mutate(
        &mut self,
        config: AppearanceConfig,
        apply_native: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let issues = [Scheme::Light, Scheme::Dark]
            .into_iter()
            .flat_map(|scheme| {
                let variant = match scheme {
                    Scheme::Light => &config.light,
                    Scheme::Dark => &config.dark,
                };
                aiden_core::appearance::theme_variant_safety_issues(variant, scheme)
            })
            .collect::<Vec<_>>();
        if !issues.is_empty() {
            self.unsafe_draft = Some(config);
            self.invalid_color = Some(issues.join(" "));
            cx.notify();
            return;
        }
        self.unsafe_draft = None;
        self.invalid_color = None;
        services.appearance_service.update(cx, |service, cx| {
            service.set_appearance_config(config, apply_native, cx);
        });
    }

    /// Switch the mode and apply + persist.
    fn set_mode(
        &mut self,
        mode: Mode,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.config(services, cx);
        if config.mode == mode {
            return;
        }
        config.mode = mode;
        self.mutate(config, false, services, cx);
    }

    /// Switch the reduce-motion preference (`System | On | Off`) and persist
    /// it under the `appearance` key. The pill and the main chat surface both
    /// read the persisted override (see `crate::app::motion_reduced`).
    fn set_reduce_motion(
        &mut self,
        reduce_motion: ReduceMotion,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.config(services, cx);
        if config.reduce_motion == reduce_motion {
            return;
        }
        config.reduce_motion = reduce_motion;
        self.mutate(config, false, services, cx);
    }

    /// Apply a preset to the active scheme's variant and persist.
    fn set_preset(
        &mut self,
        preset: PresetId,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let mut config = self.config(services, cx);
        let scheme = self.editing_scheme;
        let variant = get_preset_variant(preset, scheme);
        match scheme {
            Scheme::Light => config.light = variant,
            Scheme::Dark => config.dark = variant,
        }
        self.mutate(config, false, services, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::appearance::{appearance_to_settings, SETTINGS_APPEARANCE_KEY};

    #[test]
    fn all_four_presets_are_cataloged_and_distinct() {
        let presets = theme_presets();
        assert_eq!(presets.len(), 4);
        let mut ids: std::collections::HashSet<PresetId> =
            presets.iter().map(|preset| preset.id).collect();
        for expected in [
            PresetId::Aiden,
            PresetId::Slate,
            PresetId::Berry,
            PresetId::Moss,
        ] {
            assert!(ids.remove(&expected), "missing preset {expected:?}");
        }
        assert!(ids.is_empty());
    }

    #[test]
    fn hex_token_parses_into_an_opaque_color() {
        assert!(hsla_from_hex("#006AD6").is_some());
        assert!(hsla_from_hex("006AD6").is_none());
        assert!(hsla_from_hex("#GGGGGG").is_none());
        assert!(hsla_from_hex("#000").is_none());
    }

    #[test]
    fn reduce_motion_override_round_trips_through_the_settings_map() {
        let mut config =
            crate::services::appearance::appearance_from_settings(&serde_json::Map::new());
        assert_eq!(config.reduce_motion, ReduceMotion::System);
        config.reduce_motion = ReduceMotion::On;
        let mut settings = serde_json::Map::new();
        settings.insert(
            SETTINGS_APPEARANCE_KEY.to_string(),
            appearance_to_settings(&config),
        );
        let back = crate::services::appearance::appearance_from_settings(&settings);
        assert_eq!(back.reduce_motion, ReduceMotion::On);
        assert_eq!(back.mode, config.mode);
    }

    #[test]
    fn preset_rows_activate_only_with_enter_or_space() {
        assert!(preset_activation_key("enter"));
        assert!(preset_activation_key("space"));
        assert!(!preset_activation_key("down"));
    }

    #[test]
    fn responsive_breakpoints_match_the_renderer_contract() {
        assert_eq!(
            appearance_layout_for_width(621.0),
            AppearanceLayout::Desktop
        );
        assert_eq!(
            appearance_layout_for_width(620.0),
            AppearanceLayout::StackHeaders
        );
        assert_eq!(
            appearance_layout_for_width(521.0),
            AppearanceLayout::StackHeaders
        );
        assert_eq!(
            appearance_layout_for_width(520.0),
            AppearanceLayout::StackPanes
        );
    }

    #[test]
    fn radio_roving_honors_home_and_end() {
        assert_eq!(rove_index(1, "home", 3), Some(0));
        assert_eq!(rove_index(1, "end", 3), Some(2));
        assert_eq!(rove_index(0, "left", 3), Some(2));
    }
}
