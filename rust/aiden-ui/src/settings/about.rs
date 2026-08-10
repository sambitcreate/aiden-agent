//! Truthful About settings.
//!
//! Product metadata comes from the package manifest used by the shipping
//! application. The repository action always opens the one audited URL and
//! reports launch failures in the settings surface.

use std::sync::Arc;

use gpui::{
    div, img, prelude::FluentBuilder as _, AppContext as _, Context, FontWeight, Image,
    ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, Window,
};
use gpui_component::{button::Button, h_flex, v_flex, ActiveTheme, IconName, Sizable as _};

use super::SettingsView;

pub const APP_NAME: &str = "Aiden Agent";
pub const REPOSITORY_URL: &str = "https://github.com/sambitcreate/aiden-agent";

const PACKAGE_JSON: &str = include_str!("../../../../package.json");
const APP_ICON_PNG: &[u8] = include_bytes!("../../../../resources/app-icon.png");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEnvironment {
    Development,
    Release,
}

impl RuntimeEnvironment {
    pub fn current() -> Self {
        if aiden_data::is_dev_mode() {
            Self::Development
        } else {
            Self::Release
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Development => "Development build",
            Self::Release => "Production build",
        }
    }
}

/// Read the desktop product version from the root package metadata. Keeping
/// this as a function makes malformed build inputs testable without creating
/// another version constant that can drift.
pub fn product_version_from(package_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(package_json)
        .ok()?
        .get("version")?
        .as_str()
        .filter(|version| !version.trim().is_empty())
        .map(ToOwned::to_owned)
}

pub fn product_version() -> String {
    product_version_from(PACKAGE_JSON).unwrap_or_else(|| "Unknown".to_string())
}

fn launch_repository_with(launch: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    launch(REPOSITORY_URL)
}

impl SettingsView {
    pub(crate) fn about_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let version = product_version();
        let environment = RuntimeEnvironment::current().label();
        let inline_error = self.error.clone();

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
                            .size(gpui::px(64.))
                            .rounded_xl()
                            .overflow_hidden()
                            .child(
                                img(Arc::new(Image::from_bytes(
                                    ImageFormat::Png,
                                    APP_ICON_PNG.to_vec(),
                                )))
                                .size_full(),
                            ),
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
                                    .child(format!("Version {version} · Beta · {environment}")),
                            )
                            .child(
                                h_flex().mt_2().child(
                                    Button::new("about-github")
                                        .small()
                                        .icon(IconName::GitHub)
                                        .label("GitHub")
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.open_repository(cx);
                                        })),
                                ),
                            ),
                    ),
            )
            .when_some(inline_error, |view, message| {
                view.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .text_sm()
                        .text_color(theme.danger)
                        .child(message),
                )
            })
    }

    fn open_repository(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    launch_repository_with(|url| {
                        std::process::Command::new("/usr/bin/open")
                            .arg(url)
                            .spawn()
                            .map(|_| ())
                            .map_err(|error| error.to_string())
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if let Err(error) = result {
                    this.error = Some(format!("Could not open the GitHub repository: {error}"));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_version_comes_from_root_package_metadata() {
        assert_eq!(product_version(), "0.27.0");
        assert_eq!(
            product_version_from(r#"{"version":"1.2.3"}"#).as_deref(),
            Some("1.2.3")
        );
        assert_eq!(product_version_from("{}"), None);
    }

    #[test]
    fn runtime_environment_uses_the_aiden_dev_profile() {
        assert_eq!(
            RuntimeEnvironment::current(),
            if aiden_data::is_dev_mode() {
                RuntimeEnvironment::Development
            } else {
                RuntimeEnvironment::Release
            }
        );
    }

    #[test]
    fn repository_opener_receives_only_the_fixed_url_and_surfaces_failure() {
        let mut observed = None;
        let result = launch_repository_with(|url| {
            observed = Some(url.to_string());
            Err("launcher unavailable".to_string())
        });
        assert_eq!(observed.as_deref(), Some(REPOSITORY_URL));
        assert_eq!(result.unwrap_err(), "launcher unavailable");
    }
}
