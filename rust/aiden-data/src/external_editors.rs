//! Installed editor detection + "open in editor" (port of
//! `main/services/external-editors.ts`).
//!
//! Detection scans `/Applications`, `/System/Applications`, and
//! `~/Applications` for known `.app` bundles (plus Spotlight via `mdfind` for
//! non-standard installs), reads each bundle id with `mdls`, and resolves one
//! canonical editor record per definition (coalescing e.g. the two Antigravity
//! bundles). Launching is argv-only `open -b <bundleId> <folder>` — never a
//! shell.
//!
//! Divergence from the TS: `iconDataUrl` (Electron `nativeImage`) is left
//! empty here — the GPUI shell should render bundle icons itself (NSWorkspace
//! `icon(forFile:)`).

use std::path::{Path, PathBuf};

/// `ExternalEditorDefinition` in external-editors.ts.
#[derive(Debug, Clone)]
pub struct ExternalEditorDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub bundle_ids: &'static [&'static str],
    pub application_names: &'static [&'static str],
    pub priority: u32,
}

/// `EXTERNAL_EDITOR_DEFINITIONS` in external-editors.ts.
pub static EXTERNAL_EDITOR_DEFINITIONS: &[ExternalEditorDefinition] = &[
    def(
        "cursor",
        "Cursor",
        &["com.todesktop.230313mzl4w4u92"],
        &["Cursor"],
        10,
    ),
    def(
        "vscode",
        "VS Code",
        &["com.microsoft.VSCode"],
        &["Visual Studio Code"],
        20,
    ),
    def(
        "vscode-insiders",
        "VS Code Insiders",
        &["com.microsoft.VSCodeInsiders"],
        &["Visual Studio Code - Insiders"],
        21,
    ),
    def("vscodium", "VSCodium", &["com.vscodium"], &["VSCodium"], 22),
    def("zed", "Zed", &["dev.zed.Zed"], &["Zed"], 30),
    def(
        "antigravity",
        "Antigravity",
        &["com.google.antigravity", "com.google.antigravity-ide"],
        &["Antigravity", "Antigravity IDE"],
        40,
    ),
    def("windsurf", "Windsurf", &[], &["Windsurf"], 41),
    def(
        "kiro",
        "Kiro",
        &["dev.kiro.desktop", "com.kiro.app"],
        &["Kiro"],
        42,
    ),
    def("trae", "Trae", &["com.trae.app"], &["Trae"], 43),
    def("xcode", "Xcode", &["com.apple.dt.Xcode"], &["Xcode"], 50),
    def(
        "android-studio",
        "Android Studio",
        &["com.google.android.studio"],
        &["Android Studio"],
        51,
    ),
    def(
        "intellij-idea",
        "IntelliJ IDEA",
        &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
        &["IntelliJ IDEA", "IntelliJ IDEA CE"],
        60,
    ),
    def("aqua", "Aqua", &["com.jetbrains.aqua"], &["Aqua"], 61),
    def("clion", "CLion", &["com.jetbrains.CLion"], &["CLion"], 62),
    def(
        "datagrip",
        "DataGrip",
        &["com.jetbrains.datagrip"],
        &["DataGrip"],
        63,
    ),
    def(
        "dataspell",
        "DataSpell",
        &["com.jetbrains.dataspell"],
        &["DataSpell"],
        64,
    ),
    def(
        "goland",
        "GoLand",
        &["com.jetbrains.goland"],
        &["GoLand"],
        65,
    ),
    def(
        "phpstorm",
        "PhpStorm",
        &["com.jetbrains.PhpStorm"],
        &["PhpStorm"],
        66,
    ),
    def(
        "pycharm",
        "PyCharm",
        &["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
        &["PyCharm", "PyCharm CE"],
        67,
    ),
    def("rider", "Rider", &["com.jetbrains.rider"], &["Rider"], 68),
    def(
        "rubymine",
        "RubyMine",
        &["com.jetbrains.rubymine"],
        &["RubyMine"],
        69,
    ),
    def(
        "rustrover",
        "RustRover",
        &["com.jetbrains.rustrover"],
        &["RustRover"],
        70,
    ),
    def(
        "webstorm",
        "WebStorm",
        &["com.jetbrains.WebStorm"],
        &["WebStorm"],
        71,
    ),
    def(
        "sublime-text",
        "Sublime Text",
        &["com.sublimetext.4", "com.sublimetext.3"],
        &["Sublime Text"],
        80,
    ),
    def("nova", "Nova", &["com.panic.Nova"], &["Nova"], 81),
    def(
        "bbedit",
        "BBEdit",
        &["com.barebones.bbedit"],
        &["BBEdit"],
        82,
    ),
    def(
        "textmate",
        "TextMate",
        &["com.macromates.TextMate"],
        &["TextMate"],
        83,
    ),
    def(
        "opencode",
        "OpenCode",
        &["ai.opencode.desktop"],
        &["OpenCode"],
        90,
    ),
    def(
        "t3-code",
        "T3 Code",
        &["com.t3tools.t3code"],
        &["T3 Code", "T3 Code (Alpha)"],
        91,
    ),
    def(
        "finder",
        "Finder",
        &["com.apple.finder"],
        &["Finder"],
        u32::MAX,
    ),
];

const fn def(
    id: &'static str,
    label: &'static str,
    bundle_ids: &'static [&'static str],
    application_names: &'static [&'static str],
    priority: u32,
) -> ExternalEditorDefinition {
    ExternalEditorDefinition {
        id,
        label,
        bundle_ids,
        application_names,
        priority,
    }
}

/// `ApplicationCandidate` in external-editors.ts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationCandidate {
    pub app_path: String,
    pub bundle_id: Option<String>,
}

/// `ResolvedExternalEditor` in external-editors.ts (icon data left empty).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedExternalEditor {
    pub id: String,
    pub label: String,
    pub app_path: String,
    pub bundle_id: String,
    pub icon_data_url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ExternalEditorsError {
    #[error("Unknown editor: {0}")]
    UnknownEditor(String),
    #[error("Workspace folder is no longer available: {0}")]
    FolderUnavailable(String),
    #[error("Workspace path is not a folder: {0}")]
    NotAFolder(String),
    #[error("{0} is no longer installed.")]
    NotInstalled(String),
    #[error("Could not open workspace in Finder: {0}")]
    FinderOpenFailed(String),
    #[error("Could not open workspace in {0}: {1}")]
    LaunchFailed(String, String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn get_external_editor_definition(
    editor_id: &str,
) -> Option<&'static ExternalEditorDefinition> {
    EXTERNAL_EDITOR_DEFINITIONS
        .iter()
        .find(|definition| definition.id == editor_id)
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn application_name(app_path: &str) -> String {
    Path::new(app_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .strip_suffix(".app")
        .unwrap_or_default()
        .to_string()
}

/// `candidateRank` in external-editors.ts: bundle-id match first, then app
/// name; `None` when the candidate is unknown.
fn candidate_rank(
    definition: &ExternalEditorDefinition,
    candidate: &ApplicationCandidate,
) -> Option<usize> {
    if let Some(bundle_id) = &candidate.bundle_id {
        for (index, expected) in definition.bundle_ids.iter().enumerate() {
            if normalize(expected) == normalize(bundle_id) {
                return Some(index);
            }
        }
    }
    let name = normalize(&application_name(&candidate.app_path));
    for (index, expected) in definition.application_names.iter().enumerate() {
        if normalize(expected) == name {
            return Some(definition.bundle_ids.len() + index);
        }
    }
    None
}

/// `resolveInstalledEditorApplications` in external-editors.ts.
pub fn resolve_installed_editor_applications(
    candidates: &[ApplicationCandidate],
) -> Vec<ResolvedExternalEditor> {
    resolve_installed_editor_applications_with(candidates, EXTERNAL_EDITOR_DEFINITIONS)
}

/// Like [`resolve_installed_editor_applications`] with an explicit definition
/// list (test seam mirroring the TS default parameter).
pub fn resolve_installed_editor_applications_with(
    candidates: &[ApplicationCandidate],
    definitions: &[ExternalEditorDefinition],
) -> Vec<ResolvedExternalEditor> {
    // Dedupe by app path, first occurrence wins (TS `new Map(path → candidate)`).
    let mut unique: Vec<ApplicationCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for candidate in candidates {
        if seen.insert(candidate.app_path.as_str()) {
            unique.push(candidate.clone());
        }
    }

    let mut resolved: Vec<ResolvedExternalEditor> = Vec::new();
    for definition in definitions {
        if definition.id == "finder" {
            continue;
        }
        let mut matches: Vec<(&ApplicationCandidate, usize)> = Vec::new();
        for candidate in &unique {
            if let Some(rank) = candidate_rank(definition, candidate) {
                matches.push((candidate, rank));
            }
        }
        matches.sort_by(|(left_path, left_rank), (right_path, right_rank)| {
            left_rank
                .cmp(right_rank)
                .then_with(|| left_path.app_path.cmp(&right_path.app_path))
        });
        let Some((selected, _)) = matches.first() else {
            continue;
        };
        let Some(bundle_id) = &selected.bundle_id else {
            continue;
        };
        resolved.push(ResolvedExternalEditor {
            id: definition.id.to_string(),
            label: definition.label.to_string(),
            app_path: selected.app_path.clone(),
            bundle_id: bundle_id.clone(),
            icon_data_url: String::new(),
        });
    }
    resolved.sort_by_key(|editor| {
        definitions
            .iter()
            .find(|definition| definition.id == editor.id)
            .map(|definition| definition.priority)
            .unwrap_or(0)
    });
    resolved
}

fn escape_spotlight_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// `buildExternalEditorSpotlightQuery` in external-editors.ts.
pub fn build_external_editor_spotlight_query() -> String {
    build_external_editor_spotlight_query_with(EXTERNAL_EDITOR_DEFINITIONS)
}

/// Like [`build_external_editor_spotlight_query`] with an explicit definition
/// list.
pub fn build_external_editor_spotlight_query_with(
    definitions: &[ExternalEditorDefinition],
) -> String {
    let mut clauses: Vec<String> = Vec::new();
    for definition in definitions {
        if definition.id == "finder" {
            continue;
        }
        for bundle_id in definition.bundle_ids {
            clauses.push(format!(
                "kMDItemCFBundleIdentifier == \"{}\"cd",
                escape_spotlight_value(bundle_id)
            ));
        }
        for name in definition.application_names {
            clauses.push(format!(
                "kMDItemFSName == \"{}.app\"cd",
                escape_spotlight_value(name)
            ));
        }
    }
    format!(
        "kMDItemContentType == \"com.apple.application-bundle\" && ({})",
        clauses.join(" || ")
    )
}

/// `buildOpenApplicationArguments` in external-editors.ts.
pub fn build_open_application_arguments(bundle_id: &str, folder_path: &str) -> Vec<String> {
    vec![
        "-b".to_string(),
        bundle_id.to_string(),
        folder_path.to_string(),
    ]
}

/// `launchApplicationBundle` in external-editors.ts: `open -b <bundleId> <folder>`.
pub fn launch_application_bundle(
    bundle_id: &str,
    folder_path: &str,
) -> Result<(), ExternalEditorsError> {
    let status = std::process::Command::new("/usr/bin/open")
        .args(build_open_application_arguments(bundle_id, folder_path))
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(ExternalEditorsError::LaunchFailed(
            bundle_id.to_string(),
            format!("open exited with {status}"),
        ))
    }
}

/// The discovery seam (TS `locateApplicationCandidates` + `mdls` reads).
pub trait EditorDiscovery: Send + Sync {
    fn locate_candidates(&self) -> Vec<ApplicationCandidate>;
}

/// Default discovery: direct application-root paths (+ `mdfind` + `mdls`
/// reads, both best-effort).
pub struct SystemEditorDiscovery;

impl SystemEditorDiscovery {
    fn run_file(&self, file: &str, args: &[&str]) -> Option<String> {
        let output = std::process::Command::new(file).args(args).output().ok()?;
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            None
        }
    }

    fn is_application_bundle(&self, app_path: &str) -> bool {
        if !app_path.to_lowercase().ends_with(".app") {
            return false;
        }
        Path::new(app_path).is_dir()
    }

    fn read_bundle_identifier(&self, app_path: &str) -> Option<String> {
        let output = self.run_file(
            "/usr/bin/mdls",
            &["-raw", "-name", "kMDItemCFBundleIdentifier", app_path],
        )?;
        let value = output.trim().trim_matches('"');
        if value.is_empty() || value == "(null)" {
            None
        } else {
            Some(value.to_string())
        }
    }
}

impl EditorDiscovery for SystemEditorDiscovery {
    fn locate_candidates(&self) -> Vec<ApplicationCandidate> {
        let definitions: Vec<&ExternalEditorDefinition> = EXTERNAL_EDITOR_DEFINITIONS
            .iter()
            .filter(|definition| definition.id != "finder")
            .collect();
        let mut paths: Vec<String> = Vec::new();
        for definition in &definitions {
            for name in definition.application_names {
                for root in application_roots() {
                    paths.push(root.join(format!("{name}.app")).display().to_string());
                }
            }
        }
        if let Some(output) = self.run_file(
            "/usr/bin/mdfind",
            &[build_external_editor_spotlight_query().as_str()],
        ) {
            for path in output
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                if !paths.contains(&path.to_string()) {
                    paths.push(path.to_string());
                }
            }
        }
        let mut candidates: Vec<ApplicationCandidate> = Vec::new();
        for path in paths {
            if !self.is_application_bundle(&path) {
                continue;
            }
            candidates.push(ApplicationCandidate {
                bundle_id: self.read_bundle_identifier(&path),
                app_path: path,
            });
        }
        candidates
    }
}

fn application_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
}

/// `discoverExternalEditors` in external-editors.ts (icons omitted).
pub fn discover_external_editors(discovery: &dyn EditorDiscovery) -> Vec<ResolvedExternalEditor> {
    let mut resolved = resolve_installed_editor_applications(&discovery.locate_candidates());
    resolved.push(ResolvedExternalEditor {
        id: "finder".to_string(),
        label: "Finder".to_string(),
        app_path: FINDER_APP_PATH.to_string(),
        bundle_id: "com.apple.finder".to_string(),
        icon_data_url: String::new(),
    });
    resolved
}

const FINDER_APP_PATH: &str = "/System/Library/CoreServices/Finder.app";

/// `openFolderInExternalEditor` in external-editors.ts. `open_path` is the
/// Finder case (`shell.openPath` in Electron); here it runs `open <folder>`.
pub fn open_folder_in_external_editor(
    folder_path: &str,
    editor_id: &str,
    editors: &[ResolvedExternalEditor],
) -> Result<(), ExternalEditorsError> {
    let Some(definition) = get_external_editor_definition(editor_id) else {
        return Err(ExternalEditorsError::UnknownEditor(editor_id.to_string()));
    };
    if !Path::new(folder_path).is_dir() {
        if !Path::new(folder_path).exists() {
            return Err(ExternalEditorsError::FolderUnavailable(
                folder_path.to_string(),
            ));
        }
        return Err(ExternalEditorsError::NotAFolder(folder_path.to_string()));
    }
    let Some(editor) = editors.iter().find(|candidate| candidate.id == editor_id) else {
        return Err(ExternalEditorsError::NotInstalled(
            definition.label.to_string(),
        ));
    };
    if editor.id == "finder" {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(folder_path)
            .status()?;
        if !status.success() {
            return Err(ExternalEditorsError::FinderOpenFailed(format!(
                "open exited with {status}"
            )));
        }
        return Ok(());
    }
    launch_application_bundle(&editor.bundle_id, folder_path).map_err(|error| match error {
        ExternalEditorsError::LaunchFailed(_, detail) => {
            ExternalEditorsError::LaunchFailed(editor.label.clone(), detail)
        }
        other => other,
    })
}

/// Convenience: a `HashMap<editor_id, ResolvedExternalEditor>` lookup wrapper
/// mirroring the renderer-facing list shape.
pub fn editor_by_id<'a>(
    editors: &'a [ResolvedExternalEditor],
    editor_id: &str,
) -> Option<&'a ResolvedExternalEditor> {
    editors.iter().find(|editor| editor.id == editor_id)
}

/// A bounded cache mirroring the TS 15 s TTL + in-flight dedup.
pub struct EditorCache {
    inner: parking_lot::Mutex<Option<(std::time::Instant, Vec<ResolvedExternalEditor>)>>,
}

impl Default for EditorCache {
    fn default() -> Self {
        Self::new()
    }
}

impl EditorCache {
    pub fn new() -> Self {
        Self {
            inner: parking_lot::Mutex::new(None),
        }
    }

    /// `resolvedExternalEditors(forceRefresh)` in external-editors.ts.
    pub fn get(
        &self,
        force_refresh: bool,
        discovery: &dyn EditorDiscovery,
    ) -> Vec<ResolvedExternalEditor> {
        let mut cache = self.inner.lock();
        if !force_refresh {
            if let Some((expires_at, value)) = &*cache {
                if expires_at > &std::time::Instant::now() {
                    return value.clone();
                }
            }
        }
        let value = discover_external_editors(discovery);
        *cache = Some((
            std::time::Instant::now() + std::time::Duration::from_secs(15),
            value.clone(),
        ));
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(app_path: &str, bundle_id: Option<&str>) -> ApplicationCandidate {
        ApplicationCandidate {
            app_path: app_path.to_string(),
            bundle_id: bundle_id.map(str::to_string),
        }
    }

    #[test]
    fn filters_unknown_apps_and_coalesces_duplicate_antigravity_bundles() {
        // Mirrors external-editors.test.ts.
        let resolved = resolve_installed_editor_applications(&[
            candidate(
                "/Applications/Antigravity IDE.app",
                Some("com.google.antigravity-ide"),
            ),
            candidate(
                "/Applications/Antigravity.app",
                Some("com.google.antigravity"),
            ),
            candidate(
                "/Applications/Cursor.app",
                Some("com.todesktop.230313mzl4w4u92"),
            ),
            candidate("/Applications/Devin.app", Some("com.exafunction.windsurf")),
            candidate("/Applications/Unknown.app", Some("example.unknown")),
        ]);
        let pairs: Vec<(&str, &str)> = resolved
            .iter()
            .map(|editor| (editor.id.as_str(), editor.app_path.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("cursor", "/Applications/Cursor.app"),
                ("antigravity", "/Applications/Antigravity.app"),
            ]
        );
    }

    #[test]
    fn prioritizes_bundle_id_over_app_name_for_known_bundles() {
        // Two bundles both claim the Cursor definition; the bundle-id match
        // ranks above the app-name match.
        let resolved = resolve_installed_editor_applications(&[
            candidate("/Applications/Cursor.app", None),
            candidate(
                "/Applications/Special.app",
                Some("com.todesktop.230313mzl4w4u92"),
            ),
        ]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].app_path, "/Applications/Special.app");
    }

    #[test]
    fn builds_a_spotlight_query_with_escaped_bundle_ids() {
        let query = build_external_editor_spotlight_query();
        assert!(query.starts_with("kMDItemContentType == \"com.apple.application-bundle\" && ("));
        assert!(query.contains("kMDItemCFBundleIdentifier == \"com.microsoft.VSCode\"cd"));
        assert!(query.contains("kMDItemFSName == \"Visual Studio Code.app\"cd"));
        assert!(!query.contains("kMDItemFSName == \"Finder.app\"cd"));
    }

    #[test]
    fn launches_with_fixed_open_arguments_and_never_interprets_shell_syntax() {
        let folder_path = "/tmp/workspace; touch should-not-exist";
        assert_eq!(
            build_open_application_arguments("com.todesktop.230313mzl4w4u92", folder_path),
            vec!["-b", "com.todesktop.230313mzl4w4u92", folder_path]
        );
    }

    #[test]
    fn open_folder_rejects_unknown_editors_missing_folders_and_disappeared_editors() {
        assert!(matches!(
            open_folder_in_external_editor("/tmp/workspace", "not-a-real-editor", &[]),
            Err(ExternalEditorsError::UnknownEditor(_))
        ));
        assert!(matches!(
            open_folder_in_external_editor("/missing/workspace", "cursor", &[]),
            Err(ExternalEditorsError::FolderUnavailable(_))
        ));
        let not_dir = tempfile::tempdir().unwrap();
        let file_path = not_dir.path().join("file.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert!(matches!(
            open_folder_in_external_editor(file_path.to_str().unwrap(), "cursor", &[]),
            Err(ExternalEditorsError::NotAFolder(_))
        ));
        // A real folder but no matching editor → "no longer installed".
        assert!(matches!(
            open_folder_in_external_editor(not_dir.path().to_str().unwrap(), "cursor", &[]),
            Err(ExternalEditorsError::NotInstalled(_))
        ));
    }

    #[test]
    fn resolves_finder_last_with_max_priority() {
        let resolved = resolve_installed_editor_applications(&[candidate(
            "/Applications/Cursor.app",
            Some("com.todesktop.230313mzl4w4u92"),
        )]);
        let definitions = get_external_editor_definition("finder").unwrap();
        assert_eq!(definitions.priority, u32::MAX);
        assert_eq!(resolved.len(), 1);
    }

    struct FakeDiscovery;

    impl EditorDiscovery for FakeDiscovery {
        fn locate_candidates(&self) -> Vec<ApplicationCandidate> {
            vec![candidate(
                "/Applications/Cursor.app",
                Some("com.todesktop.230313mzl4w4u92"),
            )]
        }
    }

    #[test]
    fn discovery_appends_finder_and_editor_cache_respects_force_refresh() {
        let editors = discover_external_editors(&FakeDiscovery);
        let ids: Vec<&str> = editors.iter().map(|editor| editor.id.as_str()).collect();
        assert_eq!(ids, vec!["cursor", "finder"]);

        let cache = EditorCache::new();
        let first = cache.get(false, &FakeDiscovery);
        assert_eq!(first.len(), 2);
        // A second call within the TTL reuses the cache.
        let second = cache.get(false, &FakeDiscovery);
        assert_eq!(second.len(), 2);
        let refreshed = cache.get(true, &FakeDiscovery);
        assert_eq!(refreshed.len(), 2);
    }
}
