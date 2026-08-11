//! App-owned Computer Use settings surface.
//!
//! Hydration is inert. Helper inspection and permission prompting are reachable
//! only from the explicit Check and Request permissions controls below.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_computer_use::{
    ComputerUseSettingsRequest, ComputerUseSettingsState, ComputerUseStatusTone,
    COMPUTER_USE_NOTICE_DISMISSED_KEY, COMPUTER_USE_NOTICE_VERSION,
};
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Sizable as _,
};
use gpui_tokio_bridge::Tokio;

use crate::services::computer_use::ComputerUseUserInitiated;

use super::{SettingsServices, SettingsView};

pub const COMPUTER_USE_ENABLED_KEY: &str = "computerUseEnabled";

pub fn computer_use_enabled_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    settings
        .get(COMPUTER_USE_ENABLED_KEY)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub struct ComputerUseState {
    pub state: ComputerUseSettingsState,
    owner_revision: Arc<AtomicU64>,
    /// Persistent privacy-notice acknowledgement (the session-only
    /// acknowledgement remains owned by the app-root privacy reducer).
    pub privacy_notice_dismissed: bool,
    pub privacy_notice_restoring: bool,
    pub privacy_notice_error: Option<String>,
    privacy_notice_revision: Arc<AtomicU64>,
}

impl Default for ComputerUseState {
    fn default() -> Self {
        Self {
            state: ComputerUseSettingsState::default(),
            owner_revision: Arc::new(AtomicU64::new(0)),
            privacy_notice_dismissed: false,
            privacy_notice_restoring: false,
            privacy_notice_error: None,
            privacy_notice_revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl ComputerUseState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.state
            .hydrate(computer_use_enabled_from_settings(settings));
        self.privacy_notice_revision.fetch_add(1, Ordering::AcqRel);
        self.privacy_notice_dismissed = computer_use_notice_dismissed_from_settings(settings);
        self.privacy_notice_restoring = false;
        self.privacy_notice_error = None;
    }

    pub fn leave_section(&mut self) {
        self.owner_revision.fetch_add(1, Ordering::AcqRel);
        self.state.cancel_active();
        self.privacy_notice_revision.fetch_add(1, Ordering::AcqRel);
        self.privacy_notice_restoring = false;
    }

    fn restore_privacy_notice(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if !self.privacy_notice_dismissed || self.privacy_notice_restoring {
            return;
        }
        let revision = self
            .privacy_notice_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        self.privacy_notice_restoring = true;
        self.privacy_notice_error = None;
        let revision_signal = Arc::clone(&self.privacy_notice_revision);
        let config = Arc::clone(&services.config);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    config
                        .remove_setting(COMPUTER_USE_NOTICE_DISMISSED_KEY, &|| true)
                        .map_err(|error| error.to_string())
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if revision_signal.load(Ordering::Acquire) != revision {
                    return;
                }
                this.computer_use.privacy_notice_restoring = false;
                match result {
                    Ok(()) => {
                        this.computer_use.privacy_notice_dismissed = false;
                        cx.emit(crate::settings::SettingsEvent::ComputerUsePrivacyNoticeRestored);
                    }
                    Err(error) => {
                        this.computer_use.privacy_notice_error = Some(
                            "The Computer Use privacy notice could not be restored. Try again."
                                .to_string(),
                        );
                        tracing::warn!(%error, "could not restore Computer Use privacy notice");
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn claim(&self, request: ComputerUseSettingsRequest) -> Arc<dyn Fn() -> bool + Send + Sync> {
        self.owner_revision
            .store(request.revision, Ordering::Release);
        let owner_revision = Arc::clone(&self.owner_revision);
        Arc::new(move || owner_revision.load(Ordering::Acquire) == request.revision)
    }

    fn set_enabled(
        &mut self,
        enabled: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let Some(request) = self.state.begin_toggle(enabled) else {
            return;
        };
        let current = self.claim(request);
        let authority = Arc::clone(&services.computer_use);
        let task = Tokio::spawn(cx, async move {
            authority.set_global_enabled(enabled, current).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(status)) => {
                        this.computer_use.state.complete(request, status);
                    }
                    Ok(Err(error)) => {
                        this.computer_use.state.fail(request, error.to_string());
                    }
                    Err(_) => {
                        this.computer_use
                            .state
                            .fail(request, "The Computer Use change was interrupted.");
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn check(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(request) = self.state.begin_check() else {
            return;
        };
        self.claim(request);
        let authority = Arc::clone(&services.computer_use);
        let task = Tokio::spawn(cx, async move { authority.status(true, None).await });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(status)) => {
                        this.computer_use.state.complete(request, status);
                    }
                    Ok(Err(error)) => {
                        this.computer_use.state.fail(request, error.to_string());
                    }
                    Err(_) => {
                        this.computer_use
                            .state
                            .fail(request, "The helper check was interrupted.");
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn request_permissions(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(request) = self.state.begin_permission_request() else {
            return;
        };
        self.claim(request);
        let authority = Arc::clone(&services.computer_use);
        let task = Tokio::spawn(cx, async move {
            authority
                .request_permissions(ComputerUseUserInitiated::explicit(), None)
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(status)) => {
                        this.computer_use.state.complete(request, status);
                    }
                    Ok(Err(error)) => {
                        this.computer_use.state.fail(request, error.to_string());
                    }
                    Err(_) => {
                        this.computer_use
                            .state
                            .fail(request, "The permission request was interrupted.");
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl SettingsView {
    pub(crate) fn computer_use_section(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.computer_use.state;
        let privacy_notice_dismissed = self.computer_use.privacy_notice_dismissed;
        let privacy_notice_restoring = self.computer_use.privacy_notice_restoring;
        let privacy_notice_error = self.computer_use.privacy_notice_error.clone();
        let presentation = state.presentation();
        let busy = state.active.is_some();
        let status_color = match presentation.tone {
            ComputerUseStatusTone::Neutral => theme.muted_foreground,
            ComputerUseStatusTone::Success => theme.success,
            ComputerUseStatusTone::Warning => theme.warning,
            ComputerUseStatusTone::Danger => theme.danger,
        };
        let can_request = state
            .status
            .as_ref()
            .is_some_and(|status| status.can_request_permissions);

        v_flex()
            .id("computer-use-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Computer use"),
                            )
                            .child(computer_use_badge(
                                "Beta",
                                theme.accent,
                                theme.accent_foreground,
                            )),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "Control native macOS apps through Aiden’s pinned helper. Off by default globally and in every chat.",
                            ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Allow Computer Use"),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child("This global gate only makes the per-chat opt-in available."),
                                    ),
                            )
                            .child(
                                Switch::new("computer-use-enabled")
                                    .checked(state.enabled)
                                    .label(if state.enabled { "On" } else { "Off" })
                                    .disabled(busy)
                                    .on_click(cx.listener(|this, checked, _window, cx| {
                                        let services = this.services.clone();
                                        this.computer_use.set_enabled(*checked, &services, cx);
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                h_flex()
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .gap_2()
                                    .child(
                                        v_flex()
                                            .gap_0p5()
                                            .child(
                                                h_flex()
                                                    .gap_2()
                                                    .child(
                                                        div()
                                                            .text_sm()
                                                            .font_weight(FontWeight::SEMIBOLD)
                                                            .child("Helper and permissions"),
                                                    )
                                                    .child(
                                                        div()
                                                            .px_1p5()
                                                            .py_0p5()
                                                            .rounded_md()
                                                            .bg(status_color.opacity(0.14))
                                                            .text_xs()
                                                            .text_color(status_color)
                                                            .child(presentation.label),
                                                    )
                                                    .when_some(
                                                        state
                                                            .status
                                                            .as_ref()
                                                            .and_then(|status| status.driver_version.clone()),
                                                        |row, version| {
                                                            row.child(computer_use_badge(
                                                                format!("cua-driver {version}"),
                                                                theme.muted_foreground,
                                                                theme.muted_foreground,
                                                            ))
                                                        },
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(theme.muted_foreground)
                                                    .child(presentation.detail),
                                            ),
                                    )
                                    .child(
                                        h_flex()
                                            .gap_1()
                                            .when(can_request, |el| {
                                                el.child(
                                                    Button::new("computer-use-request-permissions")
                                                        .primary()
                                                        .small()
                                                        .label("Request permissions")
                                                        .disabled(busy)
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            let services = this.services.clone();
                                                            this.computer_use.request_permissions(&services, cx);
                                                        })),
                                                )
                                            })
                                            .child(
                                                Button::new("computer-use-check")
                                                    .outline()
                                                    .small()
                                                    .label("Refresh")
                                                    .disabled(
                                                        busy || (!state.enabled && state.error.is_none()),
                                                    )
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        let services = this.services.clone();
                                                        this.computer_use.check(&services, cx);
                                                    })),
                                            ),
                                    ),
                            )
                            .when_some(state.status.as_ref(), |el, status| {
                                el.child(
                                    h_flex()
                                        .gap_2()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(format!(
                                            "Accessibility: {}",
                                            permission_label(status.permissions.accessibility)
                                        ))
                                        .child("·")
                                        .child(format!(
                                            "Screen Recording: {}",
                                            permission_label(status.permissions.screen_recording)
                                        )),
                                )
                            })
                            .when_some(privacy_notice_error.clone(), |el, error| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.danger)
                                        .child(error),
                                )
                            })
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Privacy and control"),
                            )
                            .child(computer_use_badge(
                                "Per-chat opt-in",
                                theme.muted_foreground,
                                theme.muted_foreground,
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(
                                "When a chat opts in, its selected provider may receive bounded screenshots, window details, and accessibility text. Aiden does not persist captured UI. Read-only inspection can run without a prompt; every input action pauses for an attended Allow once or Deny decision.",
                            ),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(computer_use_badge(
                                        "Actions ask first",
                                        theme.warning,
                                        theme.warning,
                                    ))
                                    .child(computer_use_badge(
                                        "No UI capture saved",
                                        theme.success,
                                        theme.success,
                                    )),
                            )
                            .when(privacy_notice_dismissed, |el| {
                                el.child(
                                    Button::new("computer-use-restore-privacy")
                                        .small()
                                        .ghost()
                                        .label(if privacy_notice_restoring {
                                            "Restoring…"
                                        } else {
                                            "Show privacy notice again"
                                        })
                                        .disabled(privacy_notice_restoring)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            let services = this.services.clone();
                                            this.computer_use.restore_privacy_notice(&services, cx);
                                        })),
                                )
                            })
            )
            )
    }
}

fn computer_use_badge(
    label: impl Into<SharedString>,
    background: gpui::Hsla,
    foreground: gpui::Hsla,
) -> impl IntoElement {
    div()
        .rounded_full()
        .bg(background.opacity(0.14))
        .text_color(foreground)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .px_2()
        .py_0p5()
        .child(label.into())
}

fn permission_label(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "Granted",
        Some(false) => "Required",
        None => "Not checked",
    }
}

pub fn computer_use_notice_dismissed_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    settings
        .get(COMPUTER_USE_NOTICE_DISMISSED_KEY)
        .and_then(serde_json::Value::as_u64)
        == Some(COMPUTER_USE_NOTICE_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_use_enabled_reads_the_flat_flag() {
        let mut settings = serde_json::Map::new();
        assert!(!computer_use_enabled_from_settings(&settings));
        settings.insert(COMPUTER_USE_ENABLED_KEY.into(), serde_json::json!(true));
        assert!(computer_use_enabled_from_settings(&settings));
        settings.insert(COMPUTER_USE_ENABLED_KEY.into(), serde_json::json!("yes"));
        assert!(!computer_use_enabled_from_settings(&settings));
    }

    #[test]
    fn permission_copy_never_claims_an_unchecked_permission() {
        assert_eq!(permission_label(None), "Not checked");
        assert_eq!(permission_label(Some(false)), "Required");
        assert_eq!(permission_label(Some(true)), "Granted");
    }

    #[test]
    fn privacy_notice_dismissal_is_versioned_and_fail_closed() {
        let mut settings = serde_json::Map::new();
        assert!(!computer_use_notice_dismissed_from_settings(&settings));
        settings.insert(
            COMPUTER_USE_NOTICE_DISMISSED_KEY.into(),
            serde_json::json!(COMPUTER_USE_NOTICE_VERSION - 1),
        );
        assert!(!computer_use_notice_dismissed_from_settings(&settings));
        settings.insert(
            COMPUTER_USE_NOTICE_DISMISSED_KEY.into(),
            serde_json::json!(COMPUTER_USE_NOTICE_VERSION),
        );
        assert!(computer_use_notice_dismissed_from_settings(&settings));
        settings.insert(
            COMPUTER_USE_NOTICE_DISMISSED_KEY.into(),
            serde_json::json!(true),
        );
        assert!(!computer_use_notice_dismissed_from_settings(&settings));
    }

    #[test]
    fn settings_copy_exposes_beta_readiness_versions_refresh_and_privacy_controls() {
        let source = include_str!("computer_use.rs");
        for copy in [
            "Beta",
            "Readiness",
            "cua-driver",
            "Refresh",
            "Per-chat opt-in",
            "Actions ask first",
            "No UI capture saved",
            "Show privacy notice again",
        ] {
            assert!(source.contains(copy), "missing Computer Use copy: {copy}");
        }
        assert!(source.contains("privacy notice could not be restored"));
        assert!(source.contains("Request permissions"));
    }
}
