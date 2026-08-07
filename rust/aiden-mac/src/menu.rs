//! Port of the `native-menu-command-contract` ownership rule: the commands the
//! native application menu owns (catalog `nativeMenu: true`) must be exactly
//! the commands the app menu wires with accelerators, so a renderer-scoped
//! binding can never shadow a menu accelerator.
//!
//! The Electron source is a test that greps `main/index.ts`; in the Rust port
//! the menu is built by the GPUI app, so the contract is a fixed allowlist plus
//! an assertion that every id is a known catalog command.

use aiden_core::keybindings::{is_command_id, CommandId};

/// The catalog commands owned by the native menu (`nativeMenu: true` in
/// `renderer/shared/keybindings.ts`).
pub const NATIVE_MENU_COMMAND_IDS: &[CommandId] = &[
    CommandId::ChatNew,
    CommandId::SettingsOpen,
    CommandId::WorkspaceOpenPreferredEditor,
];

/// The accelerators the app menu registers for the owned commands.
pub const NATIVE_MENU_ACCELERATORS: &[(&str, &str)] = &[
    ("chat.new", "Command+N"),
    ("settings.open", "Command+,"),
    ("workspace.openPreferredEditor", "Command+O"),
];

/// Validate the contract: every native-menu command is a known catalog id, and
/// the accelerator list covers exactly the owned commands.
pub fn validate_native_menu_contract() -> Result<(), String> {
    for id in NATIVE_MENU_COMMAND_IDS {
        if !is_command_id(id.as_str()) {
            return Err(format!("Unknown native-menu command id {:?}.", id.as_str()));
        }
    }
    let owned: std::collections::BTreeSet<&str> = NATIVE_MENU_COMMAND_IDS
        .iter()
        .map(|id| id.as_str())
        .collect();
    let wired: std::collections::BTreeSet<&str> =
        NATIVE_MENU_ACCELERATORS.iter().map(|(id, _)| *id).collect();
    if owned != wired {
        return Err(format!(
            "Native-menu command ids ({owned:?}) do not match the wired accelerators ({wired:?})."
        ));
    }
    for (id, accelerator) in NATIVE_MENU_ACCELERATORS {
        if aiden_core::keybindings::normalize_accelerator(accelerator).is_none() {
            return Err(format!(
                "Invalid native-menu accelerator \"{accelerator}\" for {id}."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_menu_contract_holds() {
        validate_native_menu_contract().expect("native-menu contract must hold");
        assert_eq!(
            NATIVE_MENU_COMMAND_IDS
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>(),
            vec!["chat.new", "settings.open", "workspace.openPreferredEditor"]
        );
    }
}
