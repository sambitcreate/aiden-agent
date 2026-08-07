//! Reusable tool-approval card (the "Allow once / Allow session / Deny" card).
//!
//! Renders a gated coding-tool call (`write_file` / `edit_file` /
//! `run_command`): the tool name, a syntax-muted JSON arguments preview, a
//! risk badge, and the three-way decision buttons. The card emits a typed
//! [`ApprovalDecision`] through the injected callback; `deciding` disables the
//! actions while the decision is in flight.

use std::rc::Rc;

use gpui::{
    div, prelude::FluentBuilder as _, px, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, Disableable as _, IconName, Sizable as _,
};

use crate::approvals::queue::PendingApproval;
use crate::approvals::ApprovalDecision;

/// Bound for the JSON preview so a pathological arguments payload cannot blow
/// up the card.
pub const MAX_ARGS_PREVIEW_CHARS: usize = 4_000;

/// The syntax-muted JSON preview: pretty-printed, bounded, with a trailing
/// ellipsis when truncated.
pub fn json_preview(value: &serde_json::Value, max_chars: usize) -> String {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    let count = pretty.chars().count();
    if count > max_chars {
        let mut truncated: String = pretty.chars().take(max_chars).collect();
        truncated.push_str("\n…");
        truncated
    } else {
        pretty
    }
}

/// The risk-badge label for a tool approval's `risk` discriminator.
pub fn risk_label(risk: Option<&str>) -> &'static str {
    match risk {
        Some("mutating") => "Mutating",
        Some("destructive") => "Destructive",
        Some("unproven-mutating") => "Mutation unproven",
        _ => "Unknown risk",
    }
}

/// Render the tool-approval card.
#[allow(clippy::too_many_arguments)]
pub fn tool_approval_card(
    theme: &gpui_component::Theme,
    approval: &PendingApproval,
    deciding: bool,
    on_decision: Rc<dyn Fn(ApprovalDecision) + 'static>,
) -> impl IntoElement {
    let risk = approval
        .details
        .as_ref()
        .and_then(|details| details.get("risk"))
        .and_then(serde_json::Value::as_str);
    let arguments = approval
        .details
        .as_ref()
        .and_then(|details| details.get("arguments"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let preview = json_preview(&arguments, MAX_ARGS_PREVIEW_CHARS);

    let decide = |decision: ApprovalDecision| {
        let on_decision = on_decision.clone();
        move |_event: &gpui::ClickEvent, _window: &mut gpui::Window, _cx: &mut gpui::App| {
            on_decision(decision);
        }
    };

    v_flex()
        .id("tool-approval-card")
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
                                .child(risk_label(risk)),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                                .child(approval.tool_name.clone()),
                        ),
                )
                .when(!approval.summary.is_empty(), |el| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(approval.summary.clone()),
                    )
                }),
        )
        .child(
            div()
                .id("tool-approval-args")
                .w_full()
                .max_h(px(160.))
                .overflow_y_scroll()
                .rounded_md()
                .bg(theme.background)
                .px_2()
                .py_2()
                .border_1()
                .border_color(theme.border)
                .child(
                    div()
                        .font_family(theme.mono_font_family.clone())
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(preview),
                ),
        )
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_end()
                .gap_1()
                .child(
                    Button::new("approval-deny")
                        .ghost()
                        .small()
                        .label(ApprovalDecision::Deny.label())
                        .icon(IconName::Close)
                        .disabled(deciding)
                        .on_click(decide(ApprovalDecision::Deny)),
                )
                .child(
                    Button::new("approval-session")
                        .outline()
                        .small()
                        .label(ApprovalDecision::AllowSession.label())
                        .disabled(deciding)
                        .on_click(decide(ApprovalDecision::AllowSession)),
                )
                .child(
                    Button::new("approval-once")
                        .primary()
                        .small()
                        .label(ApprovalDecision::AllowOnce.label())
                        .icon(IconName::Check)
                        .disabled(deciding)
                        .on_click(decide(ApprovalDecision::AllowOnce)),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_preview_is_pretty_printed_and_bounded() {
        let value = serde_json::json!({ "path": "src/main.rs", "content": "hi" });
        let preview = json_preview(&value, 1000);
        assert!(preview.contains("\n"));
        assert!(preview.contains("\"path\": \"src/main.rs\""));
        let long = serde_json::json!({ "blob": "x".repeat(10_000) });
        let bounded = json_preview(&long, 4000);
        assert!(bounded.ends_with("\n…"));
        assert!(bounded.chars().count() <= 4000 + 2);
    }

    #[test]
    fn risk_labels_map_known_and_unknown_risks() {
        assert_eq!(risk_label(Some("mutating")), "Mutating");
        assert_eq!(risk_label(Some("destructive")), "Destructive");
        assert_eq!(risk_label(Some("unproven-mutating")), "Mutation unproven");
        assert_eq!(risk_label(Some("bogus")), "Unknown risk");
        assert_eq!(risk_label(None), "Unknown risk");
    }
}
