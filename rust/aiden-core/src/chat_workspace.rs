//! Port of `renderer/shared/chat-workspace.ts`.

use serde::{Deserialize, Serialize};

/// The workspace id assigned to chats persisted before explicit workspace
/// ownership existed (and the id of the default workspace).
pub const DEFAULT_CHAT_WORKSPACE_ID: &str = "default";

/// Normalize chat records written before explicit workspace ownership existed.
pub fn persisted_chat_workspace_id(workspace_id: Option<&str>) -> &str {
    match workspace_id {
        Some(id) => id,
        None => DEFAULT_CHAT_WORKSPACE_ID,
    }
}

/// The full workspace contract on the wire; kept for the settings/composer
/// pickers that enumerate workspaces by id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatWorkspace {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_editor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_default_workspace_id_for_legacy_chats() {
        assert_eq!(persisted_chat_workspace_id(None), "default");
        assert_eq!(persisted_chat_workspace_id(Some("docs")), "docs");
        assert_eq!(persisted_chat_workspace_id(Some("default")), "default");
        assert_eq!(DEFAULT_CHAT_WORKSPACE_ID, "default");
    }

    #[test]
    fn workspace_roundtrips_camel_case() {
        let workspace = ChatWorkspace {
            id: "docs".into(),
            label: "Docs".into(),
            preferred_editor: Some("Cursor".into()),
        };
        let value = serde_json::to_value(&workspace).unwrap();
        assert_eq!(value["preferredEditor"], "Cursor");
        let back: ChatWorkspace = serde_json::from_value(value).unwrap();
        assert_eq!(back, workspace);
    }
}
