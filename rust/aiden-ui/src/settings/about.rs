//! About settings (port of `about-settings.tsx`).
//!
//! App name/version (compile-time constants), the config directory with a
//! reveal-in-Finder action (runs `open` on the background thread), the
//! repository link, and the "data stays local" privacy note.

use gpui::{
    div, AppContext as _, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::Button, h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _, WindowExt,
};

use super::SettingsView;

/// The app name shown in About.
pub const APP_NAME: &str = "Aiden Agent";
/// The repository URL from the workspace manifest.
pub const REPOSITORY_URL: &str = "https://github.com/sambitcreate/aiden-agent";

impl SettingsView {
    /// The About section.
    pub(crate) fn about_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let version = env!("CARGO_PKG_VERSION");
        let config_dir = self.services.config_dir.clone();

        v_flex()
            .id("about-section")
            .w_full()
            .gap_4()
            .child(
                h_flex()
                    .w_full()
                    .gap_4()
                    .items_start()
                    .child(
                        div()
                            .size(gpui::px(56.))
                            .rounded_xl()
                            .bg(theme.muted)
                            .items_center()
                            .justify_center()
                            .child(Icon::new(IconName::Bot).text_color(theme.muted_foreground)),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(gpui::px(0.))
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(APP_NAME),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .mt_0p5()
                                    .child(format!("Version {version} · Beta · Production build")),
                            )
                            .child(
                                h_flex()
                                    .mt_2()
                                    .gap_2()
                                    .child(
                                        Button::new("about-github")
                                            .small()
                                            .icon(IconName::GitHub)
                                            .label("GitHub")
                                            .on_click(cx.listener(|this, _event, window, cx| {
                                                let _ = this;
                                                window.push_notification(
                                                    format!("Project: {REPOSITORY_URL}"),
                                                    cx,
                                                );
                                            })),
                                    )
                                    .child(
                                        Button::new("about-reveal-config")
                                            .small()
                                            .icon(IconName::FolderOpen)
                                            .label("Reveal config folder in Finder")
                                            .on_click(cx.listener({
                                                let config_dir = config_dir.clone();
                                                move |this, _event, _window, cx| {
                                                    this.reveal_in_finder(&config_dir, cx);
                                                }
                                            })),
                                    ),
                            ),
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
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Where your data lives"),
                    )
                    .child(div().text_sm().text_color(theme.muted_foreground).child(
                        "Your chats, provider connections, and settings are stored on this \
                                 Mac. API keys are kept in the macOS keychain and are never sent \
                                 anywhere except the provider you configured.",
                    ))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .mt_1()
                            .child(config_dir.display().to_string()),
                    ),
            )
    }

    /// Reveal a path in Finder via the `open` command (background thread).
    fn reveal_in_finder(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        let path = path.to_path_buf();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    std::process::Command::new("open")
                        .arg("-R")
                        .arg(&path)
                        .spawn()
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                })
                .await;
            if let Err(error) = result {
                this.update(cx, |this, cx| {
                    this.error = Some(format!("Could not reveal the config folder: {error}"));
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_constants_are_filled_in() {
        assert!(!APP_NAME.is_empty());
        assert!(!REPOSITORY_URL.is_empty());
        assert!(REPOSITORY_URL.starts_with("https://github.com/"));
        assert!(!env!("CARGO_PKG_VERSION").is_empty());
    }
}
