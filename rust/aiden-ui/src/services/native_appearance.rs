//! Foreground-only owner for Aiden's optional macOS appearance bridge.
//!
//! The AppKit service itself is deliberately not `Send`: it is constructed,
//! restored, polled, and dropped by [`ChatService`](super::chat_service::ChatService)
//! on GPUI's foreground executor. The observer callback only forwards its
//! small, copyable snapshots through a channel; it never touches a GPUI entity
//! or AppKit state after the callback returns.

use std::sync::mpsc::{self, Receiver};

use aiden_core::appearance::{DockIcon, Mode};
use aiden_mac::appearance::{
    AppearanceEvent, BootRestoreResult, DockIcon as NativeDockIcon, EffectiveAppearance,
    MacAppearanceBackend, NativeAppearanceService, ResourceRoots, ThemeSource,
};

#[derive(Debug, Clone, Copy)]
pub struct NativeBootRestore {
    pub effective: EffectiveAppearance,
    pub dock_icon: DockIcon,
}

pub struct NativeAppearance {
    service: Option<NativeAppearanceService<MacAppearanceBackend>>,
    events: Option<Receiver<AppearanceEvent>>,
    applied: Option<(Mode, DockIcon)>,
}

/// The result of the synchronous launch preparation.  This deliberately owns
/// the AppKit service: it is restored on the foreground thread before a GPUI
/// window is opened, then moved into `ChatService` for the rest of the
/// process lifetime.
pub struct PreparedNativeAppearance {
    pub native: NativeAppearance,
    pub restored: Option<NativeBootRestore>,
}

impl NativeAppearance {
    pub fn new() -> Self {
        let service = MacAppearanceBackend::new().ok().map(|backend| {
            NativeAppearanceService::new(backend, ResourceRoots::for_current_process())
        });
        Self {
            service,
            events: None,
            applied: None,
        }
    }

    pub fn is_supported(&self) -> bool {
        self.service.is_some()
    }

    /// Start observation and restore the exact persisted native state before
    /// Settings is available. `restore_at_boot` has the Aiden-icon fallback
    /// transaction built in, so an unavailable custom icon never leaves the
    /// process reporting a made-up selected state.
    pub fn restore_at_boot(
        &mut self,
        mode: Mode,
        dock_icon: DockIcon,
    ) -> Result<NativeBootRestore, String> {
        let Some(service) = &mut self.service else {
            return Err("Native appearance is unavailable on this platform.".into());
        };
        let restored: BootRestoreResult = service
            .restore_at_boot(theme_source(mode), native_dock_icon(dock_icon))
            .map_err(|error| error.to_string())?;
        let effective = service
            .effective_appearance()
            .map_err(|error| error.to_string())?;
        let dock_icon = from_native_dock_icon(restored.dock_icon);
        self.applied = Some((mode, dock_icon));
        Ok(NativeBootRestore {
            effective,
            dock_icon,
        })
    }

    /// Register observation independently of restoring/applying native state.
    /// A transient notification failure can therefore be retried without
    /// replaying the user's theme or Dock transaction.
    pub fn ensure_observation(&mut self) -> Result<(), String> {
        if self.events.is_some() {
            return Ok(());
        }
        let Some(service) = &mut self.service else {
            return Err("Native appearance is unavailable on this platform.".into());
        };
        let (sender, receiver) = mpsc::channel();
        service
            .start_accessibility_observation()
            .map_err(|error| error.to_string())?;
        service
            .observe(move |event| {
                let _ = sender.send(event);
            })
            .map_err(|error| error.to_string())?;
        self.events = Some(receiver);
        Ok(())
    }

    pub fn apply(&mut self, mode: Mode, dock_icon: DockIcon) -> Result<(), String> {
        let Some(service) = &mut self.service else {
            return Err("Native appearance service is unavailable.".into());
        };
        let previous = self.applied;
        service
            .set_theme_source(theme_source(mode))
            .map_err(|error| error.to_string())?;
        if let Err(error) = service.set_dock_icon(native_dock_icon(dock_icon)) {
            // Theme then Dock is an all-or-nothing user operation. Best-effort
            // rollback restores the precise last confirmed native snapshot;
            // retain the original error even if rollback also fails.
            if let Some((previous_mode, previous_icon)) = previous {
                let theme_rollback = service
                    .set_theme_source(theme_source(previous_mode))
                    .map_err(|error| error.to_string());
                let icon_rollback = service
                    .set_dock_icon(native_dock_icon(previous_icon))
                    .map_err(|error| error.to_string());
                let (snapshot, message) = rollback_disposition(
                    (previous_mode, previous_icon),
                    error.to_string(),
                    theme_rollback,
                    icon_rollback,
                );
                self.applied = snapshot;
                return Err(message);
            } else {
                self.applied = None;
                return Err(format!(
                    "{error}. Native appearance is unknown; use Retry to reapply both settings."
                ));
            }
        }
        self.applied = Some((mode, dock_icon));
        Ok(())
    }

    /// Drain the observer without blocking the foreground executor.
    pub fn take_events(&mut self) -> Vec<AppearanceEvent> {
        let Some(events) = &self.events else {
            return Vec::new();
        };
        events.try_iter().collect()
    }
}

fn rollback_message<T, E: std::fmt::Display>(result: &Result<T, E>) -> String {
    match result {
        Ok(_) => "restored".into(),
        Err(error) => error.to_string(),
    }
}

fn rollback_disposition(
    previous: (Mode, DockIcon),
    original: String,
    theme: Result<(), String>,
    icon: Result<(), String>,
) -> (Option<(Mode, DockIcon)>, String) {
    if theme.is_ok() && icon.is_ok() {
        return (Some(previous), original);
    }
    let message = format!(
        "{original}; rollback failed (theme: {}; Dock icon: {}). Native appearance is unknown; use Retry to reapply both settings.",
        rollback_message(&theme),
        rollback_message(&icon),
    );
    (None, message)
}

/// Restore the persisted native intent before the first main-window frame.
/// Native appearance is optional, so an unavailable bridge is an honest
/// fallback rather than a reason to delay showing the app.
pub fn prepare_for_main_window(mode: Mode, dock_icon: DockIcon) -> PreparedNativeAppearance {
    let mut native = NativeAppearance::new();
    let restored = if native.is_supported() {
        match native.restore_at_boot(mode, dock_icon) {
            Ok(restored) => Some(restored),
            Err(error) => {
                tracing::warn!(%error, "native appearance could not be restored before window creation");
                None
            }
        }
    } else {
        None
    };
    PreparedNativeAppearance { native, restored }
}

fn theme_source(mode: Mode) -> ThemeSource {
    match mode {
        Mode::System => ThemeSource::System,
        Mode::Light => ThemeSource::Light,
        Mode::Dark => ThemeSource::Dark,
    }
}

fn native_dock_icon(icon: DockIcon) -> NativeDockIcon {
    match icon {
        DockIcon::Aiden => NativeDockIcon::Aiden,
        DockIcon::Monochrome => NativeDockIcon::Monochrome,
    }
}

fn from_native_dock_icon(icon: NativeDockIcon) -> DockIcon {
    match icon {
        NativeDockIcon::Aiden => DockIcon::Aiden,
        NativeDockIcon::Monochrome => DockIcon::Monochrome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_failure_discards_the_logical_native_snapshot() {
        let (snapshot, message) = rollback_disposition(
            (Mode::Light, DockIcon::Aiden),
            "Dock apply failed".into(),
            Err("theme rollback failed".into()),
            Ok(()),
        );

        assert_eq!(snapshot, None);
        assert!(message.contains("unknown"));
        assert!(message.contains("Retry"));
    }

    #[test]
    fn complete_rollback_retains_the_previous_native_snapshot() {
        let previous = (Mode::Dark, DockIcon::Monochrome);
        let (snapshot, message) =
            rollback_disposition(previous, "Dock apply failed".into(), Ok(()), Ok(()));

        assert_eq!(snapshot, Some(previous));
        assert_eq!(message, "Dock apply failed");
    }
}
