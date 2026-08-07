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
    AppearanceConfig, Mode, Scheme, ThemeVariantConfig,
};
use gpui::{App, WindowAppearance};
use gpui_component::theme::{Theme, ThemeConfig, ThemeMode};

pub const SETTINGS_APPEARANCE_KEY: &str = "appearance";

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
pub fn build_theme_config(variant: &ThemeVariantConfig, scheme: Scheme, name: &str) -> ThemeConfig {
    let tokens = resolve_theme_tokens(variant, scheme, false);
    let json = theme_config_json(&tokens, name, theme_mode(scheme));
    serde_json::from_value(json).expect("aiden theme config must parse as a gpui ThemeConfig")
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
    set(&mut colors, "sidebar.accent.background", "--accent");
    set(
        &mut colors,
        "sidebar.accent.foreground",
        "--accent-foreground",
    );
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
pub fn apply_appearance(cx: &mut App, config: &AppearanceConfig, scheme: Scheme) {
    let variant = variant_for(config, scheme);
    let name = format!("Aiden {}", scheme_name(scheme));
    let theme_config = build_theme_config(variant, scheme, &name);
    Theme::global_mut(cx).apply_config(&Rc::new(theme_config));
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
            let theme_config = build_theme_config(variant, scheme, "test");
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
                json["highlight"]["syntax"]["keyword"]["color"],
                tokens["--syntax-keyword"]
            );
        }
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
