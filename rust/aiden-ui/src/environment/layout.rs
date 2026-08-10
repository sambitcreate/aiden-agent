//! Pure Environment panel geometry, kept byte-for-byte equivalent to the
//! renderer contract in `environment-panel-layout.ts`.

pub const DEFAULT_PANEL_WIDTH: f32 = 560.0;
pub const MIN_PANEL_WIDTH: f32 = 480.0;
pub const MAX_PANEL_WIDTH: f32 = 720.0;
pub const MIN_CONVERSATION_WIDTH: f32 = 560.0;
pub const PANEL_EDGE_GUTTER: f32 = 44.0;
pub const INLINE_MIN_CONTAINER_WIDTH: f32 = MIN_PANEL_WIDTH + MIN_CONVERSATION_WIDTH;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnvironmentLayout {
    pub width: f32,
    pub inline: bool,
}

pub fn clamp_panel_width(value: f32, container_width: f32) -> f32 {
    let available = (container_width - PANEL_EDGE_GUTTER).max(0.0);
    let maximum = MAX_PANEL_WIDTH.min(if available == 0.0 {
        MAX_PANEL_WIDTH
    } else {
        available
    });
    let minimum = MIN_PANEL_WIDTH.min(maximum);
    if value.is_finite() {
        value.clamp(minimum, maximum)
    } else {
        DEFAULT_PANEL_WIDTH.clamp(minimum, maximum)
    }
}

pub fn resolve_layout(preferred_width: f32, container_width: f32) -> EnvironmentLayout {
    let available = (container_width - PANEL_EDGE_GUTTER).max(0.0);
    let min_panel = MIN_PANEL_WIDTH.min(if available == 0.0 {
        MIN_PANEL_WIDTH
    } else {
        available
    });
    let can_inline = container_width >= INLINE_MIN_CONTAINER_WIDTH
        && container_width - min_panel >= MIN_CONVERSATION_WIDTH;
    if !can_inline {
        return EnvironmentLayout {
            width: clamp_panel_width(preferred_width, container_width),
            inline: false,
        };
    }
    let inline_max = container_width - MIN_CONVERSATION_WIDTH;
    EnvironmentLayout {
        width: clamp_panel_width(preferred_width, container_width).min(inline_max),
        inline: true,
    }
}

pub fn keyboard_resize_width(
    current: f32,
    key: &str,
    shift: bool,
    container_width: f32,
) -> Option<f32> {
    let increment = if shift { 40.0 } else { 16.0 };
    let next = match key {
        "left" => current + increment,
        "right" => current - increment,
        "home" => MIN_PANEL_WIDTH,
        "end" => MAX_PANEL_WIDTH,
        _ => return None,
    };
    Some(clamp_panel_width(next, container_width))
}

pub fn summary_card_width(container_width: f32) -> f32 {
    if container_width.is_finite() {
        (container_width - 24.0).clamp(0.0, 380.0)
    } else {
        380.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_layout_examples_match_electron() {
        assert_eq!(
            resolve_layout(560.0, 1200.0),
            EnvironmentLayout {
                width: 560.0,
                inline: true
            }
        );
        assert_eq!(
            resolve_layout(720.0, 1100.0),
            EnvironmentLayout {
                width: 540.0,
                inline: true
            }
        );
        assert_eq!(
            resolve_layout(560.0, 1040.0),
            EnvironmentLayout {
                width: 480.0,
                inline: true
            }
        );
        assert_eq!(
            resolve_layout(560.0, 1039.0),
            EnvironmentLayout {
                width: 560.0,
                inline: false
            }
        );
        assert_eq!(
            resolve_layout(560.0, 700.0),
            EnvironmentLayout {
                width: 560.0,
                inline: false
            }
        );
        assert_eq!(
            resolve_layout(560.0, 500.0),
            EnvironmentLayout {
                width: 456.0,
                inline: false
            }
        );
    }

    #[test]
    fn keyboard_resize_uses_canonical_steps_and_clamps() {
        assert_eq!(
            keyboard_resize_width(560.0, "left", false, 1200.0),
            Some(576.0)
        );
        assert_eq!(
            keyboard_resize_width(560.0, "right", true, 1200.0),
            Some(520.0)
        );
        assert_eq!(
            keyboard_resize_width(560.0, "home", false, 1200.0),
            Some(480.0)
        );
        assert_eq!(
            keyboard_resize_width(560.0, "end", false, 1200.0),
            Some(720.0)
        );
        assert_eq!(keyboard_resize_width(560.0, "escape", false, 1200.0), None);
    }

    #[test]
    fn summary_card_respects_the_workbench_not_the_outer_window() {
        assert_eq!(summary_card_width(700.0), 380.0);
        assert_eq!(summary_card_width(390.0), 366.0);
        assert_eq!(summary_card_width(360.0), 336.0);
    }
}
