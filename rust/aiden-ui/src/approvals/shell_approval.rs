//! Full-host shell command approval (port of
//! `renderer/components/subagent-shell-approval.tsx`).
//!
//! Renders the exact command in a mono block plus the capability facts
//! (initial cwd, shell, workspace, limits, digest pins) and the honest
//! full-host reach warning. This is a *content* section — the decision buttons
//! live in the parent approval card. Details are validated through
//! `aiden_core::is_subagent_shell_approval_details`; malformed details render
//! the fail-closed invalid state and can never be allowed.

use gpui::{
    div, px, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _,
};
use gpui_component::{h_flex, v_flex};

/// The full-host reach warning, mirroring the renderer's copy.
pub const SHELL_REACH_WARNING: &str =
    "This command is not OS-sandboxed. It has the macOS user's filesystem, process, \
     system-tool, Keychain/API, and arbitrary network reach. The minimal environment only \
     reduces ambient secrets. There is no rollback, output is sent to the configured model, \
     and deliberately detached processes may survive cancellation.";

/// One label/value row of the capability grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellApprovalRow {
    pub label: &'static str,
    pub value: String,
    pub mono: bool,
}

/// The capability rows for a validated shell approval (`initialCwd`, `shell`,
/// workspace, limits, digests). Returns `None` when the details fail the
/// renderer contract — the card renders the invalid state instead.
pub fn shell_approval_rows(details: &serde_json::Value) -> Option<Vec<ShellApprovalRow>> {
    if !aiden_core::is_subagent_shell_approval_details(details) {
        return None;
    }
    let get = |key: &str| {
        details
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };

    let workspace = match details
        .get("worktreeLabel")
        .and_then(serde_json::Value::as_str)
    {
        Some(worktree) if !worktree.is_empty() => {
            format!("{} · worktree {}", get("workspaceLabel"), worktree)
        }
        _ => get("workspaceLabel").to_string(),
    };

    let mut rows = vec![
        ShellApprovalRow {
            label: "Initial cwd",
            value: get("initialCwd").to_string(),
            mono: true,
        },
        ShellApprovalRow {
            label: "Shell",
            value: get("shell").to_string(),
            mono: true,
        },
        ShellApprovalRow {
            label: "Workspace",
            value: workspace,
            mono: false,
        },
        ShellApprovalRow {
            label: "Limits",
            value: format!(
                "{} ms · stdout/stderr {} KiB each",
                details
                    .get("timeoutMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                details
                    .get("stdoutLimitBytes")
                    .and_then(serde_json::Value::as_u64)
                    .map(|bytes| bytes / 1024)
                    .unwrap_or(512)
            ),
            mono: false,
        },
        ShellApprovalRow {
            label: "Digests",
            value: format!(
                "arguments {} · root {} · effect {}",
                get("argumentDigestPrefix"),
                get("rootDigestPrefix"),
                get("effectDigestPrefix")
            ),
            mono: true,
        },
    ];
    if let Some(profile) = details
        .get("environmentProfile")
        .and_then(serde_json::Value::as_str)
    {
        if !profile.is_empty() {
            rows.push(ShellApprovalRow {
                label: "Environment",
                value: profile.to_string(),
                mono: false,
            });
        }
    }
    Some(rows)
}

/// The exact command the full-host shell would run.
pub fn shell_command(details: &serde_json::Value) -> String {
    details
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Render the shell-approval content section.
pub fn shell_approval_section(
    theme: &gpui_component::Theme,
    details: &serde_json::Value,
) -> impl IntoElement {
    let Some(rows) = shell_approval_rows(details) else {
        return v_flex()
            .id("shell-approval-invalid")
            .w_full()
            .rounded_md()
            .bg(theme.background)
            .px_3()
            .py_2()
            .border_1()
            .border_color(theme.danger)
            .text_xs()
            .text_color(theme.danger)
            .child("This shell approval is invalid and cannot be allowed.")
            .into_any_element();
    };
    let command = shell_command(details);

    v_flex()
        .id("shell-approval")
        .w_full()
        .gap_2p5()
        .child(
            v_flex()
                .w_full()
                .gap_1()
                .children(rows.into_iter().map(|row| {
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
                                .child(row.label),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .text_xs()
                                .font_family(if row.mono {
                                    theme.mono_font_family.clone()
                                } else {
                                    theme.font_family.clone()
                                })
                                .text_color(theme.foreground)
                                .child(row.value),
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
                        .child("Complete exact command"),
                )
                .child(
                    div()
                        .id("shell-approval-command")
                        .w_full()
                        .max_h(px(192.))
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
                        .child(command),
                ),
        )
        .child(
            div()
                .w_full()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(SHELL_REACH_WARNING),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details() -> serde_json::Value {
        serde_json::json!({
            "kind": "subagent-shell",
            "childLabel": "shell",
            "command": "cargo test -p aiden-ui",
            "initialCwd": "/tmp/project",
            "shell": "/bin/zsh -f -c",
            "argumentDigestPrefix": "a1b2c3d4e5f6",
            "rootDigestPrefix": "d4e5f6a1b2c3",
            "effectDigestPrefix": "g7h8i9j0k1l2",
            "timeoutMs": 60_000,
            "stdoutLimitBytes": 524_288,
            "stderrLimitBytes": 524_288,
            "workspaceLabel": "Website",
            "isManagedWorktree": false,
            "worktreeLabel": null,
            "environmentProfile": "minimal-private-0700-v1",
            "osSandboxed": false,
            "rollbackAvailable": false,
            "outputSentToModel": true,
            "arbitraryNetworkAvailable": true,
            "detachedProcessesMaySurvive": true,
        })
    }

    #[test]
    fn rows_cover_cwd_shell_limits_and_digest_pins() {
        let rows = shell_approval_rows(&details()).expect("valid details");
        let by_label: std::collections::HashMap<&str, &ShellApprovalRow> =
            rows.iter().map(|row| (row.label, row)).collect();
        assert_eq!(by_label["Initial cwd"].value, "/tmp/project");
        assert!(by_label["Initial cwd"].mono);
        assert_eq!(by_label["Shell"].value, "/bin/zsh -f -c");
        assert_eq!(by_label["Workspace"].value, "Website");
        assert_eq!(
            by_label["Limits"].value,
            "60000 ms · stdout/stderr 512 KiB each"
        );
        assert_eq!(
            by_label["Digests"].value,
            "arguments a1b2c3d4e5f6 · root d4e5f6a1b2c3 · effect g7h8i9j0k1l2"
        );
        assert_eq!(by_label["Environment"].value, "minimal-private-0700-v1");
    }

    #[test]
    fn worktree_label_is_appended_when_present() {
        let mut value = details();
        value["worktreeLabel"] = serde_json::Value::String("wt-1".into());
        value["isManagedWorktree"] = serde_json::Value::Bool(true);
        let rows = shell_approval_rows(&value).expect("valid");
        let workspace = rows
            .iter()
            .find(|row| row.label == "Workspace")
            .expect("workspace row");
        assert_eq!(workspace.value, "Website · worktree wt-1");
    }

    #[test]
    fn malformed_details_fail_closed() {
        assert!(shell_approval_rows(&serde_json::json!({ "kind": "subagent-shell" })).is_none());
        assert!(shell_approval_rows(&serde_json::json!({})).is_none());
        // The exact command is only surfaced for valid details.
        assert_eq!(shell_command(&serde_json::json!({})), "");
    }
}
