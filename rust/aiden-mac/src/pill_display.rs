//! Native display geometry for the non-activating dictation pill.
//!
//! Electron asks the OS for the display under the cursor on every show and
//! positions the pill inside that display's Dock-aware `workArea`. GPUI's
//! public display abstraction exposes frames but not the cursor display or
//! AppKit's visible frame, so this small bridge keeps that platform detail in
//! the macOS crate and returns a copy-only value to the UI layer.

/// The cursor display's usable work area, expressed in GPUI's top-left origin
/// coordinates relative to the display frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorWorkArea {
    /// GPUI/AppKit display identifier used when creating the window.
    pub display_id: u32,
    /// Work-area origin relative to the display frame (top-left origin).
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Full display frame dimensions in the same logical coordinate space.
    pub display_width: f32,
    pub display_height: f32,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
struct RectF {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl CursorWorkArea {
    #[cfg(target_os = "macos")]
    fn valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.display_width.is_finite()
            && self.display_height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
            && self.display_width > 0.0
            && self.display_height > 0.0
            && self.x >= 0.0
            && self.y >= 0.0
            && self.x + self.width <= self.display_width + f32::EPSILON
            && self.y + self.height <= self.display_height + f32::EPSILON
    }
}

/// Return the AppKit display containing the cursor and its Dock/menu-bar-aware
/// visible frame. This is deliberately a foreground, read-only probe: it
/// performs no window activation and no global event registration.
#[cfg(target_os = "macos")]
pub fn cursor_work_area() -> Option<CursorWorkArea> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen};

    let mtm = MainThreadMarker::new()?;
    let cursor = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    let mut fallback = None;
    let mut fallback_distance = f64::INFINITY;

    for screen in screens.to_vec() {
        let frame = screen.frame();
        let visible = screen.visibleFrame();
        let Some(display_id) = screen_display_id(&screen) else {
            continue;
        };
        let candidate = cursor_work_area_from_frames(
            display_id,
            RectF {
                x: frame.origin.x as f32,
                y: frame.origin.y as f32,
                width: frame.size.width as f32,
                height: frame.size.height as f32,
            },
            RectF {
                x: visible.origin.x as f32,
                y: visible.origin.y as f32,
                width: visible.size.width as f32,
                height: visible.size.height as f32,
            },
        );
        if !candidate.valid() {
            continue;
        }
        let dx = if cursor.x < frame.origin.x {
            frame.origin.x - cursor.x
        } else if cursor.x > frame.origin.x + frame.size.width {
            cursor.x - (frame.origin.x + frame.size.width)
        } else {
            0.0
        };
        let dy = if cursor.y < frame.origin.y {
            frame.origin.y - cursor.y
        } else if cursor.y > frame.origin.y + frame.size.height {
            cursor.y - (frame.origin.y + frame.size.height)
        } else {
            0.0
        };
        let distance = dx * dx + dy * dy;
        if distance < fallback_distance {
            fallback_distance = distance;
            fallback = Some(candidate);
        }
        if cursor.x >= frame.origin.x
            && cursor.x < frame.origin.x + frame.size.width
            && cursor.y >= frame.origin.y
            && cursor.y < frame.origin.y + frame.size.height
        {
            return Some(candidate);
        }
    }

    // AppKit can briefly report no cursor-intersecting screen while displays
    // are being reconfigured. The nearest valid frame keeps the pill usable
    // without ever guessing a private/foreign display identifier.
    if fallback.is_none() {
        let screen = NSScreen::mainScreen(mtm)?;
        let frame = screen.frame();
        let visible = screen.visibleFrame();
        let display_id = screen_display_id(&screen)?;
        fallback = Some(cursor_work_area_from_frames(
            display_id,
            RectF {
                x: frame.origin.x as f32,
                y: frame.origin.y as f32,
                width: frame.size.width as f32,
                height: frame.size.height as f32,
            },
            RectF {
                x: visible.origin.x as f32,
                y: visible.origin.y as f32,
                width: visible.size.width as f32,
                height: visible.size.height as f32,
            },
        ));
    }

    fallback.filter(|area| area.valid())
}

/// Non-macOS builds retain a truthful unsupported result rather than
/// fabricating a display or claiming Dock-aware placement.
#[cfg(not(target_os = "macos"))]
pub fn cursor_work_area() -> Option<CursorWorkArea> {
    None
}

#[cfg(target_os = "macos")]
fn screen_display_id(screen: &objc2_app_kit::NSScreen) -> Option<u32> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNumber, NSString};

    // NSScreen's stable CGDirectDisplayID is exposed through the
    // NSScreenNumber entry in its device description. The key is a fixed
    // AppKit constant; it never comes from user input.
    let key = NSString::from_str("NSScreenNumber");
    let value: objc2::rc::Retained<AnyObject> = screen.deviceDescription().objectForKey(&key)?;
    value
        .downcast::<NSNumber>()
        .ok()
        .map(|number| number.unsignedLongValue() as u32)
}

/// Convert AppKit's bottom-left `NSRect` values into GPUI's top-left work-area
/// coordinates. Kept pure for deterministic multi-monitor/Dock geometry tests.
#[cfg(target_os = "macos")]
fn cursor_work_area_from_frames(display_id: u32, frame: RectF, visible: RectF) -> CursorWorkArea {
    CursorWorkArea {
        display_id,
        x: visible.x - frame.x,
        y: frame.height - (visible.y - frame.y + visible.height),
        width: visible.width,
        height: visible.height,
        display_width: frame.width,
        display_height: frame.height,
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn appkit_work_area_uses_top_left_coordinates_and_insets() {
        let area = cursor_work_area_from_frames(
            7,
            RectF {
                x: -1440.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            RectF {
                x: -1440.0,
                y: 24.0,
                width: 1440.0,
                height: 840.0,
            },
        );
        assert_eq!(area.display_id, 7);
        assert_eq!(area.x, 0.0);
        assert_eq!(area.y, 36.0);
        assert_eq!(area.width, 1440.0);
        assert_eq!(area.height, 840.0);
        assert!(area.valid());
    }

    #[test]
    fn invalid_or_outside_work_area_is_rejected() {
        let mut area = cursor_work_area_from_frames(
            1,
            RectF {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            RectF {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        assert!(area.valid());
        area.width = 0.0;
        assert!(!area.valid());
    }
}
