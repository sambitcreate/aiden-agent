//! macOS notifications — port of the Electron `Notification` surface used for
//! scheduled-run banners (`schedule-notification.ts` wires it through
//! `aiden-scheduler::notification::show_scheduled_notification`).
//!
//! Delivery uses `mac-notification-sys` (UNUserNotificationCenter). Before the
//! first delivery the app must announce its bundle identifier; `preflight`
//! does that (idempotent) and is the permission probe for the scheduler's
//! `NotificationBackend::is_supported`.

/// The notification façade for the scheduler: reports whether notifications can
/// be delivered on this platform/build.
pub fn is_supported() -> bool {
    cfg!(target_os = "macos")
}

#[derive(Debug, thiserror::Error)]
pub enum NotifyError {
    #[error("Notifications are unsupported on this platform.")]
    UnsupportedPlatform,
    #[error("macOS notification delivery failed: {0}")]
    Delivery(String),
    #[error("Could not announce the app bundle identifier: {0}")]
    Application(String),
}

/// Preflight: announce the app's bundle id to the notification center and
/// verify delivery is reachable. Call once on macOS before the first banner.
pub fn preflight() -> Result<(), NotifyError> {
    #[cfg(target_os = "macos")]
    {
        mac_notification_sys::set_application(crate::APP_BUNDLE_ID)
            .map_err(|error| NotifyError::Application(error.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(NotifyError::UnsupportedPlatform)
    }
}

/// Deliver a notification with a title and body.
pub fn send_notification(title: &str, body: &str) -> Result<(), NotifyError> {
    #[cfg(target_os = "macos")]
    {
        mac_notification_sys::send_notification(title, None, body, None)
            .map(|_| ())
            .map_err(|error| NotifyError::Delivery(error.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Err(NotifyError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_matches_the_platform() {
        #[cfg(target_os = "macos")]
        assert!(is_supported());
        #[cfg(not(target_os = "macos"))]
        assert!(!is_supported());
    }

    #[test]
    fn unsupported_platforms_fail_cleanly() {
        #[cfg(not(target_os = "macos"))]
        {
            assert!(matches!(preflight(), Err(NotifyError::UnsupportedPlatform)));
            assert!(matches!(
                send_notification("t", "b"),
                Err(NotifyError::UnsupportedPlatform)
            ));
        }
    }
}
