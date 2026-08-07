//! Port of `main/services/assistant/project-tool.ts` — the attended dock's
//! read-only `list_projects` identity tool.
//!
//! Lists only project identities that can back a scheduled automation. Folder
//! paths and repository state stay private; only a trusted name/id pair crosses
//! the boundary.

use aiden_core::{ToolCall, ToolDef};

use crate::automation::WorkspacePermission;
use crate::runner::{ToolExecutionError, ToolOutput};

pub const LIST_PROJECTS_TOOL_NAME: &str = "list_projects";

/// A workspace record as seen by the project tool. `folder_path` is private:
/// it is only used to decide eligibility, never serialized into results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub folder_path: Option<String>,
    pub permission: WorkspacePermission,
}

/// Dependency for the tool: lists the user's workspaces.
#[async_trait::async_trait]
pub trait WorkspaceLister: Send + Sync {
    async fn list_workspaces(&self) -> Vec<WorkspaceRecord>;
}

/// The `list_projects` tool wrapper.
pub struct AssistantProjectTool {
    pub lister: std::sync::Arc<dyn WorkspaceLister>,
}

impl AssistantProjectTool {
    pub fn new(lister: std::sync::Arc<dyn WorkspaceLister>) -> Self {
        Self { lister }
    }

    pub fn tool_def(&self) -> ToolDef {
        ToolDef {
            name: LIST_PROJECTS_TOOL_NAME.to_string(),
            description: "List folder-backed projects that are eligible for an Aiden automation. Use the exact returned project ID with schedule_task or edit_automation. This does not read project files or status.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        }
    }

    /// Run the tool. Non-empty arguments are rejected (`list_projects` does not
    /// accept arguments); results are only workspace identities.
    pub async fn run(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        if let Some(object) = call.arguments.as_object() {
            if !object.is_empty() {
                return Err(ToolExecutionError::Message(
                    "list_projects does not accept arguments.".to_string(),
                ));
            }
        }
        let projects: Vec<serde_json::Value> = self
            .lister
            .list_workspaces()
            .await
            .iter()
            .filter(|workspace| {
                workspace.folder_path.is_some() && workspace.permission != WorkspacePermission::None
            })
            .map(|workspace| serde_json::json!({ "id": workspace.id, "name": workspace.name }))
            .collect();
        Ok(ToolOutput::text(
            serde_json::to_string(&serde_json::json!({ "projects": projects }))
                .unwrap_or_else(|_| "{}".to_string()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    struct StaticLister(Vec<WorkspaceRecord>);

    #[async_trait::async_trait]
    impl WorkspaceLister for StaticLister {
        async fn list_workspaces(&self) -> Vec<WorkspaceRecord> {
            self.0.clone()
        }
    }

    fn record(id: &str, name: &str, folder: Option<&str>, permission: &str) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.to_string(),
            name: name.to_string(),
            folder_path: folder.map(str::to_string),
            permission: WorkspacePermission::from_value(permission).unwrap(),
        }
    }

    fn call() -> ToolCall {
        ToolCall {
            id: "list".to_string(),
            name: LIST_PROJECTS_TOOL_NAME.to_string(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        }
    }

    fn json_result(output: &ToolOutput) -> Value {
        serde_json::from_str(&output.text).unwrap()
    }

    #[tokio::test]
    async fn list_projects_returns_only_eligible_identities_without_folder_paths() {
        let tool = AssistantProjectTool::new(std::sync::Arc::new(StaticLister(vec![
            record("project-1", "Website", Some("/private/website"), "ask"),
            record("no-access", "Private", Some("/private/secret"), "none"),
            record("empty", "No folder", None, "full"),
        ])));
        let listed = json_result(&tool.run(&call()).await.unwrap());
        assert_eq!(
            listed["projects"],
            serde_json::json!([{ "id": "project-1", "name": "Website" }])
        );
        assert!(!listed.to_string().contains("private/website"));

        let rejected = tool
            .run(&ToolCall {
                id: "invalid".to_string(),
                name: LIST_PROJECTS_TOOL_NAME.to_string(),
                arguments: serde_json::json!({ "extra": true }),
                thought_signature: None,
            })
            .await;
        assert!(rejected.is_err());
        assert!(rejected
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("does not accept arguments"));
    }
}
