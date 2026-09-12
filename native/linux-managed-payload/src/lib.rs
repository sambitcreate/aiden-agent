//! Local operator-approved staging only. No release authentication, execution,
//! activation, kernel immutability, or Computer Use admission is implemented.
pub mod inventory;
#[cfg(target_os = "linux")]
pub mod stage;
#[cfg(target_os = "linux")]
mod trusted_path;
