//! Portable config-dir resolution (port of `main/services/aiden-config-dir.ts`).
//!
//! Aiden's portable user config directory is `~/.aiden`, overridable with the
//! `AIDEN_CONFIG_DIR` environment variable. This folder belongs to the user and
//! is meant to be edited by hand: it holds `config.json` (portable providers,
//! MCP servers, and skills) alongside the `skill/`, `skills/`, and `scripts/`
//! roots. Machine-local state — secrets, discovery caches, chats, and UI
//! preferences — stays in the machine-local data directory (see
//! [`crate::machine_local_data_dir`]).
//!
//! The resolution rules match the TypeScript source exactly:
//!
//! - An absolute `AIDEN_CONFIG_DIR` wins and is lexically normalized
//!   (trailing separators and `.`/`..` segments dropped) so `/x` and `/x/`
//!   can never fork the path.
//! - Surrounding whitespace does not defeat the override.
//! - An empty or whitespace-only override falls back to `~/.aiden`.
//! - A *relative* override is rejected rather than resolved against the
//!   working directory — a packaged app's cwd is not predictable, so silently
//!   accepting one would scatter config folders.

use std::path::{Component, Path, PathBuf};

use thiserror::Error;

/// Redirects the portable config root. Used by tests and sandboxed dev runs.
pub const AIDEN_CONFIG_DIR_ENV: &str = "AIDEN_CONFIG_DIR";

/// Basename of the portable root inside a home or workspace directory.
pub const AIDEN_DIR_NAME: &str = ".aiden";

#[derive(Debug, Error)]
pub enum ConfigDirError {
    #[error("{AIDEN_CONFIG_DIR_ENV} must be an absolute path; received {0:?}.")]
    RelativeOverride(String),
}

/// The portable config root: `$AIDEN_CONFIG_DIR`, else `~/.aiden`.
///
/// A relative override is rejected (a TS `throw`), mirroring
/// `aidenConfigDir()` in aiden-config-dir.ts.
pub fn aiden_config_dir() -> Result<PathBuf, ConfigDirError> {
    let raw = std::env::var(AIDEN_CONFIG_DIR_ENV);
    let override_value = match raw {
        Ok(value) => value.trim().to_string(),
        Err(_) => return Ok(home_dir().join(AIDEN_DIR_NAME)),
    };
    if override_value.is_empty() {
        return Ok(home_dir().join(AIDEN_DIR_NAME));
    }
    let path = PathBuf::from(&override_value);
    if !path.is_absolute() {
        return Err(ConfigDirError::RelativeOverride(override_value));
    }
    // `path.resolve()` in Node drops a trailing separator and collapses `.` /
    // `..` segments lexically; mirror that so `/x` and `/x/` compare equal.
    Ok(normalize_absolute_path(&path))
}

/// Lexically normalize an absolute path: drop trailing separators and resolve
/// `.` / `..` segments without touching the filesystem.
fn normalize_absolute_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only collapse a parent segment when a plain directory
                // precedes it; leading `..` on an absolute path is a no-op.
                let popped = normalized.pop();
                if !popped {
                    normalized.push(Component::ParentDir.as_os_str());
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// The user's home directory (`$HOME` on Unix).
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_home_aiden_when_no_override_is_set() {
        std::env::remove_var(AIDEN_CONFIG_DIR_ENV);
        assert_eq!(aiden_config_dir().unwrap(), home_dir().join(AIDEN_DIR_NAME));
    }

    #[test]
    fn an_absolute_override_replaces_the_default_root() {
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "/srv/aiden-config");
        assert_eq!(
            aiden_config_dir().unwrap(),
            PathBuf::from("/srv/aiden-config")
        );
    }

    #[test]
    fn an_override_is_normalized_so_a_trailing_slash_cannot_fork_the_path() {
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "/srv/aiden-config/");
        assert_eq!(
            aiden_config_dir().unwrap(),
            PathBuf::from("/srv/aiden-config")
        );
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "/srv/aiden-config/nested/..");
        assert_eq!(
            aiden_config_dir().unwrap(),
            PathBuf::from("/srv/aiden-config")
        );
    }

    #[test]
    fn surrounding_whitespace_does_not_defeat_the_override() {
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "  /srv/aiden-config  ");
        assert_eq!(
            aiden_config_dir().unwrap(),
            PathBuf::from("/srv/aiden-config")
        );
    }

    #[test]
    fn an_empty_or_whitespace_only_override_falls_back_to_the_default() {
        let expected = home_dir().join(AIDEN_DIR_NAME);
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "");
        assert_eq!(aiden_config_dir().unwrap(), expected);
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "   ");
        assert_eq!(aiden_config_dir().unwrap(), expected);
    }

    #[test]
    fn a_relative_override_is_rejected_instead_of_resolved_against_cwd() {
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "relative/aiden");
        let err = aiden_config_dir().unwrap_err();
        assert!(err.to_string().contains("must be an absolute path"));
        std::env::set_var(AIDEN_CONFIG_DIR_ENV, "./aiden");
        assert!(aiden_config_dir().is_err());
    }

    #[test]
    fn normalize_drops_trailing_separators() {
        assert_eq!(
            normalize_absolute_path(Path::new("/a/b/")),
            PathBuf::from("/a/b")
        );
        assert_eq!(
            normalize_absolute_path(Path::new("/a/b/./c/..")),
            PathBuf::from("/a/b")
        );
    }
}
