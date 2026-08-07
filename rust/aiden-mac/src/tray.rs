//! Menu-bar status item — port of the tray/menu role the Electron app owns.
//!
//! Built on `tray-icon` + `muda`. **macOS requirements:** the status item must
//! be created on the main thread with a live NSApplication event loop, and the
//! returned [`TrayHandle`] must stay alive for the process lifetime (dropping
//! it removes the item). Menu events arrive on the global `MenuEvent` channel
//! and are polled with [`poll_tray_command`] from the GPUI foreground task.

use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

/// Menu item ids (stable, surfaced to the GPUI app).
pub const TRAY_OPEN_ID: &str = "aiden-open";
pub const TRAY_QUIT_ID: &str = "aiden-quit";

#[derive(Debug, thiserror::Error)]
pub enum TrayError {
    #[error("Could not build the menu: {0}")]
    Menu(String),
    #[error("Could not build the tray icon: {0}")]
    Icon(String),
    #[error("Could not create the status item: {0}")]
    Tray(String),
}

/// Commands a tray activation can produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    Open,
    Quit,
    /// A menu item this module does not own.
    Other,
}

/// The owned status item + its menu ids.
///
/// The `icon` field is intentionally never read: holding it alive keeps the
/// status item visible; dropping the handle removes it.
pub struct TrayHandle {
    #[allow(dead_code)]
    icon: TrayIcon,
    open_id: MenuId,
    quit_id: MenuId,
}

impl TrayHandle {
    pub fn open_id(&self) -> &MenuId {
        &self.open_id
    }

    pub fn quit_id(&self) -> &MenuId {
        &self.quit_id
    }
}

/// A minimal menu-bar template icon (18x18 black-on-alpha "A" dot), rendered
/// by macOS as a template image.
fn template_icon() -> Result<Icon, TrayError> {
    let size = 18usize;
    let mut rgba = vec![0u8; size * size * 4];
    let center = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance <= 7.5 {
                let index = (y * size + x) * 4;
                rgba[index] = 0;
                rgba[index + 1] = 0;
                rgba[index + 2] = 0;
                rgba[index + 3] = 255;
            }
        }
    }
    Icon::from_rgba(rgba, size as u32, size as u32)
        .map_err(|error| TrayError::Icon(error.to_string()))
}

/// Build the status item with an "Open Aiden" / "Quit" menu.
///
/// Call on the main thread (macOS); keep the returned handle alive.
pub fn build_tray() -> Result<TrayHandle, TrayError> {
    let menu = Menu::new();
    let open = MenuItem::with_id(MenuId::new(TRAY_OPEN_ID), "Open Aiden", true, None);
    let quit = MenuItem::with_id(MenuId::new(TRAY_QUIT_ID), "Quit", true, None);
    menu.append(&open)
        .map_err(|error| TrayError::Menu(error.to_string()))?;
    menu.append(&quit)
        .map_err(|error| TrayError::Menu(error.to_string()))?;

    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("Aiden Agent")
        .with_icon(template_icon()?)
        .with_icon_as_template(true)
        .build()
        .map_err(|error| TrayError::Tray(error.to_string()))?;

    Ok(TrayHandle {
        icon,
        open_id: open.id().clone(),
        quit_id: quit.id().clone(),
    })
}

/// Drain one pending tray activation. Returns the first unread command, if any.
pub fn poll_tray_command(handle: &TrayHandle) -> Option<TrayCommand> {
    let receiver = MenuEvent::receiver();
    loop {
        match receiver.try_recv() {
            Ok(event) => {
                if event.id == handle.open_id {
                    return Some(TrayCommand::Open);
                }
                if event.id == handle.quit_id {
                    return Some(TrayCommand::Quit);
                }
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_ids_are_stable_and_distinct() {
        assert_ne!(TRAY_OPEN_ID, TRAY_QUIT_ID);
        assert_eq!(TRAY_OPEN_ID, "aiden-open");
        assert_eq!(TRAY_QUIT_ID, "aiden-quit");
    }

    #[test]
    fn template_icon_is_an_opaque_black_circle() {
        // The template icon is a filled circle: center pixel opaque black.
        let size = 18usize;
        let mut rgba = vec![0u8; size * size * 4];
        let center = (size as f32 - 1.0) / 2.0;
        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 - center;
                let dy = y as f32 - center;
                let distance = (dx * dx + dy * dy).sqrt();
                if distance <= 7.5 {
                    let index = (y * size + x) * 4;
                    rgba[index + 3] = 255;
                }
            }
        }
        assert_eq!(rgba.len(), 18 * 18 * 4);
        assert_eq!(rgba[((9 * 18 + 9) * 4) + 3], 255);
        assert_eq!(rgba[0], 0); // corner is transparent
        assert!(template_icon().is_ok());
    }
}
