//! Small macOS VoiceOver announcement bridge.
//!
//! AppKit exposes announcements as an accessibility notification on the
//! application object. The bridge keeps that unsafe/native boundary in the
//! macOS crate; callers only provide a bounded lifecycle message and receive a
//! boolean indicating whether AppKit accepted it.

/// Maximum number of Unicode scalar values sent to VoiceOver for one event.
///
/// Lifecycle announcements are intentionally short. Bounding this text also
/// prevents provider-controlled errors from becoming an unbounded native
/// payload.
pub const MAX_ANNOUNCEMENT_CHARS: usize = 512;

/// Normalize a lifecycle announcement before it reaches a native accessibility
/// API.
///
/// Control characters and runs of whitespace become one plain space. Empty
/// input is ignored, and the result is bounded by [`MAX_ANNOUNCEMENT_CHARS`].
pub fn sanitize_announcement(value: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut pending_space = false;
    let mut char_count = 0;

    for character in value.chars() {
        if character.is_whitespace() || character.is_control() {
            if !normalized.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if char_count >= MAX_ANNOUNCEMENT_CHARS {
            break;
        }
        if pending_space {
            normalized.push(' ');
            char_count += 1;
            pending_space = false;
            if char_count >= MAX_ANNOUNCEMENT_CHARS {
                break;
            }
        }
        normalized.push(character);
        char_count += 1;
    }

    (!normalized.is_empty()).then_some(normalized)
}

/// Ask VoiceOver to announce a bounded lifecycle message.
///
/// This is a no-op on non-macOS hosts and when called off the AppKit main
/// thread. Returning `false` in those cases keeps unsupported builds honest
/// instead of pretending that accessibility state was delivered.
pub fn announce(value: &str) -> bool {
    let Some(value) = sanitize_announcement(value) else {
        return false;
    };

    #[cfg(target_os = "macos")]
    {
        post_announcement(&value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = value;
        false
    }
}

#[cfg(target_os = "macos")]
fn post_announcement(value: &str) -> bool {
    use objc2::{
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
        MainThreadMarker,
    };
    use objc2_app_kit::{
        NSAccessibilityAnnouncementKey, NSAccessibilityAnnouncementRequestedNotification,
        NSAccessibilityNotificationUserInfoKey, NSAccessibilityPostNotificationWithUserInfo,
        NSApplication,
    };
    use objc2_foundation::{NSCopying, NSDictionary, NSString};

    let Some(mtm) = MainThreadMarker::new() else {
        tracing::debug!("skipping VoiceOver announcement off the AppKit main thread");
        return false;
    };

    let app = NSApplication::sharedApplication(mtm);
    let announcement = NSString::from_str(value);
    let announcement_object: &AnyObject = &announcement;
    // SAFETY: AppKit owns this process-wide immutable notification key.
    let key: &ProtocolObject<dyn NSCopying> =
        unsafe { ProtocolObject::from_ref(NSAccessibilityAnnouncementKey) };
    let user_info: Retained<NSDictionary<NSAccessibilityNotificationUserInfoKey, AnyObject>> =
        unsafe { NSDictionary::dictionaryWithObject_forKey(announcement_object, key) };

    // SAFETY: `app` is a live AppKit object obtained on the main thread,
    // `NSAccessibilityAnnouncementRequestedNotification` is an AppKit static,
    // and `user_info` contains the documented NSString announcement key/value.
    unsafe {
        NSAccessibilityPostNotificationWithUserInfo(
            &app,
            NSAccessibilityAnnouncementRequestedNotification,
            Some(&user_info),
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizer_collapses_whitespace_and_controls() {
        assert_eq!(
            sanitize_announcement("  Aiden\n\tfinished\u{0000} safely.  "),
            Some("Aiden finished safely.".to_string())
        );
    }

    #[test]
    fn sanitizer_rejects_empty_input() {
        assert_eq!(sanitize_announcement(" \n\t\0 "), None);
    }

    #[test]
    fn sanitizer_bounds_unicode_scalars() {
        let input = "x".repeat(MAX_ANNOUNCEMENT_CHARS + 40);
        let output = sanitize_announcement(&input).expect("non-empty input is retained");
        assert_eq!(output.chars().count(), MAX_ANNOUNCEMENT_CHARS);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn announce_is_a_noop_off_macos() {
        assert!(!announce("Aiden finished generating a response."));
    }
}
