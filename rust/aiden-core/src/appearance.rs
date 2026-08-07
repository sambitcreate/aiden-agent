//! Port of `renderer/shared/appearance.ts` — theme presets, color tokens,
//! appearance mode, and the strict parse/normalize pipeline for persisted
//! appearance settings.
//!
//! Disk JSON stays byte-compatible with the Electron app: fields serialize as
//! camelCase and colors keep their exact RGBA hex values.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type AppearanceMode = Mode;
pub type AppearanceScheme = Scheme;
pub type ThemePresetId = PresetId;
pub type ThemeSelection = Selection;
pub type UiFontId = UiFont;
pub type CodeFontId = CodeFont;
pub type ReduceMotionPreference = ReduceMotion;
pub type DiffMarkerPreference = DiffMarkers;
pub type DockIconPreference = DockIcon;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Scheme {
    Light,
    Dark,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum PresetId {
    Aiden,
    Slate,
    Berry,
    Moss,
}

impl PresetId {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "aiden" => Some(PresetId::Aiden),
            "slate" => Some(PresetId::Slate),
            "berry" => Some(PresetId::Berry),
            "moss" => Some(PresetId::Moss),
            _ => None,
        }
    }
}

/// `ThemeSelection = ThemePresetId | "custom"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Selection {
    Aiden,
    Slate,
    Berry,
    Moss,
    Custom,
}

impl Selection {
    pub fn is_custom(&self) -> bool {
        matches!(self, Selection::Custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UiFont {
    System,
    Rounded,
    Humanist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub enum CodeFont {
    #[serde(rename = "sf-mono")]
    SfMono,
    #[serde(rename = "menlo")]
    Menlo,
    #[serde(rename = "monaco")]
    Monaco,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReduceMotion {
    System,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffMarkers {
    Color,
    Symbols,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DockIcon {
    Aiden,
    Monochrome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeVariantConfig {
    pub preset: Selection,
    pub accent: String,
    pub background: String,
    pub foreground: String,
    pub ui_font: UiFont,
    pub code_font: CodeFont,
    pub translucent_sidebar: bool,
    pub contrast: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceConfig {
    pub version: u8,
    pub mode: Mode,
    pub light: ThemeVariantConfig,
    pub dark: ThemeVariantConfig,
    pub pointer_cursors: bool,
    pub dock_icon: DockIcon,
    pub reduce_motion: ReduceMotion,
    pub ui_font_size: u8,
    pub code_font_size: u8,
    pub diff_markers: DiffMarkers,
    pub font_smoothing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePreviewSnapshot {
    pub appearance: AppearanceConfig,
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemePalette {
    pub canvas: String,
    pub sidebar: String,
    pub raised: String,
    pub foreground: String,
    pub secondary: String,
    pub accent: String,
    pub success: String,
    pub warning: String,
    pub danger: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemePreset {
    pub id: PresetId,
    pub label: String,
    pub light: ThemePalette,
    pub dark: ThemePalette,
}

/// Font picker options for the settings surface.
#[derive(Debug, Clone, PartialEq)]
pub struct FontOption<T> {
    pub id: T,
    pub label: String,
    pub preview: String,
}

const APPEARANCE_VERSION: u8 = 1;

fn hex_color(chars: &[char]) -> bool {
    chars.len() == 7 && chars[0] == '#' && chars[1..].iter().all(|ch| ch.is_ascii_hexdigit())
}

pub fn is_hex_color(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    hex_color(&chars)
}

fn palette_table() -> &'static [(PresetId, &'static str, ThemePalette, ThemePalette)] {
    static TABLE: OnceLock<Vec<(PresetId, &'static str, ThemePalette, ThemePalette)>> =
        OnceLock::new();
    TABLE.get_or_init(|| {
        vec![
            (
                PresetId::Aiden,
                "Aiden",
                ThemePalette {
                    canvas: "#F6F7F9".into(),
                    sidebar: "#EEF0F3".into(),
                    raised: "#FFFFFF".into(),
                    foreground: "#3D3F41".into(),
                    secondary: "#6B7280".into(),
                    accent: "#006AD6".into(),
                    success: "#30D158".into(),
                    warning: "#FF9F0A".into(),
                    danger: "#FF453A".into(),
                },
                ThemePalette {
                    canvas: "#181B21".into(),
                    sidebar: "#20242C".into(),
                    raised: "#292E37".into(),
                    foreground: "#D1D4DA".into(),
                    secondary: "#9AA3AE".into(),
                    accent: "#3E97F6".into(),
                    success: "#32D17A".into(),
                    warning: "#FFB020".into(),
                    danger: "#FF5E57".into(),
                },
            ),
            (
                PresetId::Slate,
                "Slate",
                ThemePalette {
                    canvas: "#F2F5F9".into(),
                    sidebar: "#E6EBF2".into(),
                    raised: "#FFFFFF".into(),
                    foreground: "#3A434E".into(),
                    secondary: "#637083".into(),
                    accent: "#087581".into(),
                    success: "#2DB67D".into(),
                    warning: "#E0A72E".into(),
                    danger: "#E24D5B".into(),
                },
                ThemePalette {
                    canvas: "#181E26".into(),
                    sidebar: "#202833".into(),
                    raised: "#29323E".into(),
                    foreground: "#D1D6DE".into(),
                    secondary: "#94A3BB".into(),
                    accent: "#21A9BE".into(),
                    success: "#35C08A".into(),
                    warning: "#D4A72C".into(),
                    danger: "#F87171".into(),
                },
            ),
            (
                PresetId::Berry,
                "Berry",
                ThemePalette {
                    canvas: "#FBF4F7".into(),
                    sidebar: "#F1E8EE".into(),
                    raised: "#FFFFFF".into(),
                    foreground: "#443F4A".into(),
                    secondary: "#6E6470".into(),
                    accent: "#B42C70".into(),
                    success: "#22C7A8".into(),
                    warning: "#E3A23C".into(),
                    danger: "#E24C5A".into(),
                },
                ThemePalette {
                    canvas: "#1D1822".into(),
                    sidebar: "#251D2B".into(),
                    raised: "#2E2435".into(),
                    foreground: "#D5CFD6".into(),
                    secondary: "#A39AA6".into(),
                    accent: "#22B69B".into(),
                    success: "#32D1B2".into(),
                    warning: "#D9A441".into(),
                    danger: "#F0717A".into(),
                },
            ),
            (
                PresetId::Moss,
                "Moss",
                ThemePalette {
                    canvas: "#F3F6F4".into(),
                    sidebar: "#E7ECE8".into(),
                    raised: "#FFFFFF".into(),
                    foreground: "#3F4943".into(),
                    secondary: "#65736B".into(),
                    accent: "#157862".into(),
                    success: "#3DBF7D".into(),
                    warning: "#D4A22A".into(),
                    danger: "#E05353".into(),
                },
                ThemePalette {
                    canvas: "#18201C".into(),
                    sidebar: "#202A25".into(),
                    raised: "#29342E".into(),
                    foreground: "#D1D6D3".into(),
                    secondary: "#95A39B".into(),
                    accent: "#42B596".into(),
                    success: "#47D18C".into(),
                    warning: "#D9B43A".into(),
                    danger: "#EB6B6B".into(),
                },
            ),
        ]
    })
}

/// The four built-in theme pairs.
pub fn theme_presets() -> Vec<ThemePreset> {
    palette_table()
        .iter()
        .map(|(id, label, light, dark)| ThemePreset {
            id: *id,
            label: label.to_string(),
            light: light.clone(),
            dark: dark.clone(),
        })
        .collect()
}

pub fn ui_font_options() -> Vec<FontOption<UiFont>> {
    vec![
        FontOption {
            id: UiFont::System,
            label: "System".into(),
            preview: "-apple-system, BlinkMacSystemFont".into(),
        },
        FontOption {
            id: UiFont::Rounded,
            label: "Rounded".into(),
            preview: "SF Pro Rounded".into(),
        },
        FontOption {
            id: UiFont::Humanist,
            label: "Humanist".into(),
            preview: "Avenir Next".into(),
        },
    ]
}

pub fn code_font_options() -> Vec<FontOption<CodeFont>> {
    vec![
        FontOption {
            id: CodeFont::SfMono,
            label: "SF Mono".into(),
            preview: "ui-monospace, SFMono-Regular".into(),
        },
        FontOption {
            id: CodeFont::Menlo,
            label: "Menlo".into(),
            preview: "Menlo, Monaco".into(),
        },
        FontOption {
            id: CodeFont::Monaco,
            label: "Monaco".into(),
            preview: "Monaco, Menlo".into(),
        },
    ]
}

fn palette(id: PresetId, scheme: Scheme) -> &'static ThemePalette {
    for (preset_id, _, light, dark) in palette_table() {
        if *preset_id == id {
            return match scheme {
                Scheme::Light => light,
                Scheme::Dark => dark,
            };
        }
    }
    unreachable!("unknown preset id")
}

fn clamp(value: i32, minimum: i32, maximum: i32) -> i32 {
    value.max(minimum).min(maximum)
}

fn clamp_f64(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

fn clone_variant(value: &ThemeVariantConfig) -> ThemeVariantConfig {
    value.clone()
}

pub fn get_preset_variant(id: PresetId, scheme: Scheme) -> ThemeVariantConfig {
    let palette = palette(id, scheme);
    ThemeVariantConfig {
        preset: match id {
            PresetId::Aiden => Selection::Aiden,
            PresetId::Slate => Selection::Slate,
            PresetId::Berry => Selection::Berry,
            PresetId::Moss => Selection::Moss,
        },
        accent: palette.accent.clone(),
        background: palette.canvas.clone(),
        foreground: palette.foreground.clone(),
        ui_font: UiFont::System,
        code_font: CodeFont::SfMono,
        translucent_sidebar: true,
        contrast: match scheme {
            Scheme::Light => 45,
            Scheme::Dark => 60,
        },
    }
}

pub fn create_default_appearance_config() -> AppearanceConfig {
    AppearanceConfig {
        version: APPEARANCE_VERSION,
        mode: Mode::System,
        light: get_preset_variant(PresetId::Aiden, Scheme::Light),
        dark: get_preset_variant(PresetId::Aiden, Scheme::Dark),
        pointer_cursors: false,
        dock_icon: DockIcon::Aiden,
        reduce_motion: ReduceMotion::System,
        ui_font_size: 14,
        code_font_size: 12,
        diff_markers: DiffMarkers::Symbols,
        font_smoothing: true,
    }
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn is_theme_preset_id(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => PresetId::from_str(value).is_some(),
        None => false,
    }
}

fn is_ui_font_id(value: &Value) -> bool {
    matches!(value.as_str(), Some("system" | "rounded" | "humanist"))
}

fn is_code_font_id(value: &Value) -> bool {
    matches!(value.as_str(), Some("sf-mono" | "menlo" | "monaco"))
}

fn normalize_variant(value: &Value, fallback: &ThemeVariantConfig) -> ThemeVariantConfig {
    if !is_record(value) {
        return clone_variant(fallback);
    }
    let preset = if value.get("preset") == Some(&Value::String("custom".into()))
        || is_theme_preset_id(value.get("preset").unwrap_or(&Value::Null))
    {
        selection_from_value(value.get("preset").unwrap_or(&Value::Null))
    } else {
        fallback.preset
    };
    ThemeVariantConfig {
        preset,
        accent: color_or_fallback(value.get("accent"), &fallback.accent),
        background: color_or_fallback(value.get("background"), &fallback.background),
        foreground: color_or_fallback(value.get("foreground"), &fallback.foreground),
        ui_font: if is_ui_font_id(value.get("uiFont").unwrap_or(&Value::Null)) {
            ui_font_from_value(value.get("uiFont").unwrap())
        } else {
            fallback.ui_font
        },
        code_font: if is_code_font_id(value.get("codeFont").unwrap_or(&Value::Null)) {
            code_font_from_value(value.get("codeFont").unwrap())
        } else {
            fallback.code_font
        },
        translucent_sidebar: match value.get("translucentSidebar") {
            Some(Value::Bool(enabled)) => *enabled,
            _ => fallback.translucent_sidebar,
        },
        contrast: match value.get("contrast").and_then(Value::as_f64) {
            Some(contrast) if contrast.is_finite() => clamp((contrast.round()) as i32, 0, 100),
            _ => fallback.contrast,
        },
    }
}

fn color_or_fallback(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(color)) if is_hex_color(color) => color.to_ascii_uppercase(),
        _ => fallback.to_string(),
    }
}

fn selection_from_value(value: &Value) -> Selection {
    match value.as_str() {
        Some("custom") => Selection::Custom,
        Some("aiden") => Selection::Aiden,
        Some("slate") => Selection::Slate,
        Some("berry") => Selection::Berry,
        Some("moss") => Selection::Moss,
        _ => Selection::Aiden,
    }
}

fn ui_font_from_value(value: &Value) -> UiFont {
    match value.as_str() {
        Some("rounded") => UiFont::Rounded,
        Some("humanist") => UiFont::Humanist,
        _ => UiFont::System,
    }
}

fn code_font_from_value(value: &Value) -> CodeFont {
    match value.as_str() {
        Some("menlo") => CodeFont::Menlo,
        Some("monaco") => CodeFont::Monaco,
        _ => CodeFont::SfMono,
    }
}

fn normalize_stored_variant(
    value: &Value,
    fallback: &ThemeVariantConfig,
    scheme: Scheme,
) -> ThemeVariantConfig {
    if is_record(value) && is_theme_preset_id(value.get("preset").unwrap_or(&Value::Null)) {
        let id = PresetId::from_str(value.get("preset").unwrap().as_str().unwrap()).unwrap();
        return get_preset_variant(id, scheme);
    }
    normalize_variant(value, fallback)
}

pub fn normalize_appearance_config(value: &Value) -> AppearanceConfig {
    let fallback = create_default_appearance_config();
    if !is_record(value) {
        return fallback;
    }
    AppearanceConfig {
        version: APPEARANCE_VERSION,
        mode: match value.get("mode").and_then(Value::as_str) {
            Some("light") => Mode::Light,
            Some("dark") => Mode::Dark,
            Some("system") => Mode::System,
            _ => fallback.mode,
        },
        light: normalize_stored_variant(
            value.get("light").unwrap_or(&Value::Null),
            &fallback.light,
            Scheme::Light,
        ),
        dark: normalize_stored_variant(
            value.get("dark").unwrap_or(&Value::Null),
            &fallback.dark,
            Scheme::Dark,
        ),
        pointer_cursors: match value.get("pointerCursors") {
            Some(Value::Bool(enabled)) => *enabled,
            _ => fallback.pointer_cursors,
        },
        dock_icon: match value.get("dockIcon").and_then(Value::as_str) {
            Some("monochrome") => DockIcon::Monochrome,
            Some("aiden") => DockIcon::Aiden,
            _ => fallback.dock_icon,
        },
        reduce_motion: match value.get("reduceMotion").and_then(Value::as_str) {
            Some("on") => ReduceMotion::On,
            Some("off") => ReduceMotion::Off,
            Some("system") => ReduceMotion::System,
            _ => fallback.reduce_motion,
        },
        ui_font_size: clamp_font_size(
            value.get("uiFontSize").and_then(Value::as_f64),
            fallback.ui_font_size,
            12,
            18,
        ),
        code_font_size: clamp_font_size(
            value.get("codeFontSize").and_then(Value::as_f64),
            fallback.code_font_size,
            10,
            18,
        ),
        diff_markers: match value.get("diffMarkers").and_then(Value::as_str) {
            Some("symbols") => DiffMarkers::Symbols,
            Some("color") => DiffMarkers::Color,
            _ => fallback.diff_markers,
        },
        font_smoothing: match value.get("fontSmoothing") {
            Some(Value::Bool(enabled)) => *enabled,
            _ => fallback.font_smoothing,
        },
    }
}

fn clamp_font_size(value: Option<f64>, fallback: u8, minimum: i32, maximum: i32) -> u8 {
    match value {
        Some(size) if size.is_finite() => clamp(size.round() as i32, minimum, maximum) as u8,
        _ => fallback,
    }
}

/// Strict parsing of a persisted appearance document. Returns the exact error
/// messages the Electron app surfaces.
pub fn parse_appearance_config(value: &Value) -> Result<AppearanceConfig, String> {
    if !is_record(value) {
        return Err("Appearance settings must be an object.".to_string());
    }
    if let Some(version) = value.get("version") {
        if version != &Value::from(APPEARANCE_VERSION) {
            return Err("Appearance settings use an unsupported version.".to_string());
        }
    }
    let required = [
        "mode",
        "light",
        "dark",
        "pointerCursors",
        "dockIcon",
        "reduceMotion",
        "uiFontSize",
        "codeFontSize",
        "diffMarkers",
        "fontSmoothing",
    ];
    if required.iter().any(|key| !value.get(key).is_some()) {
        return Err("Appearance settings are incomplete.".to_string());
    }
    let normalized = normalize_appearance_config(value);

    fn verify_variant(variant: &Value, label: &str) -> Result<(), String> {
        let Some(object) = variant.as_object() else {
            return Err(format!("{label} theme must be an object."));
        };
        for key in ["accent", "background", "foreground"] {
            let ok = match object.get(key) {
                Some(Value::String(color)) => is_hex_color(color),
                _ => false,
            };
            if !ok {
                return Err(format!("{label} theme has an invalid {key} color."));
            }
        }
        let preset = object.get("preset");
        if !matches!(preset, Some(Value::String(s)) if s == "custom" || PresetId::from_str(s).is_some())
        {
            return Err(format!("{label} theme has an unsupported preset."));
        }
        if !is_ui_font_id(object.get("uiFont").unwrap_or(&Value::Null))
            || !is_code_font_id(object.get("codeFont").unwrap_or(&Value::Null))
        {
            return Err(format!("{label} theme has an unsupported font selection."));
        }
        if !matches!(object.get("translucentSidebar"), Some(Value::Bool(_))) {
            return Err(format!("{label} theme has an invalid sidebar preference."));
        }
        let contrast_ok = object
            .get("contrast")
            .and_then(Value::as_f64)
            .map(|contrast| contrast.is_finite() && (0.0..=100.0).contains(&contrast))
            .unwrap_or(false);
        if !contrast_ok {
            return Err(format!("{label} theme contrast must be between 0 and 100."));
        }
        Ok(())
    }

    verify_variant(value.get("light").unwrap_or(&Value::Null), "Light")?;
    verify_variant(value.get("dark").unwrap_or(&Value::Null), "Dark")?;

    let light_safety_issues = theme_variant_safety_issues(&normalized.light, Scheme::Light);
    let dark_safety_issues = theme_variant_safety_issues(&normalized.dark, Scheme::Dark);
    let mut issues = light_safety_issues;
    issues.extend(dark_safety_issues);
    if !issues.is_empty() {
        return Err(issues.join(" "));
    }

    if !matches!(value.get("pointerCursors"), Some(Value::Bool(_)))
        || !matches!(value.get("fontSmoothing"), Some(Value::Bool(_)))
    {
        return Err("Appearance toggle preferences must be boolean values.".to_string());
    }
    let raw_mode = value
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let raw_dock_icon = value
        .get("dockIcon")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let raw_reduce = value
        .get("reduceMotion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let raw_diff = value
        .get("diffMarkers")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mode_as_str(&normalized.mode) != raw_mode
        || dock_icon_as_str(&normalized.dock_icon) != raw_dock_icon
        || reduce_motion_as_str(&normalized.reduce_motion) != raw_reduce
        || diff_markers_as_str(&normalized.diff_markers) != raw_diff
    {
        return Err("Appearance settings contain an unsupported option.".to_string());
    }
    let raw_ui_font_size = value
        .get("uiFontSize")
        .and_then(Value::as_f64)
        .unwrap_or(-1.0);
    let raw_code_font_size = value
        .get("codeFontSize")
        .and_then(Value::as_f64)
        .unwrap_or(-1.0);
    if normalized.ui_font_size as f64 != raw_ui_font_size
        || normalized.code_font_size as f64 != raw_code_font_size
    {
        return Err("Appearance font sizes are outside the supported range.".to_string());
    }
    Ok(normalized)
}

fn mode_as_str(mode: &Mode) -> &'static str {
    match mode {
        Mode::System => "system",
        Mode::Light => "light",
        Mode::Dark => "dark",
    }
}

fn dock_icon_as_str(icon: &DockIcon) -> &'static str {
    match icon {
        DockIcon::Aiden => "aiden",
        DockIcon::Monochrome => "monochrome",
    }
}

fn reduce_motion_as_str(preference: &ReduceMotion) -> &'static str {
    match preference {
        ReduceMotion::System => "system",
        ReduceMotion::On => "on",
        ReduceMotion::Off => "off",
    }
}

fn diff_markers_as_str(preference: &DiffMarkers) -> &'static str {
    match preference {
        DiffMarkers::Color => "color",
        DiffMarkers::Symbols => "symbols",
    }
}

/// Parse an exported per-scheme theme JSON document.
pub fn parse_theme_variant_json(text: &str, scheme: Scheme) -> Result<ThemeVariantConfig, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| "The selected file is not valid JSON.".to_string())?;
    if !is_record(&value) {
        return Err("The theme file must contain an object.".to_string());
    }
    if let Some(version) = value.get("version") {
        if version != &Value::from(APPEARANCE_VERSION) {
            return Err("The theme file uses an unsupported version.".to_string());
        }
    }
    if let Some(file_scheme) = value.get("scheme").and_then(Value::as_str) {
        if file_scheme != scheme_as_str(scheme) {
            return Err(format!(
                "This is a {file_scheme} theme, not a {} theme.",
                scheme_as_str(scheme)
            ));
        }
    }
    let candidate = match value.get("theme") {
        Some(theme) if theme.is_object() => theme,
        _ => &value,
    };
    for key in ["accent", "background", "foreground"] {
        let ok = match candidate.get(key) {
            Some(Value::String(color)) => is_hex_color(color),
            _ => false,
        };
        if !ok {
            return Err(format!("The theme has an invalid {key} color."));
        }
    }
    if !is_ui_font_id(candidate.get("uiFont").unwrap_or(&Value::Null))
        || !is_code_font_id(candidate.get("codeFont").unwrap_or(&Value::Null))
    {
        return Err("The theme has an unsupported font selection.".to_string());
    }
    if !matches!(candidate.get("translucentSidebar"), Some(Value::Bool(_))) {
        return Err("The theme has an invalid sidebar preference.".to_string());
    }
    let contrast_ok = candidate
        .get("contrast")
        .and_then(Value::as_f64)
        .map(|contrast| contrast.is_finite() && (0.0..=100.0).contains(&contrast))
        .unwrap_or(false);
    if !contrast_ok {
        return Err("Theme contrast must be between 0 and 100.".to_string());
    }
    let preset = candidate.get("preset").unwrap_or(&Value::Null);
    if !matches!(preset, Value::Null)
        && !matches!(preset, Value::String(s) if s == "custom" || PresetId::from_str(s).is_some())
    {
        return Err("The theme has an unsupported preset.".to_string());
    }

    let normalized = normalize_variant(candidate, &get_preset_variant(PresetId::Aiden, scheme));
    let claimed_preset = preset.as_str().and_then(PresetId::from_str);
    let matches_claimed_preset = match claimed_preset {
        Some(id) => {
            let claimed = get_preset_variant(id, scheme);
            normalized.accent == claimed.accent
                && normalized.background == claimed.background
                && normalized.foreground == claimed.foreground
                && normalized.ui_font == claimed.ui_font
                && normalized.code_font == claimed.code_font
                && normalized.translucent_sidebar == claimed.translucent_sidebar
                && normalized.contrast == claimed.contrast
        }
        None => false,
    };
    let result = ThemeVariantConfig {
        preset: if matches_claimed_preset {
            selection_from_value(preset)
        } else {
            Selection::Custom
        },
        ..normalized
    };
    let safety_issues = theme_variant_safety_issues(&result, scheme);
    if !safety_issues.is_empty() {
        return Err(safety_issues.join(" "));
    }
    Ok(result)
}

fn scheme_as_str(scheme: Scheme) -> &'static str {
    match scheme {
        Scheme::Light => "light",
        Scheme::Dark => "dark",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ThemeVariantFile {
    version: u8,
    scheme: Scheme,
    theme: ThemeVariantConfig,
}

/// Serialize a variant for export as a standalone theme file.
pub fn serialize_theme_variant(
    variant: &ThemeVariantConfig,
    scheme: Scheme,
) -> Result<String, serde_json::Error> {
    let file = ThemeVariantFile {
        version: APPEARANCE_VERSION,
        scheme,
        theme: variant.clone(),
    };
    serde_json::to_string_pretty(&file)
}

#[derive(Debug, Clone, Copy)]
struct Rgb {
    red: f64,
    green: f64,
    blue: f64,
}

fn hex_to_rgb(hex: &str) -> Option<Rgb> {
    if !is_hex_color(hex) {
        return None;
    }
    let red = i64::from_str_radix(&hex[1..3], 16).ok()? as f64;
    let green = i64::from_str_radix(&hex[3..5], 16).ok()? as f64;
    let blue = i64::from_str_radix(&hex[5..7], 16).ok()? as f64;
    Some(Rgb { red, green, blue })
}

fn channel_hex(value: f64) -> String {
    let clamped = value.round().clamp(0.0, 255.0) as u32;
    format!("{clamped:02x}")
}

fn rgb_to_hex(value: Rgb) -> String {
    format!(
        "#{}{}{}",
        channel_hex(value.red),
        channel_hex(value.green),
        channel_hex(value.blue)
    )
    .to_ascii_uppercase()
}

fn mix_hex(from: &str, to: &str, amount: f64) -> String {
    let a = hex_to_rgb(from).unwrap();
    let b = hex_to_rgb(to).unwrap();
    let weight = clamp_f64(amount, 0.0, 1.0);
    rgb_to_hex(Rgb {
        red: a.red + (b.red - a.red) * weight,
        green: a.green + (b.green - a.green) * weight,
        blue: a.blue + (b.blue - a.blue) * weight,
    })
}

/// ECMAScript `Number#toFixed(digits)` for `digits == 2 | 3` on positive
/// values: round half away from zero on the exact double.
fn to_fixed(value: f64, digits: u32) -> String {
    let factor = 10f64.powi(digits as i32);
    let scaled = (value * factor).round();
    let scaled = scaled as i64;
    let whole = scaled / (factor as i64);
    let fraction = (scaled % (factor as i64)).abs();
    if digits == 0 {
        format!("{whole}")
    } else {
        format!("{whole}.{fraction:0width$}", width = digits as usize)
    }
}

fn alpha_hex(hex: &str, alpha: f64) -> String {
    let rgb = hex_to_rgb(hex).unwrap();
    format!(
        "rgb({} {} {} / {})",
        rgb.red as u32,
        rgb.green as u32,
        rgb.blue as u32,
        to_fixed(clamp_f64(alpha, 0.0, 1.0), 3)
    )
}

fn minimum_contrast_ratio(color: &str, surfaces: &[String]) -> f64 {
    surfaces
        .iter()
        .map(|surface| color_contrast_ratio(color, surface))
        .fold(f64::INFINITY, f64::min)
}

fn contrast_correct_color(
    preferred: &str,
    surfaces: &[String],
    minimum: f64,
    fallbacks: &[String],
) -> String {
    let normalized = mix_hex(preferred, preferred, 0.0);
    if minimum_contrast_ratio(&normalized, surfaces) >= minimum {
        return normalized;
    }
    let steps = 256;
    for index in 1..=steps {
        let amount = index as f64 / steps as f64;
        let candidates = [
            mix_hex(&normalized, "#000000", amount),
            mix_hex(&normalized, "#FFFFFF", amount),
        ];
        let readable: Vec<String> = candidates
            .iter()
            .filter(|candidate| minimum_contrast_ratio(candidate, surfaces) >= minimum)
            .cloned()
            .collect();
        if !readable.is_empty() {
            let mut best = &readable[0];
            let mut best_ratio = minimum_contrast_ratio(best, surfaces);
            for candidate in readable.iter().skip(1) {
                let ratio = minimum_contrast_ratio(candidate, surfaces);
                if ratio > best_ratio {
                    best = candidate;
                    best_ratio = ratio;
                }
            }
            return best.clone();
        }
    }
    let mut fallback_candidates: Vec<String> = fallbacks
        .iter()
        .map(|candidate| mix_hex(candidate, candidate, 0.0))
        .collect();
    fallback_candidates.push("#000000".to_string());
    fallback_candidates.push("#FFFFFF".to_string());
    if let Some(readable) = fallback_candidates
        .iter()
        .find(|candidate| minimum_contrast_ratio(candidate, surfaces) >= minimum)
    {
        return readable.clone();
    }
    let mut best = &fallback_candidates[0];
    let mut best_ratio = minimum_contrast_ratio(best, surfaces);
    for candidate in fallback_candidates.iter().skip(1) {
        let ratio = minimum_contrast_ratio(candidate, surfaces);
        if ratio > best_ratio {
            best = candidate;
            best_ratio = ratio;
        }
    }
    best.clone()
}

fn foreground_for_fill(fill: &str, scheme: Scheme) -> String {
    let preferred = match scheme {
        Scheme::Light => "#FFFFFF",
        Scheme::Dark => "#000000",
    };
    let alternate = if preferred == "#FFFFFF" {
        "#000000"
    } else {
        "#FFFFFF"
    };
    if color_contrast_ratio(fill, preferred) >= 4.5 {
        preferred.to_string()
    } else {
        alternate.to_string()
    }
}

fn selected_palette(variant: &ThemeVariantConfig, scheme: Scheme) -> &'static ThemePalette {
    match variant.preset {
        Selection::Custom => palette(PresetId::Aiden, scheme),
        _ => palette(preset_from_selection(variant.preset), scheme),
    }
}

fn preset_from_selection(selection: Selection) -> PresetId {
    match selection {
        Selection::Aiden => PresetId::Aiden,
        Selection::Slate => PresetId::Slate,
        Selection::Berry => PresetId::Berry,
        Selection::Moss => PresetId::Moss,
        Selection::Custom => PresetId::Aiden,
    }
}

pub fn ui_font_stack(id: UiFont) -> &'static str {
    match id {
        UiFont::Rounded => {
            "\"SF Pro Rounded\", -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
        }
        UiFont::Humanist => {
            "\"Avenir Next\", Avenir, -apple-system, BlinkMacSystemFont, sans-serif"
        }
        UiFont::System => {
            "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", sans-serif"
        }
    }
}

pub fn code_font_stack(id: CodeFont) -> &'static str {
    match id {
        CodeFont::Menlo => "Menlo, Monaco, \"Courier New\", monospace",
        CodeFont::Monaco => "Monaco, Menlo, \"Courier New\", monospace",
        CodeFont::SfMono => "ui-monospace, \"SFMono-Regular\", Menlo, Monaco, Consolas, monospace",
    }
}

/// The resolved CSS custom-property map for one variant/scheme pair.
pub fn resolve_theme_tokens(
    variant: &ThemeVariantConfig,
    scheme: Scheme,
    system_high_contrast: bool,
) -> BTreeMap<String, String> {
    let palette = selected_palette(variant, scheme);
    let contrast = clamp_f64(
        (variant.contrast + if system_high_contrast { 20 } else { 0 }) as f64 / 100.0,
        0.0,
        1.0,
    );
    let foreground = variant.foreground.clone();
    let background = variant.background.clone();
    let light = scheme == Scheme::Light;
    let raised = if variant.preset == Selection::Custom {
        mix_hex(
            &background,
            if light { "#FFFFFF" } else { &foreground },
            if light { 0.72 } else { 0.08 + contrast * 0.04 },
        )
    } else {
        palette.raised.clone()
    };
    let sidebar = if variant.preset == Selection::Custom {
        mix_hex(
            &background,
            &foreground,
            0.025 + contrast * if light { 0.025 } else { 0.045 },
        )
    } else {
        palette.sidebar.clone()
    };
    let text_surfaces = vec![background.clone(), sidebar.clone(), raised.clone()];
    let toolbar_icon = contrast_correct_color(
        &mix_hex(&foreground, "#FFFFFF", if light { 0.3 } else { 0.08 }),
        &text_surfaces,
        3.0,
        &[foreground.clone(), variant.accent.clone()],
    );
    let secondary_base_value = if variant.preset == Selection::Custom {
        mix_hex(&background, &foreground, if light { 0.64 } else { 0.7 })
    } else {
        palette.secondary.clone()
    };
    let secondary_base = contrast_correct_color(
        &secondary_base_value,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let text_secondary = contrast_correct_color(
        &mix_hex(&secondary_base, &foreground, 0.28),
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let text_tertiary = contrast_correct_color(
        &mix_hex(&secondary_base, &foreground, 0.14),
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let text_quaternary = contrast_correct_color(
        &secondary_base,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let control_alpha = 0.055 + contrast * 0.065;
    let border_alpha = 0.09 + contrast * 0.12;
    let accent_foreground = if color_contrast_ratio(&variant.accent, "#FFFFFF")
        >= color_contrast_ratio(&variant.accent, "#000000")
    {
        "#FFFFFF"
    } else {
        "#000000"
    };
    let accent_contrast_target = if accent_foreground == "#FFFFFF" {
        "#000000"
    } else {
        "#FFFFFF"
    };
    let accent_hover = mix_hex(
        &variant.accent,
        accent_contrast_target,
        if light { 0.07 } else { 0.14 },
    );
    let accent_active = mix_hex(
        &variant.accent,
        accent_contrast_target,
        if light { 0.14 } else { 0.22 },
    );
    let support_red = contrast_correct_color(
        &palette.danger,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let support_green = contrast_correct_color(
        &palette.success,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let support_warning = contrast_correct_color(
        &palette.warning,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let syntax_keyword = contrast_correct_color(
        if light { "#C83349" } else { "#FF7F8D" },
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let syntax_string_value = if light {
        mix_hex("#176B58", &variant.accent, 0.12)
    } else {
        mix_hex("#8CE0C6", &variant.accent, 0.12)
    };
    let syntax_string = contrast_correct_color(
        &syntax_string_value,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let syntax_number_value = if light {
        mix_hex("#2D5BA7", &variant.accent, 0.22)
    } else {
        mix_hex("#92BFFF", &variant.accent, 0.24)
    };
    let syntax_number = contrast_correct_color(
        &syntax_number_value,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let syntax_title_value = if light {
        mix_hex("#7546A8", &variant.accent, 0.12)
    } else {
        mix_hex("#D4A8FF", &variant.accent, 0.12)
    };
    let syntax_title = contrast_correct_color(
        &syntax_title_value,
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );
    let syntax_variable = contrast_correct_color(
        if light { "#C45C19" } else { "#FFB06B" },
        &text_surfaces,
        4.5,
        &[foreground.clone(), variant.accent.clone()],
    );

    let mut tokens = BTreeMap::new();
    tokens.insert("--text-primary".into(), foreground.clone());
    tokens.insert("--toolbar-icon".into(), toolbar_icon);
    tokens.insert("--text-secondary".into(), text_secondary);
    tokens.insert("--text-tertiary".into(), text_tertiary.clone());
    tokens.insert("--text-quaternary".into(), text_quaternary);
    tokens.insert("--surface-background".into(), alpha_hex(&background, 0.94));
    tokens.insert(
        "--surface-sidebar".into(),
        alpha_hex(
            &sidebar,
            if variant.translucent_sidebar {
                0.78
            } else {
                1.0
            },
        ),
    );
    tokens.insert("--surface-popover".into(), raised.clone());
    tokens.insert("--surface-context-bar".into(), alpha_hex(&sidebar, 0.8));
    tokens.insert(
        "--surface-control".into(),
        alpha_hex(&foreground, control_alpha),
    );
    tokens.insert(
        "--surface-control-hover".into(),
        alpha_hex(&foreground, control_alpha + 0.045),
    );
    tokens.insert(
        "--surface-control-active".into(),
        alpha_hex(&foreground, control_alpha + 0.1),
    );
    tokens.insert(
        "--surface-input".into(),
        alpha_hex(&foreground, 0.035 + contrast * 0.035),
    );
    tokens.insert(
        "--surface-well".into(),
        alpha_hex(&foreground, 0.018 + contrast * 0.024),
    );
    tokens.insert(
        "--surface-list-hover".into(),
        alpha_hex(&foreground, 0.035 + contrast * 0.04),
    );
    tokens.insert(
        "--surface-list-selection".into(),
        alpha_hex(&variant.accent, if light { 0.12 } else { 0.18 }),
    );
    tokens.insert(
        "--border-field".into(),
        alpha_hex(&foreground, border_alpha),
    );
    tokens.insert(
        "--border-separator".into(),
        alpha_hex(&foreground, 0.055 + contrast * 0.07),
    );
    tokens.insert("--accent".into(), variant.accent.clone());
    tokens.insert("--accent-foreground".into(), accent_foreground.to_string());
    tokens.insert("--accent-hover".into(), accent_hover);
    tokens.insert("--accent-active".into(), accent_active);
    tokens.insert(
        "--focus-ring".into(),
        contrast_correct_color(
            &variant.accent,
            &text_surfaces,
            3.0,
            std::slice::from_ref(&foreground),
        ),
    );
    tokens.insert("--support-red".into(), support_red.clone());
    tokens.insert(
        "--support-red-foreground".into(),
        foreground_for_fill(&support_red, scheme),
    );
    tokens.insert("--support-green".into(), support_green.clone());
    tokens.insert(
        "--support-green-foreground".into(),
        foreground_for_fill(&support_green, scheme),
    );
    tokens.insert("--support-warning".into(), support_warning.clone());
    tokens.insert(
        "--support-warning-foreground".into(),
        foreground_for_fill(&support_warning, scheme),
    );
    tokens.insert(
        "--window-gradient-start".into(),
        alpha_hex(&background, 0.98),
    );
    tokens.insert(
        "--window-gradient-end".into(),
        alpha_hex(&mix_hex(&background, &sidebar, 0.55), 0.94),
    );
    tokens.insert(
        "--glass-fill".into(),
        alpha_hex(
            &sidebar,
            if variant.translucent_sidebar {
                0.68
            } else {
                0.96
            },
        ),
    );
    tokens.insert("--syntax-comment".into(), text_tertiary);
    tokens.insert("--syntax-keyword".into(), syntax_keyword);
    tokens.insert("--syntax-string".into(), syntax_string);
    tokens.insert("--syntax-number".into(), syntax_number);
    tokens.insert("--syntax-title".into(), syntax_title);
    tokens.insert("--syntax-variable".into(), syntax_variable);
    tokens.insert("--terminal-background".into(), raised.clone());
    tokens.insert("--terminal-foreground".into(), foreground.clone());
    tokens.insert("--terminal-cursor".into(), variant.accent.clone());
    tokens.insert(
        "--terminal-selection".into(),
        alpha_hex(&variant.accent, if light { 0.2 } else { 0.3 }),
    );
    tokens.insert(
        "--terminal-black".into(),
        contrast_correct_color(
            &mix_hex(&background, &foreground, if light { 0.18 } else { 0.1 }),
            &text_surfaces,
            4.5,
            &[foreground.clone(), variant.accent.clone()],
        ),
    );
    tokens.insert("--terminal-red".into(), support_red);
    tokens.insert("--terminal-green".into(), support_green);
    tokens.insert("--terminal-yellow".into(), support_warning);
    tokens.insert(
        "--terminal-blue".into(),
        contrast_correct_color(
            &mix_hex(
                &variant.accent,
                if light { "#233C75" } else { "#D8E7FF" },
                0.22,
            ),
            &text_surfaces,
            4.5,
            &[foreground.clone(), variant.accent.clone()],
        ),
    );
    tokens.insert(
        "--terminal-magenta".into(),
        contrast_correct_color(
            if light { "#895A9D" } else { "#DCBAFF" },
            &text_surfaces,
            4.5,
            &[foreground.clone(), variant.accent.clone()],
        ),
    );
    tokens.insert(
        "--terminal-cyan".into(),
        contrast_correct_color(
            if light { "#367D8C" } else { "#91E9EE" },
            &text_surfaces,
            4.5,
            &[foreground.clone(), variant.accent.clone()],
        ),
    );
    tokens.insert(
        "--terminal-white".into(),
        contrast_correct_color(
            if light { "#DDE2E8" } else { &foreground },
            &text_surfaces,
            4.5,
            &[foreground.clone(), variant.accent.clone()],
        ),
    );
    tokens.insert("--theme-canvas".into(), background.clone());
    tokens.insert("--theme-sidebar".into(), sidebar);
    tokens.insert("--theme-raised".into(), raised);
    tokens
}

fn relative_luminance_channel(channel: f64) -> f64 {
    let value = channel / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG contrast ratio; returns 0 for non-hex inputs (matching the TS guard).
pub fn color_contrast_ratio(first: &str, second: &str) -> f64 {
    if !is_hex_color(first) || !is_hex_color(second) {
        return 0.0;
    }
    let luminance = |hex: &str| {
        let rgb = hex_to_rgb(hex).unwrap();
        0.2126 * relative_luminance_channel(rgb.red)
            + 0.7152 * relative_luminance_channel(rgb.green)
            + 0.0722 * relative_luminance_channel(rgb.blue)
    };
    let a = luminance(first);
    let b = luminance(second);
    let lightest = a.max(b);
    let darkest = a.min(b);
    (lightest + 0.05) / (darkest + 0.05)
}

/// Safety diagnostics for a theme variant. Valid custom themes always provide
/// at least one readable accent fallback, so semantic roles can recover from a
/// palette collision without rejecting otherwise-safe primitives.
pub fn theme_variant_safety_issues(variant: &ThemeVariantConfig, scheme: Scheme) -> Vec<String> {
    let label = match scheme {
        Scheme::Light => "Light theme",
        Scheme::Dark => "Dark theme",
    };
    let mut issues: Vec<String> = Vec::new();
    let palette = selected_palette(variant, scheme);
    let raised = if variant.preset == Selection::Custom {
        mix_hex(
            &variant.background,
            if scheme == Scheme::Light {
                "#FFFFFF"
            } else {
                &variant.foreground
            },
            if scheme == Scheme::Light { 0.72 } else { 0.12 },
        )
    } else {
        palette.raised.clone()
    };
    let sidebar = if variant.preset == Selection::Custom {
        mix_hex(
            &variant.background,
            &variant.foreground,
            if scheme == Scheme::Light { 0.05 } else { 0.07 },
        )
    } else {
        palette.sidebar.clone()
    };
    let text_ratio = color_contrast_ratio(&variant.foreground, &variant.background)
        .min(color_contrast_ratio(&variant.foreground, &sidebar))
        .min(color_contrast_ratio(&variant.foreground, &raised));
    if text_ratio < 4.5 {
        issues.push(format!(
            "{label} foreground needs at least 4.5:1 contrast against its surfaces (currently {}:1).",
            to_fixed(text_ratio, 2)
        ));
    }
    let weakest_surface_ratio = color_contrast_ratio(&variant.accent, &variant.background)
        .min(color_contrast_ratio(&variant.accent, &sidebar))
        .min(color_contrast_ratio(&variant.accent, &raised));
    if weakest_surface_ratio < 4.5 {
        issues.push(format!(
            "{label} accent needs at least 4.5:1 contrast against its surfaces (currently {}:1).",
            to_fixed(weakest_surface_ratio, 2)
        ));
    }
    let on_accent_ratio = color_contrast_ratio(&variant.accent, "#FFFFFF")
        .max(color_contrast_ratio(&variant.accent, "#000000"));
    if on_accent_ratio < 4.5 {
        issues.push(format!(
            "{label} accent cannot provide readable control text."
        ));
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NORMAL_TEXT_TOKENS: &[&str] = &[
        "--text-secondary",
        "--text-tertiary",
        "--text-quaternary",
        "--syntax-comment",
        "--syntax-keyword",
        "--syntax-string",
        "--syntax-number",
        "--syntax-title",
        "--syntax-variable",
        "--support-red",
        "--support-green",
        "--support-warning",
        "--terminal-foreground",
        "--terminal-black",
        "--terminal-red",
        "--terminal-green",
        "--terminal-yellow",
        "--terminal-blue",
        "--terminal-magenta",
        "--terminal-cyan",
        "--terminal-white",
    ];

    fn assert_semantic_contrast(variant: &ThemeVariantConfig, scheme: Scheme, label: &str) {
        let tokens = resolve_theme_tokens(variant, scheme, false);
        let surfaces = [
            tokens["--theme-canvas"].clone(),
            tokens["--theme-sidebar"].clone(),
            tokens["--surface-popover"].clone(),
        ];
        for role in NORMAL_TEXT_TOKENS {
            for surface in &surfaces {
                assert!(
                    color_contrast_ratio(&tokens[*role], surface) >= 4.5,
                    "{label} {role} remains readable on {surface}"
                );
            }
        }
        for support in ["red", "green", "warning"] {
            assert!(
                color_contrast_ratio(
                    &tokens[&format!("--support-{support}")],
                    &tokens[&format!("--support-{support}-foreground")],
                ) >= 4.5,
                "{label} {support} fill has readable content"
            );
        }
        for state in ["--accent", "--accent-hover", "--accent-active"] {
            assert!(
                color_contrast_ratio(&tokens[state], &tokens["--accent-foreground"]) >= 4.5,
                "{label} {state} has readable control content"
            );
        }
        for surface in &surfaces {
            assert!(
                color_contrast_ratio(&tokens["--toolbar-icon"], surface) >= 3.0,
                "{label} toolbar icon remains visible on {surface}"
            );
            assert!(
                color_contrast_ratio(&tokens["--focus-ring"], surface) >= 3.0,
                "{label} focus ring remains visible on {surface}"
            );
        }
    }

    #[test]
    fn built_in_theme_pairs_remain_readable_and_avoid_black_dark_canvases() {
        for preset in theme_presets() {
            assert!(
                color_contrast_ratio(&preset.light.canvas, &preset.light.foreground) >= 7.0,
                "{} light contrast",
                preset.label
            );
            assert!(
                color_contrast_ratio(&preset.dark.canvas, &preset.dark.foreground) >= 7.0,
                "{} dark contrast",
                preset.label
            );
            assert_ne!(preset.dark.canvas, "#000000");
            assert_ne!(preset.dark.raised, "#000000");
            for surface in ["canvas", "sidebar", "raised"] {
                let light_surface = match surface {
                    "canvas" => &preset.light.canvas,
                    "sidebar" => &preset.light.sidebar,
                    _ => &preset.light.raised,
                };
                let dark_surface = match surface {
                    "canvas" => &preset.dark.canvas,
                    "sidebar" => &preset.dark.sidebar,
                    _ => &preset.dark.raised,
                };
                assert!(
                    color_contrast_ratio(&preset.light.accent, light_surface) >= 4.5,
                    "{} light accent contrast on {surface}",
                    preset.label
                );
                assert!(
                    color_contrast_ratio(&preset.dark.accent, dark_surface) >= 4.5,
                    "{} dark accent contrast on {surface}",
                    preset.label
                );
            }
            assert_eq!(
                theme_variant_safety_issues(
                    &get_preset_variant(preset.id, Scheme::Light),
                    Scheme::Light
                ),
                Vec::<String>::new()
            );
            assert_eq!(
                theme_variant_safety_issues(
                    &get_preset_variant(preset.id, Scheme::Dark),
                    Scheme::Dark
                ),
                Vec::<String>::new()
            );
        }
        assert_eq!(theme_presets()[0].dark.canvas, "#181B21");
    }

    #[test]
    fn built_in_themes_keep_light_neutrals_softer_and_dark_neutrals_calmer() {
        let foregrounds: &[(PresetId, &str, &str)] = &[
            (PresetId::Aiden, "#3D3F41", "#D1D4DA"),
            (PresetId::Slate, "#3A434E", "#D1D6DE"),
            (PresetId::Berry, "#443F4A", "#D5CFD6"),
            (PresetId::Moss, "#3F4943", "#D1D6D3"),
        ];
        let dark_accents: &[(PresetId, &str)] = &[
            (PresetId::Aiden, "#3E97F6"),
            (PresetId::Slate, "#21A9BE"),
            (PresetId::Berry, "#22B69B"),
            (PresetId::Moss, "#42B596"),
        ];
        for preset in theme_presets() {
            let expected = foregrounds
                .iter()
                .find(|(id, _, _)| *id == preset.id)
                .unwrap();
            assert_eq!(
                &preset.light.foreground, expected.1,
                "{} light foreground",
                preset.label
            );
            assert_eq!(
                &preset.dark.foreground, expected.2,
                "{} dark foreground",
                preset.label
            );
            let accent = dark_accents
                .iter()
                .find(|(id, _)| *id == preset.id)
                .unwrap()
                .1;
            assert_eq!(&preset.dark.accent, accent, "{} dark accent", preset.label);
        }

        let light = resolve_theme_tokens(
            &get_preset_variant(PresetId::Aiden, Scheme::Light),
            Scheme::Light,
            false,
        );
        let dark = resolve_theme_tokens(
            &get_preset_variant(PresetId::Aiden, Scheme::Dark),
            Scheme::Dark,
            false,
        );
        assert_eq!(light["--text-primary"], "#3D3F41");
        assert_eq!(light["--text-secondary"], "#5B606B");
        assert_eq!(light["--text-quaternary"], "#666D7B");
        assert_eq!(light["--surface-control"], "rgb(61 63 65 / 0.084)");
        assert_eq!(dark["--text-primary"], "#D1D4DA");
        assert_eq!(dark["--text-secondary"], "#A9B1BA");
        assert_eq!(dark["--text-quaternary"], "#9AA3AE");
        assert_eq!(dark["--surface-control"], "rgb(209 212 218 / 0.094)");
        assert_eq!(dark["--accent"], "#3E97F6");
    }

    #[test]
    fn every_built_in_theme_keeps_semantic_foregrounds_readable() {
        for preset in theme_presets() {
            assert_semantic_contrast(
                &get_preset_variant(preset.id, Scheme::Light),
                Scheme::Light,
                &format!("{} light", preset.label),
            );
            assert_semantic_contrast(
                &get_preset_variant(preset.id, Scheme::Dark),
                Scheme::Dark,
                &format!("{} dark", preset.label),
            );
        }
    }

    #[test]
    fn custom_themes_clash_correct_semantic_colors_without_rejecting_safe_primitives() {
        let collision = ThemeVariantConfig {
            preset: Selection::Custom,
            background: "#FF5E57".into(),
            foreground: "#000000".into(),
            accent: "#000000".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Dark)
        };
        assert_eq!(
            theme_variant_safety_issues(&collision, Scheme::Dark),
            Vec::<String>::new()
        );
        assert_semantic_contrast(&collision, Scheme::Dark, "danger-collision custom dark");

        let boundary = ThemeVariantConfig {
            preset: Selection::Custom,
            background: "#FFFFFF".into(),
            foreground: "#000000".into(),
            accent: "#6E6E6E".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Light)
        };
        assert_eq!(
            theme_variant_safety_issues(&boundary, Scheme::Light),
            Vec::<String>::new()
        );
        assert_semantic_contrast(&boundary, Scheme::Light, "boundary-accent custom light");

        let toolbar = ThemeVariantConfig {
            preset: Selection::Custom,
            background: "#7B7B7B".into(),
            foreground: "#000000".into(),
            accent: "#000000".into(),
            contrast: 0,
            ..get_preset_variant(PresetId::Aiden, Scheme::Light)
        };
        assert_eq!(
            theme_variant_safety_issues(&toolbar, Scheme::Light),
            Vec::<String>::new()
        );
        assert_semantic_contrast(&toolbar, Scheme::Light, "toolbar-collision custom light");

        let sidebar_collision = ThemeVariantConfig {
            preset: Selection::Custom,
            background: "#FFFFFF".into(),
            foreground: "#767676".into(),
            accent: "#000000".into(),
            contrast: 100,
            ..get_preset_variant(PresetId::Aiden, Scheme::Light)
        };
        assert!(
            theme_variant_safety_issues(&sidebar_collision, Scheme::Light)
                .join(" ")
                .to_ascii_lowercase()
                .contains("foreground needs at least 4.5:1 contrast against its surfaces")
        );
    }

    #[test]
    fn appearance_normalization_refreshes_named_presets_without_overwriting_custom_themes() {
        let mut stale = create_default_appearance_config();
        stale.light = ThemeVariantConfig {
            accent: "#087F8C".into(),
            ..get_preset_variant(PresetId::Slate, Scheme::Light)
        };
        stale.dark = ThemeVariantConfig {
            accent: "#0A84FF".into(),
            background: "#0E1116".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Dark)
        };
        let normalized = normalize_appearance_config(&serde_json::to_value(&stale).unwrap());
        assert_eq!(
            normalized.light,
            get_preset_variant(PresetId::Slate, Scheme::Light)
        );
        assert_eq!(
            normalized.dark,
            get_preset_variant(PresetId::Aiden, Scheme::Dark)
        );

        let custom = ThemeVariantConfig {
            preset: Selection::Custom,
            accent: "#A18FFF".into(),
            background: "#20242C".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Dark)
        };
        let normalized =
            normalize_appearance_config(&json!({ "dark": serde_json::to_value(&custom).unwrap() }));
        assert_eq!(normalized.dark, custom);
    }

    #[test]
    fn appearance_normalization_safely_clamps_user_controlled_values() {
        let normalized = normalize_appearance_config(&json!({
            "mode": "dark",
            "light": { "contrast": -12 },
            "dark": { "contrast": 112, "accent": "not-a-color" },
            "uiFontSize": 99,
            "codeFontSize": 1,
            "reduceMotion": "always",
        }));
        assert_eq!(normalized.mode, Mode::Dark);
        assert_eq!(normalized.light.contrast, 0);
        assert_eq!(normalized.dark.contrast, 100);
        assert_eq!(normalized.dark.accent, "#3E97F6");
        assert_eq!(normalized.ui_font_size, 18);
        assert_eq!(normalized.code_font_size, 10);
        assert_eq!(normalized.reduce_motion, ReduceMotion::System);
        assert_eq!(
            create_default_appearance_config().diff_markers,
            DiffMarkers::Symbols
        );
        assert_eq!(
            normalize_appearance_config(&json!({})).diff_markers,
            DiffMarkers::Symbols
        );
    }

    #[test]
    fn strict_appearance_parsing_rejects_incomplete_and_unsafe_ipc_payloads() {
        assert!(parse_appearance_config(&json!({ "mode": "dark" }))
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("incomplete"));
        let mut invalid = create_default_appearance_config();
        invalid.dark.background = "black".into();
        let err = parse_appearance_config(&serde_json::to_value(&invalid).unwrap()).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("background color"));
        let mut unsupported = create_default_appearance_config();
        unsupported.dark.preset = Selection::Aiden; // replaced below via JSON
        let value = serde_json::to_value(&unsupported).unwrap();
        let mut map = value.as_object().unwrap().clone();
        map.get_mut("dark")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("preset".into(), json!("solarized"));
        let err = parse_appearance_config(&Value::Object(map)).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("unsupported preset"));

        let wrong_toggle = serde_json::to_value(create_default_appearance_config()).unwrap();
        let mut map = wrong_toggle.as_object().unwrap().clone();
        map.insert("pointerCursors".into(), json!("yes"));
        let err = parse_appearance_config(&Value::Object(map)).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("boolean"));

        let mut unreadable = create_default_appearance_config();
        unreadable.light.preset = Selection::Custom;
        unreadable.light.foreground = unreadable.light.background.clone();
        let err = parse_appearance_config(&serde_json::to_value(&unreadable).unwrap()).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("4.5:1 contrast"));

        let mut unreadable_popover = create_default_appearance_config();
        unreadable_popover.light = ThemeVariantConfig {
            preset: Selection::Custom,
            background: "#767676".into(),
            foreground: "#FFFFFF".into(),
            accent: "#000000".into(),
            ..unreadable_popover.light.clone()
        };
        let err = parse_appearance_config(&serde_json::to_value(&unreadable_popover).unwrap())
            .unwrap_err();
        assert!(err
            .to_ascii_lowercase()
            .contains("foreground needs at least 4.5:1 contrast against its surfaces"));
    }

    #[test]
    fn per_scheme_theme_json_round_trips_without_losing_editable_fields() {
        let original = ThemeVariantConfig {
            preset: Selection::Custom,
            accent: "#A18FFF".into(),
            contrast: 73,
            translucent_sidebar: false,
            ..get_preset_variant(PresetId::Berry, Scheme::Dark)
        };
        let serialized = serialize_theme_variant(&original, Scheme::Dark).unwrap();
        let parsed = parse_theme_variant_json(&serialized, Scheme::Dark).unwrap();
        assert_eq!(parsed, original);
        let err = parse_theme_variant_json(&serialized, Scheme::Light).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("not a light theme"));
        let err = parse_theme_variant_json(
            &serde_json::to_string(&ThemeVariantFile {
                version: 2,
                scheme: Scheme::Dark,
                theme: original.clone(),
            })
            .unwrap(),
            Scheme::Dark,
        )
        .unwrap_err();
        assert!(err.to_ascii_lowercase().contains("unsupported version"));
        let err = parse_theme_variant_json(
            r##"{"accent":"#7C5CFC","background":"#20242C","foreground":"#FFFFFF"}"##,
            Scheme::Dark,
        )
        .unwrap_err();
        assert!(err.to_ascii_lowercase().contains("font selection"));

        let mismatched = ThemeVariantConfig {
            accent: "#A18FFF".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Dark)
        };
        let parsed =
            parse_theme_variant_json(&serde_json::to_string(&mismatched).unwrap(), Scheme::Dark)
                .unwrap();
        assert_eq!(parsed.preset, Selection::Custom);
    }

    #[test]
    fn resolved_dark_tokens_use_the_selected_graphite_canvas_and_accent() {
        let variant = ThemeVariantConfig {
            background: "#20242C".into(),
            accent: "#7C5CFC".into(),
            preset: Selection::Custom,
            ..get_preset_variant(PresetId::Aiden, Scheme::Dark)
        };
        let tokens = resolve_theme_tokens(&variant, Scheme::Dark, false);
        assert_eq!(tokens["--accent"], "#7C5CFC");
        assert!(color_contrast_ratio(&tokens["--accent"], &tokens["--accent-foreground"]) >= 4.5);
        assert!(tokens["--surface-background"].starts_with("rgb(32 36 44"));
        assert_eq!(tokens["--surface-context-bar"], "rgb(41 45 53 / 0.800)");
        assert_ne!(tokens["--surface-popover"], "#000000");
    }

    #[test]
    fn composer_context_surfaces_keep_the_darker_theme_tint_at_eighty_percent_opacity() {
        let light = resolve_theme_tokens(
            &get_preset_variant(PresetId::Slate, Scheme::Light),
            Scheme::Light,
            false,
        );
        let dark = resolve_theme_tokens(
            &get_preset_variant(PresetId::Aiden, Scheme::Dark),
            Scheme::Dark,
            false,
        );
        assert_eq!(light["--surface-context-bar"], "rgb(230 235 242 / 0.800)");
        assert_eq!(dark["--surface-context-bar"], "rgb(32 36 44 / 0.800)");
    }

    #[test]
    fn unsafe_custom_theme_drafts_report_recovery_guidance() {
        let variant = ThemeVariantConfig {
            preset: Selection::Custom,
            foreground: "#FFFFFF".into(),
            background: "#FFFFFF".into(),
            accent: "#FDFDFD".into(),
            ..get_preset_variant(PresetId::Aiden, Scheme::Light)
        };
        let issues = theme_variant_safety_issues(&variant, Scheme::Light);
        assert_eq!(issues.len(), 2);
        let joined = issues.join(" ").to_ascii_lowercase();
        assert!(joined.contains("foreground needs at least 4.5:1 contrast against its surfaces"));
        assert!(joined.contains("accent"));
    }

    #[test]
    fn color_helpers_match_the_reference_implementation() {
        assert!(is_hex_color("#006AD6"));
        assert!(!is_hex_color("black"));
        assert!(!is_hex_color("#006AD"));
        assert!((color_contrast_ratio("#FFFFFF", "#000000") - 21.0).abs() < 1e-9);
        assert_eq!(color_contrast_ratio("not-a-color", "#FFFFFF"), 0.0);
    }
}
