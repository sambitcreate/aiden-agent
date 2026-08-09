//! Workspace file browsing — list files in a workspace directory.
//!
//! Port of `main/services/workspace-files.ts`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 200;
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".build",
    "DerivedData",
    ".swiftpm",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified: u64,
    pub is_dir: bool,
}

#[derive(Debug)]
pub struct WorkspaceFilesError(pub String);

impl std::fmt::Display for WorkspaceFilesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for WorkspaceFilesError {}

/// List files in a workspace directory, sorted by modification time (most
/// recent first), limited to 200 entries. Skips `.git`, `node_modules`,
/// `target`, etc.
pub fn list_workspace_files(
    root: &Path,
    filter: Option<&str>,
) -> Result<Vec<WorkspaceFile>, WorkspaceFilesError> {
    if !root.is_dir() {
        return Err(WorkspaceFilesError(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    files.truncate(MAX_ENTRIES);

    if let Some(pattern) = filter {
        let p = pattern.trim_start_matches('*');
        files.retain(|f| f.name.ends_with(p));
    }
    Ok(files)
}

fn collect_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<WorkspaceFile>,
) -> Result<(), WorkspaceFilesError> {
    if out.len() >= MAX_ENTRIES {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_ENTRIES {
            return Ok(());
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name == ".DS_Store" || name.starts_with('.') && name.len() == 1 {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(WorkspaceFile {
                name,
                path: path.strip_prefix(root).unwrap_or(&path).to_path_buf(),
                size: 0,
                modified,
                is_dir: true,
            });
            collect_files(root, &path, out)?;
        } else if meta.is_file() && meta.len() <= MAX_FILE_SIZE {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(WorkspaceFile {
                name,
                path: path.strip_prefix(root).unwrap_or(&path).to_path_buf(),
                size: meta.len(),
                modified,
                is_dir: false,
            });
        }
    }
    Ok(())
}

/// Human-readable file size.
pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_size_labels() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(2048), "2.0 KB");
        assert_eq!(format_size(1_048_576), "1.0 MB");
    }

    #[test]
    fn skips_hidden_and_skip_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("visible.txt"), "hi").unwrap();
        std::fs::write(dir.path().join(".DS_Store"), "x").unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "x").unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/pkg.js"), "x").unwrap();

        let files = list_workspace_files(dir.path(), None).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"visible.txt"));
        assert!(!names.contains(&".DS_Store"));
        assert!(!names.contains(&"config"));
        assert!(!names.contains(&"pkg.js"));
    }

    #[test]
    fn glob_filter_retains_matching_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "x").unwrap();
        std::fs::write(dir.path().join("b.ts"), "x").unwrap();
        std::fs::write(dir.path().join("c.rs"), "x").unwrap();

        let files = list_workspace_files(dir.path(), Some("*.rs")).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.name.ends_with(".rs")));
    }
}
