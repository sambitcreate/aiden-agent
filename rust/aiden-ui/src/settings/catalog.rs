//! Immutable settings destinations and pure search helpers.
//!
//! This mirrors `renderer/lib/settings-section.ts` plus the canonical Lucide
//! icon mapping in `renderer/main/settings-view.tsx`. Filtering only returns
//! matching destinations; selection remains owned by the settings view.

/// Stable route identifier for an Electron-compatible settings destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsDestinationId {
    Providers,
    ModelData,
    Skills,
    Mcp,
    WebSearch,
    ScheduledTasks,
    Assistant,
    ComputerUse,
    Voice,
    Shortcut,
    Appearance,
    About,
}

impl SettingsDestinationId {
    /// Every destination id in canonical settings navigation order.
    pub const ALL: &'static [Self] = &[
        Self::Providers,
        Self::ModelData,
        Self::Skills,
        Self::Mcp,
        Self::WebSearch,
        Self::ScheduledTasks,
        Self::Assistant,
        Self::ComputerUse,
        Self::Voice,
        Self::Shortcut,
        Self::Appearance,
        Self::About,
    ];

    /// Return the exact Electron route id.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Providers => "providers",
            Self::ModelData => "modelData",
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::WebSearch => "websearch",
            Self::ScheduledTasks => "scheduledTasks",
            Self::Assistant => "assistant",
            Self::ComputerUse => "computerUse",
            Self::Voice => "voice",
            Self::Shortcut => "shortcut",
            Self::Appearance => "appearance",
            Self::About => "about",
        }
    }

    /// Parse an exact Electron route id without accepting legacy aliases.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "providers" => Some(Self::Providers),
            "modelData" => Some(Self::ModelData),
            "skills" => Some(Self::Skills),
            "mcp" => Some(Self::Mcp),
            "websearch" => Some(Self::WebSearch),
            "scheduledTasks" => Some(Self::ScheduledTasks),
            "assistant" => Some(Self::Assistant),
            "computerUse" => Some(Self::ComputerUse),
            "voice" => Some(Self::Voice),
            "shortcut" => Some(Self::Shortcut),
            "appearance" => Some(Self::Appearance),
            "about" => Some(Self::About),
            _ => None,
        }
    }
}

/// Heading used to group destinations in the settings sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsDestinationGroup {
    Agent,
    App,
}

impl SettingsDestinationGroup {
    /// Groups in canonical display order.
    pub const ALL: &'static [Self] = &[Self::Agent, Self::App];

    /// Visible group heading.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::App => "App",
        }
    }
}

/// Catalog-specific representation of the Electron Lucide navigation icons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsDestinationIcon {
    Server,
    ChartScatter,
    Wand2,
    Plug,
    Globe,
    Clock3,
    Sparkles,
    MousePointer2,
    Mic,
    Keyboard,
    Palette,
    Info,
}

/// One immutable destination in the settings navigation catalog.
#[derive(Debug, PartialEq, Eq)]
pub struct SettingsDestination {
    pub id: SettingsDestinationId,
    pub label: &'static str,
    pub group: SettingsDestinationGroup,
    pub icon: SettingsDestinationIcon,
    pub keywords: &'static [&'static str],
}

/// Canonical settings destinations in exact Electron display order.
pub static SETTINGS_DESTINATIONS: [SettingsDestination; 12] = [
    SettingsDestination {
        id: SettingsDestinationId::Providers,
        label: "Providers",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Server,
        keywords: &["models", "api", "keys"],
    },
    SettingsDestination {
        id: SettingsDestinationId::ModelData,
        label: "Model Pad",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::ChartScatter,
        keywords: &[
            "personal",
            "models",
            "arrange",
            "rank",
            "capability",
            "speed",
            "pace",
            "artificial analysis",
        ],
    },
    SettingsDestination {
        id: SettingsDestinationId::Skills,
        label: "Skills",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Wand2,
        keywords: &["instructions", "tools"],
    },
    SettingsDestination {
        id: SettingsDestinationId::Mcp,
        label: "MCP Servers",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Plug,
        keywords: &["connections", "protocol"],
    },
    SettingsDestination {
        id: SettingsDestinationId::WebSearch,
        label: "Web Search",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Globe,
        keywords: &["internet", "exa"],
    },
    SettingsDestination {
        id: SettingsDestinationId::ScheduledTasks,
        label: "Scheduled tasks",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Clock3,
        keywords: &[
            "automation",
            "cron",
            "recurring",
            "background",
            "scripts",
            "notifications",
        ],
    },
    SettingsDestination {
        id: SettingsDestinationId::Assistant,
        label: "Aiden",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::Sparkles,
        keywords: &[
            "assistant",
            "companion",
            "chat",
            "hotkey",
            "shortcut",
            "model",
            "access",
            "proactive",
        ],
    },
    SettingsDestination {
        id: SettingsDestinationId::ComputerUse,
        label: "Computer Use",
        group: SettingsDestinationGroup::Agent,
        icon: SettingsDestinationIcon::MousePointer2,
        keywords: &[
            "desktop",
            "native apps",
            "accessibility",
            "screen recording",
            "beta",
        ],
    },
    SettingsDestination {
        id: SettingsDestinationId::Voice,
        label: "Voice",
        group: SettingsDestinationGroup::App,
        icon: SettingsDestinationIcon::Mic,
        keywords: &["microphone", "audio", "transcription", "dictation"],
    },
    SettingsDestination {
        id: SettingsDestinationId::Shortcut,
        label: "Keyboard shortcuts",
        group: SettingsDestinationGroup::App,
        icon: SettingsDestinationIcon::Keyboard,
        keywords: &["hotkey", "command"],
    },
    SettingsDestination {
        id: SettingsDestinationId::Appearance,
        label: "Appearance",
        group: SettingsDestinationGroup::App,
        icon: SettingsDestinationIcon::Palette,
        keywords: &["theme", "light", "dark"],
    },
    SettingsDestination {
        id: SettingsDestinationId::About,
        label: "About",
        group: SettingsDestinationGroup::App,
        icon: SettingsDestinationIcon::Info,
        keywords: &[
            "version",
            "build",
            "github",
            "repository",
            "app information",
        ],
    },
];

/// Return destinations in one group while preserving catalog order.
pub fn destinations_in_group(
    group: SettingsDestinationGroup,
) -> impl Iterator<Item = &'static SettingsDestination> {
    SETTINGS_DESTINATIONS
        .iter()
        .filter(move |destination| destination.group == group)
}

/// Filter destinations by a trimmed, case-folded substring of label and keywords.
///
/// An empty query returns the entire catalog. This function never selects a
/// destination or mutates settings navigation state.
pub fn filter_destinations(query: &str) -> Vec<&'static SettingsDestination> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return SETTINGS_DESTINATIONS.iter().collect();
    }
    SETTINGS_DESTINATIONS
        .iter()
        .filter(|destination| {
            let searchable =
                format!("{} {}", destination.label, destination.keywords.join(" ")).to_lowercase();
            searchable.contains(&query)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_the_exact_electron_contract() {
        let actual = SETTINGS_DESTINATIONS
            .iter()
            .map(|destination| {
                (
                    destination.id.as_str(),
                    destination.label,
                    destination.group.label(),
                    destination.icon,
                    destination.keywords,
                )
            })
            .collect::<Vec<_>>();
        let expected = vec![
            (
                "providers",
                "Providers",
                "Agent",
                SettingsDestinationIcon::Server,
                &["models", "api", "keys"][..],
            ),
            (
                "modelData",
                "Model Pad",
                "Agent",
                SettingsDestinationIcon::ChartScatter,
                &[
                    "personal",
                    "models",
                    "arrange",
                    "rank",
                    "capability",
                    "speed",
                    "pace",
                    "artificial analysis",
                ][..],
            ),
            (
                "skills",
                "Skills",
                "Agent",
                SettingsDestinationIcon::Wand2,
                &["instructions", "tools"][..],
            ),
            (
                "mcp",
                "MCP Servers",
                "Agent",
                SettingsDestinationIcon::Plug,
                &["connections", "protocol"][..],
            ),
            (
                "websearch",
                "Web Search",
                "Agent",
                SettingsDestinationIcon::Globe,
                &["internet", "exa"][..],
            ),
            (
                "scheduledTasks",
                "Scheduled tasks",
                "Agent",
                SettingsDestinationIcon::Clock3,
                &[
                    "automation",
                    "cron",
                    "recurring",
                    "background",
                    "scripts",
                    "notifications",
                ][..],
            ),
            (
                "assistant",
                "Aiden",
                "Agent",
                SettingsDestinationIcon::Sparkles,
                &[
                    "assistant",
                    "companion",
                    "chat",
                    "hotkey",
                    "shortcut",
                    "model",
                    "access",
                    "proactive",
                ][..],
            ),
            (
                "computerUse",
                "Computer Use",
                "Agent",
                SettingsDestinationIcon::MousePointer2,
                &[
                    "desktop",
                    "native apps",
                    "accessibility",
                    "screen recording",
                    "beta",
                ][..],
            ),
            (
                "voice",
                "Voice",
                "App",
                SettingsDestinationIcon::Mic,
                &["microphone", "audio", "transcription", "dictation"][..],
            ),
            (
                "shortcut",
                "Keyboard shortcuts",
                "App",
                SettingsDestinationIcon::Keyboard,
                &["hotkey", "command"][..],
            ),
            (
                "appearance",
                "Appearance",
                "App",
                SettingsDestinationIcon::Palette,
                &["theme", "light", "dark"][..],
            ),
            (
                "about",
                "About",
                "App",
                SettingsDestinationIcon::Info,
                &[
                    "version",
                    "build",
                    "github",
                    "repository",
                    "app information",
                ][..],
            ),
        ];

        assert_eq!(actual, expected);
    }

    #[test]
    fn every_id_round_trips_and_aliases_are_rejected() {
        for id in SettingsDestinationId::ALL {
            assert_eq!(SettingsDestinationId::parse(id.as_str()), Some(*id));
        }
        assert_eq!(SettingsDestinationId::parse("shortcuts"), None);
        assert_eq!(SettingsDestinationId::parse("scheduled-tasks"), None);
    }

    #[test]
    fn keyword_queries_match_the_expected_destination() {
        for (query, expected) in [
            ("cron", SettingsDestinationId::ScheduledTasks),
            ("instructions", SettingsDestinationId::Skills),
            ("api", SettingsDestinationId::Providers),
            ("repository", SettingsDestinationId::About),
        ] {
            let matches = filter_destinations(query);
            assert_eq!(matches.len(), 1, "query {query:?}");
            assert_eq!(matches[0].id, expected, "query {query:?}");
        }
    }

    #[test]
    fn filtering_trims_and_case_folds_label_substrings() {
        let matches = filter_destinations("  KEYBOARD SHORT  ");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, SettingsDestinationId::Shortcut);
    }

    #[test]
    fn empty_query_returns_the_full_catalog_without_selecting() {
        let selected = SettingsDestinationId::About;
        let matches = filter_destinations("   ");

        assert_eq!(matches.len(), SETTINGS_DESTINATIONS.len());
        assert_eq!(selected, SettingsDestinationId::About);
    }

    #[test]
    fn no_match_returns_an_empty_result() {
        assert!(filter_destinations("definitely-not-a-setting").is_empty());
    }

    #[test]
    fn group_helpers_preserve_group_and_catalog_order() {
        assert_eq!(
            SettingsDestinationGroup::ALL
                .iter()
                .map(|group| group.label())
                .collect::<Vec<_>>(),
            ["Agent", "App"]
        );
        assert_eq!(
            destinations_in_group(SettingsDestinationGroup::Agent)
                .map(|destination| destination.id)
                .collect::<Vec<_>>(),
            SettingsDestinationId::ALL[..8]
        );
        assert_eq!(
            destinations_in_group(SettingsDestinationGroup::App)
                .map(|destination| destination.id)
                .collect::<Vec<_>>(),
            SettingsDestinationId::ALL[8..]
        );
    }
}
