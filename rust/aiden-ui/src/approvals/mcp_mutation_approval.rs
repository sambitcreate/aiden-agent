//! MCP mutation approval (port of
//! `renderer/components/subagent-mcp-mutation-approval.tsx`).
//!
//! Renders the exact remote tool being called: server, tool, effect
//! classification + profile, timeout, the digest pins (connection / schema /
//! profile / arguments), the complete canonical arguments in a mono block, and
//! the no-rollback warning. Validated through
//! `aiden_core::is_subagent_mcp_mutation_approval_details`; malformed details
//! render the fail-closed invalid state.

use gpui::{
    div, prelude::FluentBuilder as _, px, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _,
};
use gpui_component::{h_flex, v_flex};

/// The `classification` label mapping (`ClassificationLabel`).
pub fn classification_label(classification: Option<&str>) -> &'static str {
    match classification {
        Some("declared_mutating") => "Server declares mutation",
        Some("unproven_mutating") => "Mutation cannot be ruled out",
        _ => "Classification unknown",
    }
}

/// The destructive-profile label (`ProfileLabel.destructive`).
pub fn destructive_label(value: Option<&str>) -> &'static str {
    match value {
        Some("destructive") => "Destructive",
        Some("additive") => "Additive hint",
        Some("unknown") => "Destructiveness unknown",
        _ => "Destructiveness unknown",
    }
}

/// The idempotency-profile label (`ProfileLabel.idempotency`).
pub fn idempotency_label(value: Option<&str>) -> &'static str {
    match value {
        Some("idempotent") => "Idempotent hint",
        Some("not_declared") => "Idempotency not declared",
        _ => "Idempotency not declared",
    }
}

/// The open-world-profile label (`ProfileLabel.openWorld`).
pub fn open_world_label(value: Option<&str>) -> &'static str {
    match value {
        Some("open") => "Open-world hint",
        Some("closed") => "Closed-world hint",
        _ => "World scope unknown",
    }
}

/// The task-support-profile label (`ProfileLabel.taskSupport`).
pub fn task_support_label(value: Option<&str>) -> &'static str {
    match value {
        Some("forbidden") => "Task mode forbidden",
        Some("optional") => "Task mode optional",
        _ => "Task mode optional",
    }
}

/// The combined profile line, `" · "`-joined.
pub fn profile_line(details: &serde_json::Value) -> String {
    let get = |key: &str| details.get(key).and_then(serde_json::Value::as_str);
    [
        destructive_label(get("destructive")),
        idempotency_label(get("idempotency")),
        open_world_label(get("openWorld")),
        task_support_label(get("taskSupport")),
    ]
    .join(" · ")
}

/// The allow-action label: an unknown prior outcome changes the wording so the
/// user is never told a fresh "Allow once" hides an unobserved effect.
#[allow(dead_code)] // parent decision-button surface (subagent approvals)
pub fn mutation_allow_label(details: &serde_json::Value) -> &'static str {
    if details
        .get("priorUnknownEffect")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        "Allow once after unknown outcome"
    } else {
        "Allow once"
    }
}

/// The capability rows for a validated MCP mutation approval (server, tool,
/// classification, profile, timeout, digests). Returns `None` when the details
/// fail the renderer contract.
pub fn mcp_mutation_rows(details: &serde_json::Value) -> Option<Vec<(&'static str, String, bool)>> {
    if !aiden_core::is_subagent_mcp_mutation_approval_details(details) {
        return None;
    }
    let get = |key: &str| {
        details
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    Some(vec![
        ("Server", get("serverId").to_string(), true),
        ("Tool", get("toolName").to_string(), true),
        (
            "Classification",
            classification_label(
                details
                    .get("classification")
                    .and_then(serde_json::Value::as_str),
            )
            .to_string(),
            false,
        ),
        ("Profile", profile_line(details), false),
        (
            "Timeout",
            format!(
                "{} ms",
                details
                    .get("timeoutMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            ),
            false,
        ),
        (
            "Digests",
            format!(
                "connection {} · schema {} · profile {} · arguments {}",
                get("connectionDigestPrefix"),
                get("schemaDigestPrefix"),
                get("profileDigestPrefix"),
                get("argumentDigestPrefix")
            ),
            true,
        ),
    ])
}

/// The complete canonical mutation arguments for the mono block.
pub fn canonical_mutation_arguments(details: &serde_json::Value) -> String {
    details
        .get("canonicalArguments")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Render the MCP mutation approval content section.
pub fn mcp_mutation_approval_section(
    theme: &gpui_component::Theme,
    details: &serde_json::Value,
) -> impl IntoElement {
    let Some(rows) = mcp_mutation_rows(details) else {
        return v_flex()
            .id("mcp-mutation-approval-invalid")
            .w_full()
            .rounded_md()
            .bg(theme.background)
            .px_3()
            .py_2()
            .border_1()
            .border_color(theme.danger)
            .text_xs()
            .text_color(theme.danger)
            .child("This MCP mutation approval is invalid and cannot be allowed.")
            .into_any_element();
    };
    let prior_unknown = details
        .get("priorUnknownEffect")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let arguments = canonical_mutation_arguments(details);

    v_flex()
        .id("mcp-mutation-approval")
        .w_full()
        .gap_2p5()
        .when(prior_unknown, |el| {
            el.child(
                div()
                    .w_full()
                    .rounded_md()
                    .bg(theme.background)
                    .px_3()
                    .py_2()
                    .border_1()
                    .border_color(theme.danger)
                    .text_xs()
                    .text_color(theme.danger)
                    .child(
                        "A prior call to this target has an unknown outcome. Inspect the remote \
                         system before allowing another attempt.",
                    ),
            )
        })
        .child(
            v_flex()
                .w_full()
                .gap_1()
                .children(rows.into_iter().map(|(label, value, mono)| {
                    h_flex()
                        .w_full()
                        .items_start()
                        .gap_3()
                        .child(
                            div()
                                .w(px(96.))
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(label),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .text_xs()
                                .font_family(if mono {
                                    theme.mono_font_family.clone()
                                } else {
                                    theme.font_family.clone()
                                })
                                .text_color(theme.foreground)
                                .child(value),
                        )
                })),
        )
        .child(
            v_flex()
                .w_full()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.muted_foreground)
                        .child("Complete canonical arguments"),
                )
                .child(
                    div()
                        .id("mcp-mutation-approval-arguments")
                        .w_full()
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .rounded_md()
                        .bg(theme.background)
                        .border_1()
                        .border_color(theme.border)
                        .px_3()
                        .py_2()
                        .font_family(theme.mono_font_family.clone())
                        .text_xs()
                        .text_color(theme.foreground)
                        .child(arguments),
                ),
        )
        .child(
            div()
                .w_full()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(
                    "The configured server controls the effect. Data outside Aiden may change. \
                     Rollback is unavailable. Timeout or cancellation may leave the outcome \
                     unknown. Automatic retry is disabled.",
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details() -> serde_json::Value {
        serde_json::json!({
            "kind": "subagent-mcp-mutation",
            "childLabel": "mutation",
            "serverId": "gmail",
            "toolName": "send_email",
            "connectionDigestPrefix": "aa11bb22cc33",
            "schemaDigestPrefix": "bb22cc33dd44",
            "profileDigestPrefix": "cc33dd44ee55",
            "argumentDigestPrefix": "dd44ee55ff66",
            "classification": "declared_mutating",
            "destructive": "additive",
            "idempotency": "not_declared",
            "openWorld": "open",
            "taskSupport": "forbidden",
            "timeoutMs": 30_000,
            "canonicalArguments": "{\"to\":\"x@y.z\"}",
            "priorUnknownEffect": false,
            "automaticRetry": false,
            "rollbackAvailable": false,
        })
    }

    #[test]
    fn rows_cover_server_tool_classification_profile_and_digest_pins() {
        let rows = mcp_mutation_rows(&details()).expect("valid details");
        let by_label: std::collections::HashMap<&str, (String, bool)> = rows
            .iter()
            .map(|(label, value, mono)| (*label, (value.clone(), *mono)))
            .collect();
        assert_eq!(by_label["Server"].0, "gmail");
        assert!(by_label["Server"].1);
        assert_eq!(by_label["Tool"].0, "send_email");
        assert_eq!(by_label["Classification"].0, "Server declares mutation");
        assert_eq!(
            by_label["Profile"].0,
            "Additive hint · Idempotency not declared · Open-world hint · Task mode forbidden"
        );
        assert_eq!(by_label["Timeout"].0, "30000 ms");
        assert_eq!(
            by_label["Digests"].0,
            "connection aa11bb22cc33 · schema bb22cc33dd44 · profile cc33dd44ee55 · arguments dd44ee55ff66"
        );
    }

    #[test]
    fn prior_unknown_effect_changes_the_allow_label() {
        assert_eq!(mutation_allow_label(&details()), "Allow once");
        let mut value = details();
        value["priorUnknownEffect"] = serde_json::Value::Bool(true);
        assert_eq!(
            mutation_allow_label(&value),
            "Allow once after unknown outcome"
        );
    }

    #[test]
    fn profile_labels_fall_back_for_unknown_values() {
        assert_eq!(destructive_label(Some("destructive")), "Destructive");
        assert_eq!(destructive_label(None), "Destructiveness unknown");
        assert_eq!(open_world_label(Some("closed")), "Closed-world hint");
        assert_eq!(open_world_label(Some("bogus")), "World scope unknown");
    }

    #[test]
    fn malformed_details_fail_closed() {
        assert!(
            mcp_mutation_rows(&serde_json::json!({ "kind": "subagent-mcp-mutation" })).is_none()
        );
        assert!(mcp_mutation_rows(&serde_json::json!({})).is_none());
    }
}
