//! On-device Parakeet model catalog + download manager — port of
//! `main/services/local-models.ts`.
//!
//! Models are sherpa-onnx NVIDIA Parakeet TDT bundles from k2-fsa's GitHub
//! releases (tar.bz2 archives of encoder/decoder/joiner ONNX + tokens.txt).
//! Each model is extracted into its own directory under the machine-local
//! data dir (`app.getPath("userData")/parakeet-models`) so it persists and
//! can be managed/deleted.
//!
//! Downloads are explicit-user-action-only: [`download_model`] is the only
//! function that touches the network, and nothing calls it automatically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

/// Base URL for the `asr-models` GitHub release assets.
pub const RELEASE_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
/// The file every extracted model must contain to count as installed.
pub const REQUIRED_FILE: &str = "encoder.int8.onnx";
/// Environment override for the models root (tests).
pub const MODELS_ROOT_ENV: &str = "AIDEN_PARAKET_MODELS_DIR";

/// One catalog entry (`CatalogModel`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub size_label: &'static str,
    pub quant: &'static str,
    pub languages_label: &'static str,
    pub accuracy: f32,
    pub speed: f32,
    pub recommended: bool,
}

/// A catalog entry plus the installed flag (`LocalModel`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: &'static str,
    pub description: &'static str,
    pub size_label: &'static str,
    pub quant: &'static str,
    pub languages_label: &'static str,
    pub accuracy: f32,
    pub speed: f32,
    pub recommended: bool,
    pub installed: bool,
}

/// The download progress broadcast the TS emitted on `localModels:progress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadPhase {
    Download,
    Extract,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: &'static str,
    pub downloaded: u64,
    pub total: u64,
    pub percentage: u8,
    pub phase: DownloadPhase,
}

/// The catalog, byte-for-byte the TS `CATALOG`.
pub const CATALOG: [CatalogModel; 2] = [
    CatalogModel {
        id: "parakeet-v3",
        name: "Parakeet TDT 0.6B v3",
        description: "Fast and accurate. Supports 25 European languages.",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/",
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
        ),
        size_label: "620 MB",
        quant: "int8",
        languages_label: "25 languages",
        accuracy: 0.8,
        speed: 0.85,
        recommended: true,
    },
    CatalogModel {
        id: "parakeet-v2",
        name: "Parakeet TDT 0.6B v2",
        description: "English only — the most accurate model for English.",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/",
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
        ),
        size_label: "620 MB",
        quant: "int8",
        languages_label: "English only",
        accuracy: 0.85,
        speed: 0.85,
        recommended: false,
    },
];

/// Root directory holding one folder per model. The env override exists so
/// tests can point the catalog at a temp dir.
pub fn models_root() -> PathBuf {
    if let Some(override_dir) = std::env::var_os(MODELS_ROOT_ENV) {
        return PathBuf::from(override_dir);
    }
    let root = aiden_data::machine_local_data_dir();
    root.join("parakeet-models")
}

fn catalog_entry(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|entry| entry.id == id)
}

/// Absolute directory for a model's extracted files, or `None` for an unknown
/// id (`modelDir`).
pub fn model_dir(id: &str) -> Option<PathBuf> {
    catalog_entry(id).map(|_| models_root().join(id))
}

/// Whether the model's files are present (`isModelInstalled`).
pub fn is_model_installed(id: &str) -> bool {
    let Some(dir) = model_dir(id) else {
        return false;
    };
    dir.join(REQUIRED_FILE).is_file()
}

/// The installed-flag-augmented catalog (`listModels`).
pub fn list_models() -> Vec<LocalModel> {
    CATALOG
        .iter()
        .map(|entry| LocalModel {
            id: entry.id.to_string(),
            name: entry.name,
            description: entry.description,
            size_label: entry.size_label,
            quant: entry.quant,
            languages_label: entry.languages_label,
            accuracy: entry.accuracy,
            speed: entry.speed,
            recommended: entry.recommended,
            installed: is_model_installed(entry.id),
        })
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("Unknown model \"{0}\".")]
    UnknownModel(String),
    #[error("This model is already downloading.")]
    AlreadyDownloading,
    #[error("Download failed: {0}")]
    Download(String),
    #[error("Extracted model is missing expected files.")]
    MissingFiles,
    #[error("Download cancelled.")]
    Cancelled,
    #[error("Model extraction requires macOS (the Electron path used /usr/bin/tar).")]
    UnsupportedPlatform,
    #[error("I/O error: {0}")]
    Io(std::io::Error),
}

/// Registry of in-flight downloads so they can be cancelled by id. The slot
/// holds the spawned task's abort handle (`None` while reserving the slot).
static DOWNLOADS: Mutex<Option<HashMap<String, Option<tokio::task::AbortHandle>>>> =
    Mutex::new(None);

fn downloads() -> &'static Mutex<Option<HashMap<String, Option<tokio::task::AbortHandle>>>> {
    &DOWNLOADS
}

/// The TS progress math: downloads occupy 0–90%, extraction 90–100%.
pub fn progress_percentage(downloaded: u64, total: u64, phase: DownloadPhase) -> u8 {
    match phase {
        DownloadPhase::Download => {
            if total > 0 {
                ((downloaded as f64 / total as f64) * 90.0).round() as u8
            } else {
                0
            }
        }
        DownloadPhase::Extract => {
            90 + ((downloaded as f64 / total.max(1) as f64) * 10.0).round() as u8
        }
    }
}

/// Cancel an in-flight download. Returns false when nothing was downloading.
pub fn cancel_download(id: &str) -> bool {
    let mut guard = downloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slots = guard.get_or_insert_with(HashMap::new);
    if let Some(Some(handle)) = slots.remove(id) {
        handle.abort();
        true
    } else {
        slots.remove(id);
        false
    }
}

/// Download a model's tar.bz2 and extract it into its model directory.
/// Streams `on_progress` (0–90% download, 90–100% extraction) at most every
/// ~200 ms, mirroring `downloadModel`.
pub async fn download_model(
    id: &str,
    on_progress: Option<Arc<dyn Fn(DownloadProgress) + Send + Sync>>,
) -> Result<(), ModelError> {
    let entry = catalog_entry(id).ok_or_else(|| ModelError::UnknownModel(id.to_string()))?;
    let task_id = id.to_string();
    {
        let mut guard = downloads()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slots = guard.get_or_insert_with(HashMap::new);
        if slots.contains_key(id) {
            return Err(ModelError::AlreadyDownloading);
        }
        // Reserve the slot now; the spawned task fills in its abort handle.
        slots.insert(id.to_string(), None);
    }

    let handle = tokio::spawn(download_model_task(entry, on_progress));
    if let Ok(mut guard) = downloads().lock() {
        if let Some(slots) = guard.as_mut() {
            if let Some(slot) = slots.get_mut(&task_id) {
                *slot = Some(handle.abort_handle());
            }
        }
    }

    match handle.await {
        Ok(result) => result,
        Err(_join_error) => {
            // The task panicked or was aborted; treat as cancelled.
            cancel_download(&task_id);
            Err(ModelError::Cancelled)
        }
    }
}

async fn download_model_task(
    entry: &'static CatalogModel,
    on_progress: Option<Arc<dyn Fn(DownloadProgress) + Send + Sync>>,
) -> Result<(), ModelError> {
    let id = entry.id;
    let dir = models_root().join(id);
    let tmp_tar = std::env::temp_dir().join(format!(
        "nh-parakeet-{id}-{}.tar.bz2",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    ));

    let emit = |downloaded: u64, total: u64, phase: DownloadPhase| {
        if let Some(on_progress) = on_progress.as_ref() {
            on_progress(DownloadProgress {
                id,
                downloaded,
                total,
                percentage: progress_percentage(downloaded, total, phase),
                phase,
            });
        }
    };

    let download_result = async {
        let url: &'static str = entry.url;
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| ModelError::Download(format!("{error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(ModelError::Download(format!(
                "{status} {}",
                status.canonical_reason().unwrap_or("")
            )));
        }
        let total = response.content_length().unwrap_or(0);
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&tmp_tar)
            .await
            .map_err(ModelError::Io)?;
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_millis(201);
        while let Some(chunk) = stream
            .next()
            .await
            .transpose()
            .map_err(|error| ModelError::Download(format!("{error}")))?
        {
            file.write_all(&chunk).await.map_err(ModelError::Io)?;
            downloaded += chunk.len() as u64;
            if last_emit.elapsed() > std::time::Duration::from_millis(200) {
                last_emit = std::time::Instant::now();
                emit(downloaded, total, DownloadPhase::Download);
            }
        }
        file.flush().await.map_err(ModelError::Io)?;
        Ok::<_, ModelError>(())
    }
    .await;

    // Fresh extract dir, then tar -xjf --strip-components=1 (the TS path).
    let extract_result = match download_result {
        Ok(()) => extract_and_verify(entry, &dir, &tmp_tar, &emit),
        Err(error) => Err(error),
    };

    // Cleanup: remove the extract dir on failure, the tarball always.
    if extract_result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let _ = std::fs::remove_file(&tmp_tar);
    let mut registry = downloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(slots) = registry.as_mut() {
        slots.remove(id);
    }
    drop(registry);
    extract_result
}

/// Extract the downloaded archive into a fresh model dir and verify it. The
/// `emit` callback reports the extraction phase (90–100%).
fn extract_and_verify(
    entry: &CatalogModel,
    dir: &Path,
    tmp_tar: &Path,
    emit: &dyn Fn(u64, u64, DownloadPhase),
) -> Result<(), ModelError> {
    let id = entry.id;
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(ModelError::Io)?;
    emit(0, 1, DownloadPhase::Extract);
    extract_tarball(tmp_tar, dir)?;
    if !is_model_installed(id) {
        return Err(ModelError::MissingFiles);
    }
    emit(1, 1, DownloadPhase::Extract);
    tracing::info!("local-models: Installed Parakeet model \"{id}\"");
    Ok(())
}

/// Extract a `.tar.bz2` archive with the top folder stripped — the exact
/// `/usr/bin/tar -xjf <file> -C <dir> --strip-components=1` the Electron app
/// ran (macOS tar = libarchive handles bz2). Non-macOS fails cleanly.
fn extract_tarball(archive: &Path, dest: &Path) -> Result<(), ModelError> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/tar")
            .arg("-xjf")
            .arg(archive)
            .arg("-C")
            .arg(dest)
            .arg("--strip-components=1")
            .output()
            .map_err(ModelError::Io)?;
        if !output.status.success() {
            return Err(ModelError::Download(format!(
                "tar exited {}: {}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (archive, dest);
        Err(ModelError::UnsupportedPlatform)
    }
}

/// Delete a model's directory (`deleteModel` — `rm(..., force: true)`, so a
/// missing directory is a success).
pub async fn delete_model(id: &str) -> Result<(), ModelError> {
    let dir = model_dir(id).ok_or_else(|| ModelError::UnknownModel(id.to_string()))?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ModelError::Io(error)),
    }
}

/// Serializes tests that read/write `MODELS_ROOT_ENV` (the env var is
/// process-global, so parallel tests would clobber each other). sherpa's
/// model-installed tests take the same lock.
#[cfg(test)]
pub(crate) static MODELS_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn with_env_models_root<T>(dir: &std::path::Path, run: impl FnOnce() -> T) -> T {
        std::env::set_var(MODELS_ROOT_ENV, dir);
        let result = run();
        std::env::remove_var(MODELS_ROOT_ENV);
        result
    }

    #[test]
    fn catalog_has_the_two_recommended_models() {
        assert_eq!(CATALOG.len(), 2);
        assert_eq!(CATALOG[0].id, "parakeet-v3");
        assert!(CATALOG[0].recommended);
        assert_eq!(CATALOG[1].id, "parakeet-v2");
        assert!(!CATALOG[1].recommended);
        for entry in &CATALOG {
            assert!(entry.url.starts_with(RELEASE_BASE));
            assert!(entry.url.ends_with(".tar.bz2"));
        }
    }

    #[test]
    fn unknown_models_have_no_dir() {
        assert_eq!(model_dir("nope"), None);
        assert!(!is_model_installed("nope"));
    }

    #[tokio::test]
    async fn model_dir_resolution_and_install_check_use_the_models_root() {
        let _guard = MODELS_ENV_LOCK.lock().await;
        let temp = tempfile::tempdir().unwrap();
        with_env_models_root(temp.path(), || {
            assert!(!is_model_installed("parakeet-v3"));
            let dir = model_dir("parakeet-v3").unwrap();
            assert_eq!(dir, temp.path().join("parakeet-v3"));

            // A bare file counts as installed (the TS REQUIRED_FILE check).
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(REQUIRED_FILE), b"x").unwrap();
            assert!(is_model_installed("parakeet-v3"));

            let listed = list_models();
            let v3 = listed
                .iter()
                .find(|model| model.id == "parakeet-v3")
                .unwrap();
            assert!(v3.installed);
            let v2 = listed
                .iter()
                .find(|model| model.id == "parakeet-v2")
                .unwrap();
            assert!(!v2.installed);
            assert_eq!(v3.size_label, "620 MB");
            assert_eq!(v3.accuracy, 0.8);
            assert_eq!(v3.speed, 0.85);
        });
    }

    #[test]
    fn progress_percentage_matches_the_ts_math() {
        // Downloads occupy 0-90%.
        assert_eq!(progress_percentage(0, 1000, DownloadPhase::Download), 0);
        assert_eq!(progress_percentage(500, 1000, DownloadPhase::Download), 45);
        assert_eq!(progress_percentage(1000, 1000, DownloadPhase::Download), 90);
        // Unknown totals report 0 (TS `total ? ... : 0`).
        assert_eq!(progress_percentage(50, 0, DownloadPhase::Download), 0);
        // Extraction occupies 90-100%.
        assert_eq!(progress_percentage(0, 1, DownloadPhase::Extract), 90);
        assert_eq!(progress_percentage(1, 1, DownloadPhase::Extract), 100);
    }

    #[tokio::test]
    async fn delete_model_removes_the_directory() {
        let _guard = MODELS_ENV_LOCK.lock().await;
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var(MODELS_ROOT_ENV, temp.path());

        let dir = model_dir("parakeet-v2").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(REQUIRED_FILE), b"x").unwrap();
        assert!(is_model_installed("parakeet-v2"));
        delete_model("parakeet-v2").await.unwrap();
        assert!(!is_model_installed("parakeet-v2"));
        // force:true semantics — deleting a missing dir is a success.
        delete_model("parakeet-v2").await.unwrap();

        std::env::remove_var(MODELS_ROOT_ENV);
    }

    #[tokio::test]
    async fn deleting_an_unknown_model_errors() {
        assert!(matches!(
            delete_model("nope").await,
            Err(ModelError::UnknownModel(_))
        ));
    }
}
