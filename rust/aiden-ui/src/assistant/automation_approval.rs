//! The assistant automation proposal card (port of
//! `renderer/components/assistant/assistant-automation-approval.tsx`).
//!
//! A compact attended confirmation for the assistant's only mutating
//! capability: creating or editing a scheduled automation. Approve/Deny
//! actions with the digest-expanded details; malformed details render the
//! fail-closed invalid state and can never be confirmed. All label logic is
//! pure and unit-tested against the `assistant-ui.test.tsx` expectations.

use std::rc::Rc;

use gpui::{
    div, prelude::FluentBuilder as _, px, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, Disableable as _, Icon, IconName, Sizable as _,
};

use crate::approvals::queue::PendingApproval;

/// The card title: proposals ask to be created, edits ask to be saved.
pub fn automation_title(details: &serde_json::Value) -> &'static str {
    match details.get("action").and_then(serde_json::Value::as_str) {
        Some("edit") => "Save these changes?",
        _ => "Create this automation?",
    }
}

/// `actionScope` — the affordance label scope ("automation" /
/// "Full access automation" / "automation changes" / "Full access automation
/// changes").
pub fn action_scope(details: &serde_json::Value) -> String {
    let editing = details.get("action").and_then(serde_json::Value::as_str) == Some("edit");
    let full = details
        .get("permission")
        .and_then(serde_json::Value::as_str)
        == Some("full");
    match (editing, full) {
        (true, true) => "Full access automation changes",
        (true, false) => "automation changes",
        (false, true) => "Full access automation",
        (false, false) => "automation",
    }
    .to_string()
}

/// The Decline affordance label (the card's aria-label / tooltip).
pub fn decline_label(details: &serde_json::Value) -> String {
    format!("Decline {}", action_scope(details))
}

/// The Confirm affordance label.
pub fn confirm_label(details: &serde_json::Value) -> String {
    format!("Confirm {}", action_scope(details))
}

/// `accessLabel` — the "Full access · Website · MCP: …" badge text.
pub fn access_label(details: &serde_json::Value) -> String {
    let full = details
        .get("permission")
        .and_then(serde_json::Value::as_str)
        == Some("full");
    let workspace = details
        .get("workspaceName")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.trim().is_empty());
    let mcp_labels = mcp_server_labels(details);
    let mut parts = vec![if full { "Full access" } else { "Read-only" }.to_string()];
    if let Some(workspace) = workspace {
        parts.push(workspace.to_string());
    }
    if !mcp_labels.is_empty() {
        parts.push(format!("MCP: {}", mcp_labels.join(", ")));
    }
    parts.join(" · ")
}

/// `Name (id)` pairs for the proposal's MCP scope.
pub fn mcp_server_labels(details: &serde_json::Value) -> Vec<String> {
    let ids: Vec<String> = details
        .get("mcpServerIds")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let names: Vec<String> = details
        .get("mcpServerNames")
        .and_then(serde_json::Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ids.iter()
        .enumerate()
        .map(|(index, id)| {
            let name = names.get(index).map(String::as_str).unwrap_or(id);
            format!("{name} ({id})")
        })
        .collect()
}

/// The pinned provider/model configuration without implying execution.
pub fn provider_line(details: &serde_json::Value) -> String {
    let provider_name = details
        .get("providerName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let provider_id = details
        .get("providerId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let model_name = details
        .get("modelName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let model = details
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    format!("Configured with {provider_name} ({provider_id}) · {model_name} ({model}).")
}

/// Truthful execution posture for the exact approved proposal.
pub fn next_run_label(details: &serde_json::Value) -> String {
    if details
        .get("schedulerEnabled")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return "Paused by the global Scheduled tasks setting".to_string();
    }
    if details.get("enabled").and_then(serde_json::Value::as_bool) != Some(true) {
        return "Saved paused until this task is enabled".to_string();
    }
    details
        .get("nextRunAt")
        .and_then(serde_json::Value::as_u64)
        .map(|next| {
            format!(
                "Next run {}",
                crate::services::chat_service::relative_time(next, aiden_data::now_millis())
            )
        })
        .unwrap_or_else(|| "Enabled · awaiting its next schedule".to_string())
}

/// The warnings rendered under the details (full-access write scope, unattended
/// MCP reach, scheduling disabled). Mirrors the renderer's conditional copy.
pub fn automation_warnings(details: &serde_json::Value) -> Vec<String> {
    let mut warnings = Vec::new();
    let full = details
        .get("permission")
        .and_then(serde_json::Value::as_str)
        == Some("full");
    if full {
        if let Some(workspace) = details
            .get("workspaceName")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.trim().is_empty())
        {
            warnings.push(format!(
                "Uses {workspace} as prompt context; native scheduled prompts do not expose filesystem or shell tools."
            ));
        }
    }
    let mcp = mcp_server_labels(details);
    if !mcp.is_empty() {
        warnings.push(format!("Can call {} unattended.", mcp.join(", ")));
    }
    if details
        .get("schedulerEnabled")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        warnings.push(
            "The global Scheduled tasks setting is off, so this automation will remain paused."
                .to_string(),
        );
    }
    warnings
}

/// Enrich the proposal details with config-resolved display names so the card
/// can render (and the fail-closed validator can accept) a confirmable
/// proposal: `workspaceName` from the workspace list, `mcpServerNames` from
/// the server list, and `providerName` / `modelName` falling back to their ids.
pub fn enrich_automation_details(
    details: &serde_json::Value,
    workspaces: &[(String, String)],
    servers: &[aiden_data::portable_config::McpServer],
) -> serde_json::Value {
    let mut enriched = details.clone();

    if empty_text(&enriched, "workspaceName") {
        if let Some(id) = enriched
            .get("workspaceId")
            .and_then(serde_json::Value::as_str)
        {
            if let Some((_, name)) = workspaces
                .iter()
                .find(|(workspace_id, _)| workspace_id == id)
            {
                enriched["workspaceName"] = serde_json::Value::String(name.clone());
            }
        }
    }

    if enriched
        .get("mcpServerNames")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|names| {
            names.len()
                != enriched
                    .get("mcpServerIds")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, Vec::len)
        })
    {
        let names: Vec<serde_json::Value> = enriched
            .get("mcpServerIds")
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(|id| {
                        servers
                            .iter()
                            .find(|server| server.id == id)
                            .map(|server| server.name.clone())
                            .unwrap_or_else(|| id.to_string())
                    })
                    .map(serde_json::Value::String)
                    .collect()
            })
            .unwrap_or_default();
        enriched["mcpServerNames"] = serde_json::Value::Array(names);
    }

    if empty_text(&enriched, "providerName") {
        if let Some(id) = enriched
            .get("providerId")
            .and_then(serde_json::Value::as_str)
        {
            enriched["providerName"] = serde_json::Value::String(id.to_string());
        }
    }
    if empty_text(&enriched, "modelName") {
        if let Some(model) = enriched.get("model").and_then(serde_json::Value::as_str) {
            enriched["modelName"] = serde_json::Value::String(model.to_string());
        }
    }

    enriched
}

fn empty_text(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
}

/// Whether the details are a confirmable automation proposal (the renderer's
/// fail-closed boundary).
pub fn is_valid_automation(details: &serde_json::Value) -> bool {
    aiden_core::is_assistant_automation_approval_details(details)
}

/// Render the automation proposal card.
pub fn automation_approval_card(
    theme: &gpui_component::Theme,
    approval: &PendingApproval,
    deciding: bool,
    on_decision: Rc<dyn Fn(bool) + 'static>,
) -> impl IntoElement {
    let details = approval.details.clone().unwrap_or_default();
    let title = automation_title(&details);
    let decline = decline_label(&details);
    let confirm = confirm_label(&details);
    let valid = is_valid_automation(&details);
    let deciding = deciding || !valid;

    let decide = |allow: bool| {
        let on_decision = on_decision.clone();
        move |_event: &gpui::ClickEvent, _window: &mut gpui::Window, _cx: &mut gpui::App| {
            on_decision(allow);
        }
    };

    // Prebuild the details body (owned strings, no borrows captured by the
    // element tree): the fail-closed invalid card when the details are
    // malformed, the full proposal card otherwise.
    let body: gpui::AnyElement = if valid {
        let name = details
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let schedule = next_run_label(&details);
        let prompt = details
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .filter(|prompt| !prompt.trim().is_empty())
            .map(str::to_string);
        let access = access_label(&details);
        let provider = provider_line(&details);
        let warnings = automation_warnings(&details);

        v_flex()
            .w_full()
            .gap_2()
            .child(
                v_flex()
                    .w_full()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(name))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(schedule),
                    ),
            )
            .when_some(prompt, |el, prompt| {
                el.child(
                    div()
                        .id("automation-prompt")
                        .w_full()
                        .max_h(px(96.))
                        .overflow_y_scroll()
                        .border_t_1()
                        .border_color(theme.border)
                        .pt_2()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(prompt),
                )
            })
            .child(
                h_flex()
                    .w_full()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(theme.background)
                            .border_1()
                            .border_color(theme.border)
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child(access),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(provider),
                    ),
            )
            .children(warnings.into_iter().map(|warning| {
                div()
                    .w_full()
                    .text_xs()
                    .text_color(theme.danger)
                    .child(warning)
            }))
            .into_any_element()
    } else {
        v_flex()
            .w_full()
            .text_xs()
            .text_color(theme.danger)
            .child("This automation request is invalid and cannot be confirmed.")
            .into_any_element()
    };

    v_flex()
        .id("automation-approval-card")
        .w_full()
        .rounded_lg()
        .bg(theme.popover)
        .border_1()
        .border_color(theme.border)
        .px_3()
        .py_3()
        .gap_2()
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            Icon::new(IconName::Calendar)
                                .small()
                                .text_color(theme.accent),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(title),
                        ),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new("automation-deny")
                                .ghost()
                                .small()
                                .icon(IconName::Close)
                                .tooltip(decline)
                                .disabled(deciding)
                                .on_click(decide(false)),
                        )
                        .child(
                            Button::new("automation-allow")
                                .primary()
                                .small()
                                .icon(IconName::Check)
                                .tooltip(confirm)
                                .disabled(deciding)
                                .on_click(decide(true)),
                        ),
                ),
        )
        .child(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create(read_only: bool, workspace: Option<&str>, mcp: Vec<&str>) -> serde_json::Value {
        let mut value = json!({
            "kind": "assistant-automation",
            "action": "create",
            "name": "Morning brief",
            "prompt": "Summarize <private> updates.",
            "cron": "0 9 * * *",
            "timezone": "UTC",
            "nextRunAt": null,
            "notify": true,
            "mode": "llm",
            "permission": if read_only { "read-only" } else { "full" },
            "workspaceId": workspace,
            "workspaceName": workspace,
            "mcpServerIds": mcp,
            "mcpServerNames": mcp,
            "providerId": "local-provider",
            "providerName": "Local Provider",
            "model": "local-model",
            "modelName": "Local Model",
            "schedulerEnabled": false,
            "enabled": false,
        });
        if let Some(workspace) = workspace {
            value["workspaceName"] = json!(workspace);
        }
        value
    }

    #[test]
    fn titles_scope_and_labels_match_the_renderer() {
        let proposal = create(true, None, vec![]);
        assert_eq!(automation_title(&proposal), "Create this automation?");
        assert_eq!(action_scope(&proposal), "automation");
        assert_eq!(decline_label(&proposal), "Decline automation");
        assert_eq!(confirm_label(&proposal), "Confirm automation");
        assert_eq!(access_label(&proposal), "Read-only");

        let full = create(false, Some("Website"), vec![]);
        assert_eq!(action_scope(&full), "Full access automation");
        assert_eq!(decline_label(&full), "Decline Full access automation");
        assert_eq!(confirm_label(&full), "Confirm Full access automation");
        assert_eq!(access_label(&full), "Full access · Website");

        let mut edit = full.clone();
        edit["action"] = json!("edit");
        edit["taskId"] = json!("task-1");
        edit["enabled"] = json!(false);
        assert_eq!(automation_title(&edit), "Save these changes?");
        assert_eq!(action_scope(&edit), "Full access automation changes");
        assert_eq!(
            decline_label(&edit),
            "Decline Full access automation changes"
        );
        assert_eq!(
            confirm_label(&edit),
            "Confirm Full access automation changes"
        );
    }

    #[test]
    fn mcp_scope_is_rendered_as_exact_name_id_pairs() {
        let proposal = create(false, None, vec!["personal-gmail", "work-gmail"]);
        let mut with_names = proposal.clone();
        with_names["mcpServerNames"] = json!(["Gmail", "Gmail"]);
        assert_eq!(
            access_label(&with_names),
            "Full access · MCP: Gmail (personal-gmail), Gmail (work-gmail)"
        );
        let warnings = automation_warnings(&with_names);
        assert!(warnings
            .iter()
            .any(|warning| warning
                == "Can call Gmail (personal-gmail), Gmail (work-gmail) unattended."));
    }

    #[test]
    fn provider_line_and_full_access_warning_match_the_renderer() {
        let proposal = create(false, Some("Website"), vec![]);
        assert_eq!(
            provider_line(&proposal),
            "Configured with Local Provider (local-provider) · Local Model (local-model)."
        );
        let warnings = automation_warnings(&proposal);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("do not expose filesystem or shell tools")));
        // The explicit global gate remains visible in the approval.
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("remain paused")));
    }

    #[test]
    fn execution_label_tracks_global_task_and_next_run_state() {
        let proposal = create(true, None, vec![]);
        assert_eq!(
            next_run_label(&proposal),
            "Paused by the global Scheduled tasks setting"
        );
        let mut paused = proposal.clone();
        paused["action"] = json!("edit");
        paused["taskId"] = json!("task-1");
        paused["enabled"] = json!(false);
        paused["schedulerEnabled"] = json!(true);
        assert_eq!(
            next_run_label(&paused),
            "Saved paused until this task is enabled"
        );
        paused["enabled"] = json!(true);
        paused["nextRunAt"] = json!(aiden_data::now_millis() + 60_000);
        assert!(next_run_label(&paused).starts_with("Next run "));
    }

    #[test]
    fn enrichment_resolves_display_names_from_config() {
        // Workspace-only proposal (the contract forbids workspace + MCP
        // together): workspaceName resolves from the config.
        let mut proposal = create(false, Some("w-1"), vec![]);
        proposal["workspaceName"] = serde_json::Value::Null;
        proposal["providerName"] = serde_json::Value::Null;
        let workspaces = vec![("w-1".to_string(), "Website".to_string())];
        let servers = vec![aiden_data::portable_config::McpServer {
            id: "gmail".to_string(),
            name: "Gmail".to_string(),
            transport: aiden_data::portable_config::McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://gmail.test/mcp".to_string()),
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        }];
        let enriched = enrich_automation_details(&proposal, &workspaces, &servers);
        assert_eq!(enriched["workspaceName"], "Website");
        assert_eq!(enriched["providerName"], "local-provider");
        // Enriched details are confirmable (fail-closed validator passes).
        assert!(is_valid_automation(&enriched));

        // MCP-only proposal (full permission, no workspace): server names
        // resolve from the config and the enriched details confirm.
        let mut mcp = create(false, None, vec!["gmail"]);
        mcp["mcpServerNames"] = json!([]);
        let enriched_mcp = enrich_automation_details(&mcp, &[], &servers);
        assert_eq!(enriched_mcp["mcpServerNames"][0], "Gmail");
        assert!(is_valid_automation(&enriched_mcp));
    }

    #[test]
    fn invalid_details_fail_closed() {
        assert!(!is_valid_automation(
            &json!({ "kind": "assistant-automation" })
        ));
        assert!(!is_valid_automation(&json!({})));
    }
}
