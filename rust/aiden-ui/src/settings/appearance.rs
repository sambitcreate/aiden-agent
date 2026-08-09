//! Appearance settings (port of `appearance-settings.tsx`, reduced).
//!
//! Four theme presets from `aiden_core::appearance::theme_presets` plus the
//! System/Light/Dark mode picker. Changes apply live through
//! `crate::services::appearance::apply_appearance` and persist into
//! `settings.json` under the `appearance` key. The full per-scheme color
//! editor and typography preferences are out of scope for this pass.

use aiden_core::appearance::{
    get_preset_variant, theme_presets, AppearanceConfig, Mode, PresetId, ReduceMotion, Scheme,
    Selection,
};
use gpui::{
    div, px, AppContext as _, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::services::appearance::{
    appearance_from_settings, appearance_to_settings, apply_appearance, resolve_scheme,
    SETTINGS_APPEARANCE_KEY,
};

use super::{SettingsServices, SettingsView};

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

#[derive(Default)]
pub struct AppearanceState {
    pub appearance: Option<AppearanceConfig>,
}

impl AppearanceState {
    /// Read the persisted appearance config and apply it live.
    pub fn hydrate(
        &mut self,
        settings: &serde_json::Map<String, serde_json::Value>,
        cx: &mut gpui::App,
    ) {
        let config = appearance_from_settings(settings);
        self.appearance = Some(config.clone());
        apply_appearance(
            cx,
            &config,
            resolve_scheme(config.mode, cx.window_appearance()),
        );
    }

    fn config(&self) -> AppearanceConfig {
        self.appearance.clone().unwrap_or_else(|| {
            crate::services::appearance::appearance_from_settings(&serde_json::Map::new())
        })
    }
}

impl SettingsView {
    /// The Appearance section: preset picker + mode picker.
    pub(crate) fn appearance_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // Cloned (not borrowed) so `theme` stays usable after the
        // `cx`-capturing row/button closures below.
        let theme = cx.theme().clone();
        let config = self.appearance.config();
        let presets = theme_presets();
        let current_scheme = resolve_scheme(config.mode, cx.window_appearance());

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
                                        this.appearance.set_mode(mode, &this.services, cx);
                                    }))
                            }),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Preset"),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Presets define the light and dark palettes. Choose one to restore \
                                 its colors.",
                    ))
                    .child(
                        v_flex()
                            .w_full()
                            .gap_2()
                            .children(presets.iter().map(|preset| {
                                let active = selection_matches(config.light.preset, preset.id);
                                self.preset_row(
                                    preset.id,
                                    &preset.label,
                                    current_scheme,
                                    active,
                                    cx,
                                )
                            })),
                    ),
            )
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
                                        match (preference, crate::app::system_reduced_motion()) {
                                            (ReduceMotion::System, true) => "System (reduced)",
                                            (ReduceMotion::System, false) => "System",
                                            (ReduceMotion::On, _) => "On",
                                            (ReduceMotion::Off, _) => "Off",
                                        };
                                    button.label(label).on_click(cx.listener(
                                        move |this, _event, _window, cx| {
                                            this.appearance.set_reduce_motion(
                                                preference,
                                                &this.services,
                                                cx,
                                            );
                                        },
                                    ))
                                }),
                        ),
                    ),
            )
    }

    /// One preset choice row with a color swatch strip.
    fn preset_row(
        &self,
        preset: PresetId,
        label: &str,
        scheme: Scheme,
        active: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
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
            .id(SharedString::from(
                format!("preset-{:?}", preset).to_ascii_lowercase(),
            ))
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .rounded_lg()
            .border_1()
            .border_color(if active { theme.accent } else { theme.border })
            .cursor_pointer()
            .hover(|style| style.bg(theme.muted))
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.appearance.set_preset(preset, &this.services, cx);
            }))
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

impl AppearanceState {
    /// Switch the mode and apply + persist.
    fn set_mode(
        &mut self,
        mode: Mode,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let mut config = self.config();
        if config.mode == mode {
            return;
        }
        config.mode = mode;
        self.appearance = Some(config.clone());
        let scheme = resolve_scheme(mode, cx.window_appearance());
        apply_appearance(cx, &config, scheme);
        let value = appearance_to_settings(&config);
        cx.spawn(async move |_this, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                    let _ = services.config.set_settings(&patch, &|| true);
                })
                .await;
        })
        .detach();
        cx.notify();
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
        let services = services.clone();
        let mut config = self.config();
        if config.reduce_motion == reduce_motion {
            return;
        }
        config.reduce_motion = reduce_motion;
        self.appearance = Some(config.clone());
        let value = appearance_to_settings(&config);
        cx.spawn(async move |_this, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                    let _ = services.config.set_settings(&patch, &|| true);
                })
                .await;
        })
        .detach();
        cx.notify();
    }

    /// Apply a preset to the active scheme's variant and persist.
    fn set_preset(
        &mut self,
        preset: PresetId,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let mut config = self.config();
        let scheme = resolve_scheme(config.mode, cx.window_appearance());
        let variant = get_preset_variant(preset, scheme);
        match scheme {
            Scheme::Light => config.light = variant,
            Scheme::Dark => config.dark = variant,
        }
        // Keep both schemes in sync so the preset applies everywhere.
        let other = match scheme {
            Scheme::Light => Scheme::Dark,
            Scheme::Dark => Scheme::Light,
        };
        let other_variant = get_preset_variant(preset, other);
        match other {
            Scheme::Light => config.light = other_variant,
            Scheme::Dark => config.dark = other_variant,
        }
        self.appearance = Some(config.clone());
        apply_appearance(cx, &config, scheme);
        let value = appearance_to_settings(&config);
        cx.spawn(async move |_this, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                    let _ = services.config.set_settings(&patch, &|| true);
                })
                .await;
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
