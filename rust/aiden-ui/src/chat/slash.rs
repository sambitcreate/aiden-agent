//! Pure contracts for the composer slash palette.
//!
//! This module deliberately has no GPUI state or provider side effects. It
//! owns only the structural parser, deterministic ranking, and the one-skill
//! selection value that the composer can later attach to a single draft. The
//! command labels and descriptions remain owned by the Command-K catalog;
//! slash aliases below only map a user-facing token to those canonical ids.

#![allow(dead_code)] // Phase 0 contracts are intentionally unwired until the composer palette lane.

use std::ops::Range;

use aiden_data::portable_config::WorkspacePermission;

use crate::panels::command_palette::{fuzzy_score, PaletteCommandDefinition, PALETTE_COMMANDS};
use crate::services::skill_tools::{SkillCatalogEntry, SkillCatalogSource};

/// The parsed first token after a leading slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashQuery {
    /// The UTF-8 byte offset of the slash in the draft.
    pub slash_start: usize,
    /// The UTF-8 byte range containing `/` plus the first token.
    pub token_range: Range<usize>,
    /// The token without its leading slash, preserving the user's casing.
    pub query: String,
    /// Text after the first token, preserving its contents except for leading
    /// whitespace. Selection uses this to leave arguments in the draft.
    pub args: String,
    /// The UTF-8 byte cursor supplied by the native InputState.
    pub cursor: usize,
}

impl SlashQuery {
    /// Return the range that should be removed when a command or skill row is
    /// selected. Arguments after the first token remain untouched.
    pub fn token_range(&self) -> Range<usize> {
        self.token_range.clone()
    }

    /// Remove only the slash token from a draft, retaining any arguments and
    /// surrounding text. This is intentionally pure so selection cannot
    /// accidentally rewrite an ordinary unknown slash message.
    pub fn remove_token(&self, text: &str) -> Option<String> {
        if self.token_range.end > text.len()
            || !text.is_char_boundary(self.token_range.start)
            || !text.is_char_boundary(self.token_range.end)
        {
            return None;
        }
        let mut result = String::with_capacity(text.len().saturating_sub(self.token_range.len()));
        result.push_str(&text[..self.token_range.start]);
        result.push_str(&text[self.token_range.end..]);
        Some(result)
    }

    /// A query is structurally active only while the cursor is in the first
    /// token. Once the user types an argument and moves past its whitespace,
    /// ordinary composer behavior resumes.
    pub fn cursor_in_token(&self) -> bool {
        self.cursor > self.token_range.start && self.cursor <= self.token_range.end
    }
}

/// Parse a slash at the start of a draft while the cursor remains in its first
/// token. Leading spaces and tabs are accepted; a slash after a newline is
/// ordinary prose and does not open a palette.
pub fn parse_slash_query(text: &str, cursor: usize) -> Option<SlashQuery> {
    if cursor > text.len() || !text.is_char_boundary(cursor) {
        return None;
    }

    let (slash_start, first) = text
        .char_indices()
        .find(|(_, character)| !character.is_whitespace())?;
    if first != '/' || text[..slash_start].contains(['\n', '\r']) {
        return None;
    }

    let token_start = slash_start + first.len_utf8();
    let token_end = text[token_start..]
        .char_indices()
        .find(|(_, character)| character.is_whitespace())
        .map(|(offset, _)| token_start + offset)
        .unwrap_or(text.len());
    let token_range = slash_start..token_end;
    if cursor < token_start || cursor > token_end {
        return None;
    }

    let args = text[token_end..]
        .trim_start_matches(char::is_whitespace)
        .to_string();
    Some(SlashQuery {
        slash_start,
        token_range,
        query: text[token_start..token_end].to_string(),
        args,
        cursor,
    })
}

/// Whether a parsed query should paint a palette. Empty queries open the
/// catalog; unknown commands and path-like slash text remain ordinary chat.
pub fn should_open_palette(query: &SlashQuery, command_rows: usize, skill_rows: usize) -> bool {
    query.cursor_in_token()
        && (query.query.trim().is_empty() || command_rows.saturating_add(skill_rows) > 0)
}

/// The only slash-specific metadata. Titles, descriptions, categories, and
/// keywords are always read from [`PALETTE_COMMANDS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommandAlias {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub palette_id: &'static str,
}

/// Curated aliases backed by existing command-palette definitions. Commands
/// without a safe existing action are intentionally absent until their action
/// contract exists.
pub const SLASH_COMMAND_ALIASES: &[SlashCommandAlias] = &[
    SlashCommandAlias {
        name: "assistant",
        aliases: &[],
        palette_id: "assistant.open",
    },
    SlashCommandAlias {
        name: "new",
        aliases: &[],
        palette_id: "chat.new",
    },
    SlashCommandAlias {
        name: "resume",
        aliases: &["chats"],
        palette_id: "chat.search",
    },
    SlashCommandAlias {
        name: "model",
        aliases: &["models"],
        palette_id: "model.change",
    },
    SlashCommandAlias {
        name: "login",
        aliases: &["providers"],
        palette_id: "provider.manage",
    },
    SlashCommandAlias {
        name: "settings",
        aliases: &[],
        palette_id: "settings.open",
    },
    SlashCommandAlias {
        name: "editor",
        aliases: &[],
        palette_id: "workspace.openPreferredEditor",
    },
    SlashCommandAlias {
        name: "sidebar",
        aliases: &[],
        palette_id: "sidebar.toggle",
    },
    SlashCommandAlias {
        name: "terminal",
        aliases: &[],
        palette_id: "terminal.toggle",
    },
    SlashCommandAlias {
        name: "environment",
        aliases: &[],
        palette_id: "environment.toggle",
    },
    SlashCommandAlias {
        name: "theme",
        aliases: &["appearance"],
        palette_id: "theme.toggle",
    },
    SlashCommandAlias {
        name: "scheduled",
        aliases: &[],
        palette_id: "view.scheduled",
    },
    SlashCommandAlias {
        name: "usage",
        aliases: &[],
        palette_id: "view.usage",
    },
    SlashCommandAlias {
        name: "subagents",
        aliases: &[],
        palette_id: "view.subagents",
    },
];

/// A ranked command row. The canonical palette definition is borrowed rather
/// than copied, keeping labels/descriptions in one catalog.
#[derive(Debug, Clone, Copy)]
pub struct RankedSlashCommand {
    pub alias: &'static SlashCommandAlias,
    pub definition: &'static PaletteCommandDefinition,
    pub score: u32,
}

fn command_search_text(alias: &SlashCommandAlias, definition: &PaletteCommandDefinition) -> String {
    let mut text = format!(
        "{} {} {}",
        alias.name, definition.title, definition.description
    );
    for alias_name in alias.aliases {
        text.push(' ');
        text.push_str(alias_name);
    }
    for keyword in definition.keywords {
        text.push(' ');
        text.push_str(keyword);
    }
    text
}

/// Rank slash commands against the canonical command metadata.
pub fn rank_commands(query: &str) -> Vec<RankedSlashCommand> {
    let query = query.trim();
    let mut rows = SLASH_COMMAND_ALIASES
        .iter()
        .filter_map(|alias| {
            let definition = PALETTE_COMMANDS
                .iter()
                .find(|definition| definition.id == alias.palette_id)?;
            let score = fuzzy_score(query, &command_search_text(alias, definition))?;
            Some(RankedSlashCommand {
                alias,
                definition,
                score,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.alias.name.cmp(right.alias.name))
    });
    rows
}

/// A ranked safe skill catalog row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedSkill {
    pub entry: SkillCatalogEntry,
    pub score: u32,
}

/// Rank catalog entries by the same deterministic scorer used by Command-K.
pub fn rank_skills(query: &str, entries: &[SkillCatalogEntry]) -> Vec<RankedSkill> {
    let query = query.trim();
    let mut rows = entries
        .iter()
        .filter_map(|entry| {
            let search_text = format!("{} {}", entry.name, entry.description);
            Some(RankedSkill {
                entry: entry.clone(),
                score: fuzzy_score(query, &search_text)?,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.entry.name.cmp(&right.entry.name))
            .then_with(|| left.entry.id.cmp(&right.entry.id))
    });
    rows
}

/// The renderer-safe descriptor attached to one outgoing message. It carries
/// no instructions, filesystem path, secret, or permission information.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInvocationSelection {
    pub id: String,
    pub name: String,
    pub source: SkillCatalogSource,
    pub revision: String,
    /// The live workspace identity/permission captured when the chip was
    /// chosen. These are fences only; no filesystem path or instructions is
    /// carried by the renderer-facing value.
    pub workspace_identity: Option<String>,
    pub workspace_permission: Option<WorkspacePermission>,
}

impl From<&SkillCatalogEntry> for SkillInvocationSelection {
    fn from(entry: &SkillCatalogEntry) -> Self {
        Self {
            id: entry.id.clone(),
            name: entry.name.clone(),
            source: entry.source,
            revision: entry.revision.clone(),
            workspace_identity: None,
            workspace_permission: None,
        }
    }
}

/// At most one explicit skill may be selected for the next message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillSelection {
    selected: Option<SkillInvocationSelection>,
}

impl SkillSelection {
    pub fn selected(&self) -> Option<&SkillInvocationSelection> {
        self.selected.as_ref()
    }

    pub fn replace(&mut self, entry: &SkillCatalogEntry) {
        self.replace_for_workspace(entry, None, None);
    }

    pub fn replace_for_workspace(
        &mut self,
        entry: &SkillCatalogEntry,
        workspace_identity: Option<&str>,
        workspace_permission: Option<WorkspacePermission>,
    ) {
        let mut selection: SkillInvocationSelection = entry.into();
        selection.workspace_identity = workspace_identity.map(str::to_string);
        selection.workspace_permission = workspace_permission;
        self.selected = Some(selection);
    }

    pub fn clear(&mut self) {
        self.selected = None;
    }

    pub fn is_selected(&self, id: &str) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|selected| selected.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_entry(id: &str, name: &str, description: &str) -> SkillCatalogEntry {
        SkillCatalogEntry {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            source: SkillCatalogSource::Workspace,
            revision: "rev-1".into(),
        }
    }

    #[test]
    fn slash_parser_requires_leading_slash_and_first_token_cursor() {
        let query = parse_slash_query("  /model fast", 7).expect("first token");
        assert_eq!(query.query, "model");
        assert_eq!(query.args, "fast");
        assert!(query.cursor_in_token());
        assert!(parse_slash_query("hello /model", 12).is_none());
        assert!(parse_slash_query("\n/model", 6).is_none());
        assert!(parse_slash_query("/model fast", 11).is_none());
    }

    #[test]
    fn unknown_path_has_no_rows_and_remains_ordinary_text() {
        let text = "/Users/example/project";
        let query = parse_slash_query(text, text.len()).expect("structural slash query");
        assert!(rank_commands(&query.query).is_empty());
        assert!(!should_open_palette(&query, 0, 0));
        assert_eq!(query.remove_token(text).unwrap(), "");
    }

    #[test]
    fn selection_removes_only_slash_token_and_preserves_arguments() {
        let text = "  /model fast response";
        let query = parse_slash_query(text, 6).expect("query");
        assert_eq!(query.remove_token(text).unwrap(), "   fast response");
    }

    #[test]
    fn command_rows_borrow_canonical_labels_and_rank_exact_alias_first() {
        let rows = rank_commands("models");
        assert_eq!(rows.first().map(|row| row.alias.name), Some("model"));
        assert_eq!(rows.first().unwrap().definition.id, "model.change");
        assert_eq!(
            rows.first().unwrap().definition.title,
            PALETTE_COMMANDS
                .iter()
                .find(|definition| definition.id == "model.change")
                .unwrap()
                .title
        );
    }

    #[test]
    fn every_slash_command_alias_routes_to_a_canonical_palette_id() {
        for alias in SLASH_COMMAND_ALIASES {
            let definition = PALETTE_COMMANDS
                .iter()
                .find(|definition| definition.id == alias.palette_id)
                .unwrap_or_else(|| panic!("missing palette id {}", alias.palette_id));
            assert_eq!(definition.id, alias.palette_id);
        }
    }

    #[test]
    fn skill_rows_are_deterministic_and_selection_is_singleton() {
        let entries = vec![
            catalog_entry("one", "Review", "Review changes"),
            catalog_entry("two", "Deploy", "Deploy preview"),
        ];
        let rows = rank_skills("rev", &entries);
        assert_eq!(rows.first().unwrap().entry.id, "one");

        let mut selection = SkillSelection::default();
        selection.replace(&entries[0]);
        selection.replace(&entries[1]);
        assert!(!selection.is_selected("one"));
        assert_eq!(selection.selected().unwrap().id, "two");
        selection.clear();
        assert!(selection.selected().is_none());
    }
}
