//! Mapping of Aiden's appearance presets (`aiden_core::appearance`) onto the
//! gpui-component `Theme`. The semantic tokens computed by
//! `resolve_theme_tokens` are projected onto the gpui-component theme schema
//! (built through the crate's own JSON schema so the highlight/`ThemeStyle`
//! fields — whose struct fields are private — round-trip correctly).
//!
//! No hardcoded hex colors live in the UI; every color flows from here.

use std::collections::BTreeMap;
use std::rc::Rc;

use aiden_core::appearance::{
    create_default_appearance_config, parse_appearance_config, resolve_theme_tokens,
    AppearanceConfig, CodeFont, Mode, Scheme, ThemeVariantConfig, UiFont,
};
use gpui::{px, App, Global, Hsla, WindowAppearance};
use gpui_component::theme::{Theme, ThemeConfig, ThemeMode};
use gpui_component::Colorize as _;

pub const SETTINGS_APPEARANCE_KEY: &str = "appearance";

/// Aiden tokens that have no lossless slot in gpui-component's public theme
/// schema. Keeping them in a narrow global avoids repurposing unrelated list
/// or control colors at render sites.
#[derive(Clone, Copy)]
pub struct AidenSemanticColors {
    pub input_surface: Hsla,
}

impl Global for AidenSemanticColors {}

/// Non-colour appearance preferences consumed by controls outside Settings.
/// Keeping this alongside the projected theme makes each persisted preference
/// observable by a real GPUI consumer without spreading config reads through
/// render paths.
#[derive(Clone, Copy)]
pub struct AidenAppearanceRuntime {
    pub pointer_cursors: bool,
    pub translucent_sidebar: bool,
    pub diff_markers: aiden_core::appearance::DiffMarkers,
    pub motion_reduced: bool,
}

impl Global for AidenAppearanceRuntime {}

#[derive(Clone, Copy, Default)]
pub struct AidenSystemAccessibility {
    pub high_contrast: bool,
    pub reduced_motion: bool,
}

impl Global for AidenSystemAccessibility {}

pub fn current_system_reduced_motion(cx: &App) -> bool {
    cx.try_global::<AidenSystemAccessibility>()
        .is_some_and(|value| value.reduced_motion)
}

pub fn current_system_high_contrast(cx: &App) -> bool {
    cx.try_global::<AidenSystemAccessibility>()
        .is_some_and(|value| value.high_contrast)
}

/// Shared policy for click-like controls.  Components opt in through this
/// helper instead of reading the settings store themselves, which keeps a
/// live Appearance edit effective across the workbench on the next render.
pub fn pointer_cursors_enabled(cx: &App) -> bool {
    pointer_cursor_policy(
        cx.try_global::<AidenAppearanceRuntime>()
            .map(|runtime| runtime.pointer_cursors),
    )
}

fn pointer_cursor_policy(preference: Option<bool>) -> bool {
    preference.unwrap_or(false)
}

pub fn input_surface(cx: &App) -> Hsla {
    cx.try_global::<AidenSemanticColors>().map_or_else(
        || Theme::global(cx).background,
        |colors| colors.input_surface,
    )
}

fn semantic_colors(
    variant: &ThemeVariantConfig,
    scheme: Scheme,
    high_contrast: bool,
) -> AidenSemanticColors {
    let tokens = resolve_theme_tokens(variant, scheme, high_contrast);
    let input_surface = tokens
        .get("--surface-input")
        .and_then(|color| parse_aiden_semantic_color(color))
        .unwrap_or_else(Hsla::transparent_black);
    AidenSemanticColors { input_surface }
}

/// Parse the normalized color forms emitted by `resolve_theme_tokens`.
/// Opaque tokens are hex; alpha-composited surface tokens use CSS Color 4's
/// `rgb(R G B / A)` form rather than an eight-digit hex value.
fn parse_aiden_semantic_color(value: &str) -> Option<Hsla> {
    if value.starts_with('#') {
        return Hsla::parse_hex(value).ok();
    }
    let body = value.strip_prefix("rgb(")?.strip_suffix(')')?;
    let (channels, alpha) = body.split_once('/')?;
    let mut channels = channels.split_ascii_whitespace();
    let red = channels.next()?.parse::<u8>().ok()?;
    let green = channels.next()?.parse::<u8>().ok()?;
    let blue = channels.next()?.parse::<u8>().ok()?;
    if channels.next().is_some() {
        return None;
    }
    let alpha = alpha.trim().parse::<f32>().ok()?;
    if !(0.0..=1.0).contains(&alpha) {
        return None;
    }
    Some(
        gpui::Rgba {
            r: f32::from(red) / 255.0,
            g: f32::from(green) / 255.0,
            b: f32::from(blue) / 255.0,
            a: alpha,
        }
        .into(),
    )
}

/// Resolve the effective color scheme for a mode + the current window
/// appearance (system mode follows the OS).
pub fn resolve_scheme(mode: Mode, appearance: WindowAppearance) -> Scheme {
    match mode {
        Mode::Light => Scheme::Light,
        Mode::Dark => Scheme::Dark,
        Mode::System => match appearance {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Scheme::Dark,
            WindowAppearance::Light | WindowAppearance::VibrantLight => Scheme::Light,
        },
    }
}

/// The aiden-crate's `Mode` → gpui-component `ThemeMode` (for the config's
/// `mode` field so `Theme::apply_config` keeps everything consistent).
pub fn theme_mode(scheme: Scheme) -> ThemeMode {
    match scheme {
        Scheme::Light => ThemeMode::Light,
        Scheme::Dark => ThemeMode::Dark,
    }
}

/// The configured variant for a scheme, falling back to the default config.
pub fn variant_for(config: &AppearanceConfig, scheme: Scheme) -> &ThemeVariantConfig {
    match scheme {
        Scheme::Light => &config.light,
        Scheme::Dark => &config.dark,
    }
}

/// Build the gpui-component theme config for one variant + scheme. Pure, so
/// tests can assert the projected colors without a running app.
pub fn build_theme_config(
    variant: &ThemeVariantConfig,
    scheme: Scheme,
    name: &str,
    high_contrast: bool,
) -> ThemeConfig {
    let tokens = resolve_theme_tokens(variant, scheme, high_contrast);
    let json = theme_config_json(&tokens, name, theme_mode(scheme));
    // The JSON is projected from our own token map, so a parse failure means a
    // token-name drift or a gpui-component schema change. `build_theme_config`
    // runs from appearance apply paths that originate in ObjC callbacks (the
    // sidebar mode toggle), where a panic becomes a panic_cannot_unwind
    // SIGABRT. Fall back to the default theme + a logged error instead of
    // aborting the app.
    serde_json::from_value(json).unwrap_or_else(|error| {
        tracing::error!("aiden theme config failed to parse as a gpui ThemeConfig: {error}");
        ThemeConfig::default()
    })
}

fn color(tokens: &BTreeMap<String, String>, key: &str) -> serde_json::Value {
    tokens
        .get(key)
        .map(|value| serde_json::Value::String(value.clone()))
        .unwrap_or(serde_json::Value::Null)
}

/// Project the Aiden semantic tokens onto the gpui-component theme schema.
fn theme_config_json(
    tokens: &BTreeMap<String, String>,
    name: &str,
    mode: ThemeMode,
) -> serde_json::Value {
    use serde_json::{Map, Value};
    let mut colors = Map::new();
    let set = |map: &mut Map<String, Value>, key: &str, token: &str| {
        map.insert(key.to_string(), color(tokens, token));
    };
    set(&mut colors, "background", "--theme-canvas");
    set(&mut colors, "foreground", "--text-primary");
    set(&mut colors, "border", "--border-separator");
    set(&mut colors, "input.border", "--border-field");
    set(&mut colors, "ring", "--focus-ring");
    set(&mut colors, "caret", "--accent");
    set(&mut colors, "accent.background", "--accent");
    set(&mut colors, "accent.foreground", "--accent-foreground");
    set(&mut colors, "primary.background", "--accent");
    set(&mut colors, "primary.foreground", "--accent-foreground");
    set(&mut colors, "primary.hover.background", "--accent-hover");
    set(&mut colors, "primary.active.background", "--accent-active");
    set(&mut colors, "secondary.background", "--surface-control");
    set(&mut colors, "secondary.foreground", "--text-secondary");
    set(
        &mut colors,
        "secondary.hover.background",
        "--surface-control-hover",
    );
    set(
        &mut colors,
        "secondary.active.background",
        "--surface-control-active",
    );
    set(&mut colors, "muted.background", "--surface-control");
    set(&mut colors, "muted.foreground", "--text-tertiary");
    set(&mut colors, "popover.background", "--surface-popover");
    set(&mut colors, "popover.foreground", "--text-primary");
    set(&mut colors, "sidebar.background", "--surface-sidebar");
    set(&mut colors, "sidebar.foreground", "--text-primary");
    set(
        &mut colors,
        "sidebar.accent.background",
        "--surface-list-selection",
    );
    set(&mut colors, "sidebar.accent.foreground", "--text-primary");
    set(
        &mut colors,
        "sidebar.primary.background",
        "--surface-control",
    );
    set(&mut colors, "sidebar.primary.foreground", "--text-primary");
    set(&mut colors, "sidebar.border", "--border-separator");
    set(&mut colors, "list.background", "--theme-canvas");
    set(&mut colors, "list.hover.background", "--surface-list-hover");
    set(
        &mut colors,
        "list.active.background",
        "--surface-list-selection",
    );
    set(&mut colors, "list.active.border", "--accent");
    set(
        &mut colors,
        "selection.background",
        "--surface-list-selection",
    );
    set(&mut colors, "danger.background", "--support-red");
    set(&mut colors, "danger.foreground", "--support-red-foreground");
    set(&mut colors, "success.background", "--support-green");
    set(
        &mut colors,
        "success.foreground",
        "--support-green-foreground",
    );
    set(&mut colors, "warning.background", "--support-warning");
    set(
        &mut colors,
        "warning.foreground",
        "--support-warning-foreground",
    );
    set(&mut colors, "info.background", "--accent");
    set(&mut colors, "info.foreground", "--accent-foreground");
    set(
        &mut colors,
        "title_bar.background",
        "--window-gradient-start",
    );
    set(&mut colors, "title_bar.border", "--border-separator");

    let mut syntax = Map::new();
    let set_style = |map: &mut Map<String, Value>, key: &str, token: &str| {
        map.insert(
            key.to_string(),
            Value::Object(Map::from_iter([(
                "color".to_string(),
                color(tokens, token),
            )])),
        );
    };
    set_style(&mut syntax, "keyword", "--syntax-keyword");
    set_style(&mut syntax, "string", "--syntax-string");
    set_style(&mut syntax, "number", "--syntax-number");
    set_style(&mut syntax, "comment", "--syntax-comment");
    set_style(&mut syntax, "function", "--syntax-title");
    set_style(&mut syntax, "variable", "--syntax-variable");

    serde_json::Value::Object(Map::from_iter([
        ("name".into(), Value::String(name.to_string())),
        ("mode".into(), Value::String(mode.name().to_string())),
        ("radius".into(), Value::Number(8.into())),
        ("colors".into(), Value::Object(colors)),
        (
            "highlight".into(),
            Value::Object(Map::from_iter([
                ("editor.background".into(), color(tokens, "--theme-raised")),
                ("editor.foreground".into(), color(tokens, "--text-primary")),
                ("syntax".into(), Value::Object(syntax)),
            ])),
        ),
    ]))
}

/// Apply an appearance config for one scheme to the running gpui theme.
pub fn apply_appearance(
    cx: &mut App,
    config: &AppearanceConfig,
    scheme: Scheme,
    high_contrast: bool,
    system_reduced_motion: bool,
) {
    let variant = variant_for(config, scheme);
    let name = format!("Aiden {}", scheme_name(scheme));
    let theme_config = build_theme_config(variant, scheme, &name, high_contrast);
    Theme::global_mut(cx).apply_config(&Rc::new(theme_config));
    let theme = Theme::global_mut(cx);
    theme.font_family = native_ui_font(variant.ui_font).into();
    theme.mono_font_family = native_code_font(variant.code_font).into();
    theme.font_size = px(f32::from(config.ui_font_size));
    theme.mono_font_size = px(f32::from(config.code_font_size));
    cx.set_global(semantic_colors(variant, scheme, high_contrast));
    cx.set_global(AidenAppearanceRuntime {
        pointer_cursors: config.pointer_cursors,
        translucent_sidebar: variant.translucent_sidebar,
        diff_markers: config.diff_markers,
        motion_reduced: match config.reduce_motion {
            aiden_core::appearance::ReduceMotion::System => system_reduced_motion,
            aiden_core::appearance::ReduceMotion::On => true,
            aiden_core::appearance::ReduceMotion::Off => false,
        },
    });
}

/// GPUI receives native family names, not CSS fallback stacks. The chosen
/// values are the concrete macOS faces underlying the portable contract.
fn native_ui_font(font: UiFont) -> &'static str {
    match font {
        UiFont::System => ".SystemUIFont",
        UiFont::Rounded => "SF Pro Rounded",
        UiFont::Humanist => "Avenir Next",
    }
}

fn native_code_font(font: CodeFont) -> &'static str {
    match font {
        CodeFont::SfMono => "SF Mono",
        CodeFont::Menlo => "Menlo",
        CodeFont::Monaco => "Monaco",
    }
}

pub fn scheme_name(scheme: Scheme) -> &'static str {
    match scheme {
        Scheme::Light => "Light",
        Scheme::Dark => "Dark",
    }
}

/// Read the persisted appearance config from the settings map, normalized.
pub fn appearance_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> AppearanceConfig {
    let fallback = create_default_appearance_config();
    match settings.get(SETTINGS_APPEARANCE_KEY) {
        Some(value) => parse_appearance_config(value).unwrap_or(fallback),
        None => fallback,
    }
}

/// Serialize the appearance config for the settings store.
pub fn appearance_to_settings(config: &AppearanceConfig) -> serde_json::Value {
    serde_json::to_value(config).unwrap_or_else(|_| {
        serde_json::to_value(create_default_appearance_config()).expect("default serializes")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::appearance::{get_preset_variant, PresetId};

    #[test]
    fn theme_config_parses_and_carries_core_colors() {
        for scheme in [Scheme::Light, Scheme::Dark] {
            let config = create_default_appearance_config();
            let variant = variant_for(&config, scheme);
            let tokens = resolve_theme_tokens(variant, scheme, false);
            let theme_config = build_theme_config(variant, scheme, "test", false);
            assert_eq!(theme_config.mode, theme_mode(scheme));
            // The projected JSON maps the Aiden token onto the theme color.
            let json = theme_config_json(&tokens, "test", theme_mode(scheme));
            assert_eq!(
                json["colors"]["background"], tokens["--theme-canvas"],
                "background should come from the Aiden tokens"
            );
            assert_eq!(json["colors"]["foreground"], tokens["--text-primary"]);
            assert_eq!(json["colors"]["accent.background"], tokens["--accent"]);
            assert_eq!(
                json["colors"]["sidebar.accent.background"],
                tokens["--surface-list-selection"]
            );
            assert_eq!(
                json["highlight"]["syntax"]["keyword"]["color"],
                tokens["--syntax-keyword"]
            );
        }
    }

    #[test]
    fn input_surface_global_comes_from_the_exact_aiden_semantic_token() {
        let config = create_default_appearance_config();
        for (scheme, token, rgba) in [
            (
                Scheme::Light,
                "rgb(61 63 65 / 0.051)",
                gpui::Rgba {
                    r: 61.0 / 255.0,
                    g: 63.0 / 255.0,
                    b: 65.0 / 255.0,
                    a: 0.051,
                },
            ),
            (
                Scheme::Dark,
                "rgb(209 212 218 / 0.056)",
                gpui::Rgba {
                    r: 209.0 / 255.0,
                    g: 212.0 / 255.0,
                    b: 218.0 / 255.0,
                    a: 0.056,
                },
            ),
        ] {
            let variant = variant_for(&config, scheme);
            let tokens = resolve_theme_tokens(variant, scheme, false);
            assert_eq!(tokens["--surface-input"], token);
            assert_eq!(
                semantic_colors(variant, scheme, false).input_surface,
                Hsla::from(rgba)
            );
        }
        assert!(parse_aiden_semantic_color("rgb(1 2 / 0.5)").is_none());
        assert!(parse_aiden_semantic_color("rgb(1 2 3 / 1.5)").is_none());
    }

    #[test]
    fn configured_font_choices_have_concrete_gpui_consumers() {
        assert_eq!(
            native_ui_font(aiden_core::appearance::UiFont::System),
            ".SystemUIFont"
        );
        assert_eq!(
            native_ui_font(aiden_core::appearance::UiFont::Rounded),
            "SF Pro Rounded"
        );
        assert_eq!(
            native_ui_font(aiden_core::appearance::UiFont::Humanist),
            "Avenir Next"
        );
        assert_eq!(
            native_code_font(aiden_core::appearance::CodeFont::SfMono),
            "SF Mono"
        );
        assert_eq!(
            native_code_font(aiden_core::appearance::CodeFont::Menlo),
            "Menlo"
        );
        assert_eq!(
            native_code_font(aiden_core::appearance::CodeFont::Monaco),
            "Monaco"
        );
    }

    #[test]
    fn all_four_presets_produce_distinct_theme_configs() {
        let mut backgrounds = Vec::new();
        for preset in [
            PresetId::Aiden,
            PresetId::Slate,
            PresetId::Berry,
            PresetId::Moss,
        ] {
            let variant = get_preset_variant(preset, Scheme::Dark);
            let tokens = resolve_theme_tokens(&variant, Scheme::Dark, false);
            backgrounds.push(tokens["--theme-canvas"].clone());
        }
        let unique: std::collections::HashSet<_> = backgrounds.iter().collect();
        assert_eq!(unique.len(), 4, "each preset has a distinct background");
    }

    #[test]
    fn system_mode_resolves_from_window_appearance() {
        assert_eq!(
            resolve_scheme(Mode::System, WindowAppearance::Dark),
            Scheme::Dark
        );
        assert_eq!(
            resolve_scheme(Mode::System, WindowAppearance::Light),
            Scheme::Light
        );
        assert_eq!(
            resolve_scheme(Mode::Light, WindowAppearance::Dark),
            Scheme::Light
        );
        assert_eq!(
            resolve_scheme(Mode::Dark, WindowAppearance::Light),
            Scheme::Dark
        );
    }

    #[test]
    fn pointer_cursor_policy_honors_the_live_runtime_preference() {
        assert!(!pointer_cursor_policy(None));
        assert!(pointer_cursor_policy(Some(true)));
        assert!(!pointer_cursor_policy(Some(false)));
    }

    #[test]
    fn settings_roundtrip_preserves_the_default_config() {
        let config = create_default_appearance_config();
        let value = appearance_to_settings(&config);
        let mut settings = serde_json::Map::new();
        settings.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
        let back = appearance_from_settings(&settings);
        assert_eq!(back.mode, config.mode);
        assert_eq!(back.light, config.light);
        assert_eq!(back.dark, config.dark);
    }
}
