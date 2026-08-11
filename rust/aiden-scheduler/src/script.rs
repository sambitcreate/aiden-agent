//! Port of `main/services/schedule-script.ts` — script-mode scheduled tasks.
//!
//! Scripts live in `<workspace>/.aiden/scripts/` (workspace first) and
//! `~/.aiden/scripts/` (global), resolved with realpath confinement so a
//! symlink escape is rejected. Execution spawns the matching interpreter with a
//! 60s timeout, a 1 MiB combined output cap (terminating on overflow), and a
//! detached process group that is signaled as a group (SIGTERM, then SIGKILL
//! after a 1s grace) so grandchildren cannot outlive the run.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aiden_data::config_dir::AIDEN_DIR_NAME;
use aiden_data::schedule_store::validate_script_name;
use tokio_util::sync::CancellationToken;

/// `SCRIPT_TIMEOUT_MS`
pub const SCRIPT_TIMEOUT_MS: u64 = 60_000;
/// `SCRIPT_OUTPUT_LIMIT`
pub const SCRIPT_OUTPUT_LIMIT: usize = 1024 * 1024;
/// Grace period between SIGTERM and SIGKILL when terminating a script.
const KILL_GRACE: Duration = Duration::from_millis(1_000);

#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    #[error("Script \"{0}\" was not found in {1}.")]
    NotFound(String, String),
    #[error("Script \"{0}\" resolves outside {1}.")]
    OutsideRoot(String, String),
    #[error("Script \"{0}\" is not a regular file.")]
    NotRegularFile(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Schedule(#[from] aiden_data::schedule_store::ScheduleError),
}

/// Result of one script subprocess (`ScriptProcessResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub output_limit_exceeded: bool,
    pub cancelled: bool,
}

/// `scriptRoots` — workspace first, then global. An explicitly injected home
/// wins over `AIDEN_CONFIG_DIR` so tests stay hermetic.
pub fn script_roots(workspace_root: Option<&Path>, home_directory: Option<&Path>) -> Vec<PathBuf> {
    let global_root = match home_directory {
        Some(home) => home.join(AIDEN_DIR_NAME),
        None => {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(home).join(AIDEN_DIR_NAME)
        }
    };
    let mut roots = Vec::new();
    if let Some(workspace_root) = workspace_root {
        roots.push(workspace_root.join(AIDEN_DIR_NAME).join("scripts"));
    }
    roots.push(global_root.join("scripts"));
    roots
}

/// `pathInside` — candidate must be equal to or strictly inside root.
fn path_inside(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    relative.as_os_str().is_empty()
        || !relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

/// `existingScriptInRoot` — realpath both sides, enforce containment, require
/// a regular file. Missing roots/files return `Ok(None)`; anything else
/// (escaping symlink, non-regular file) is an error.
async fn existing_script_in_root(
    root: &Path,
    script: &str,
) -> Result<Option<PathBuf>, ScriptError> {
    let real_root = match tokio::fs::canonicalize(root).await {
        Ok(real) => real,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let candidate = root.join(script);
    let real_candidate = match tokio::fs::canonicalize(&candidate).await {
        Ok(real) => real,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !path_inside(&real_root, &real_candidate) {
        return Err(ScriptError::OutsideRoot(
            script.to_string(),
            root.display().to_string(),
        ));
    }
    let metadata = tokio::fs::metadata(&real_candidate).await?;
    if !metadata.is_file() {
        return Err(ScriptError::NotRegularFile(script.to_string()));
    }
    Ok(Some(real_candidate))
}

/// `resolveScheduledScript` — first root containing the script wins.
pub async fn resolve_scheduled_script(
    script: &str,
    workspace_root: Option<&Path>,
    home_directory: Option<&Path>,
) -> Result<PathBuf, ScriptError> {
    let script = validate_script_name(script)?;
    let roots = script_roots(workspace_root, home_directory);
    for root in &roots {
        if let Some(resolved) = existing_script_in_root(root, &script).await? {
            return Ok(resolved);
        }
    }
    let candidates = roots
        .iter()
        .map(|root| root.join(&script).display().to_string())
        .collect::<Vec<_>>()
        .join(" or ");
    Err(ScriptError::NotFound(script, candidates))
}

/// `listScheduledScripts` — deduplicated names across roots, sorted; entries
/// that resolve to escapes or non-files are hidden, never surfaced.
pub async fn list_scheduled_scripts(
    workspace_root: Option<&Path>,
    home_directory: Option<&Path>,
) -> Result<Vec<String>, ScriptError> {
    let roots = script_roots(workspace_root, home_directory);
    let mut names: Vec<String> = Vec::new();
    for root in &roots {
        let mut entries = match tokio::fs::read_dir(root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if names.contains(&name) {
                continue;
            }
            if matches!(existing_script_in_root(root, &name).await, Ok(Some(_))) {
                names.push(name);
            }
        }
    }
    names.sort();
    Ok(names)
}

/// `scriptCommand` — interpreter by extension; unknown extensions execute
/// directly (relying on the shebang).
pub fn script_command(script_path: &Path) -> (String, Vec<String>) {
    match script_path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("sh" | "bash") => (
            "/bin/bash".to_string(),
            vec![script_path.display().to_string()],
        ),
        Some("js" | "mjs" | "cjs") => ("node".to_string(), vec![script_path.display().to_string()]),
        Some("py") => (
            "python3".to_string(),
            vec![script_path.display().to_string()],
        ),
        _ => (script_path.display().to_string(), Vec::new()),
    }
}

/// `runScheduledScript` — bounded subprocess execution.
pub async fn run_scheduled_script(
    script_path: &Path,
    cwd: &Path,
    timeout_ms: Option<u64>,
    output_limit: Option<usize>,
) -> Result<ScriptProcessResult, ScriptError> {
    run_scheduled_script_with_cancel(
        script_path,
        cwd,
        timeout_ms,
        output_limit,
        CancellationToken::new(),
    )
    .await
}

/// Cancellation-aware production entry point. Cancellation terminates the
/// whole detached process group, so descendants cannot outlive the task.
pub async fn run_scheduled_script_with_cancel(
    script_path: &Path,
    cwd: &Path,
    timeout_ms: Option<u64>,
    output_limit: Option<usize>,
    cancellation: CancellationToken,
) -> Result<ScriptProcessResult, ScriptError> {
    let timeout_ms = timeout_ms.unwrap_or(SCRIPT_TIMEOUT_MS);
    let output_limit = output_limit.unwrap_or(SCRIPT_OUTPUT_LIMIT);
    let (command, args) = script_command(script_path);

    let mut command_builder = tokio::process::Command::new(&command);
    command_builder
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(std::env::vars())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command_builder.process_group(0);
    }

    let mut child = command_builder.spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let shared: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let overflow = CancellationToken::new();
    let stdout_task = tokio::spawn(capture_stream(
        stdout,
        shared.clone(),
        output_limit,
        overflow.clone(),
    ));
    let stderr_task = tokio::spawn(capture_stream(
        stderr,
        shared.clone(),
        output_limit,
        overflow.clone(),
    ));

    // Wait for completion, cancellation, or timeout. Both exceptional paths
    // terminate the process group before any captured output is returned.
    let mut timed_out = false;
    let mut cancelled = false;
    tokio::select! {
        status = child.wait() => {
            status?;
        }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            timed_out = true;
            terminate_group(&mut child).await;
        }
        _ = cancellation.cancelled() => {
            cancelled = true;
            terminate_group(&mut child).await;
        }
        _ = overflow.cancelled() => {
            terminate_group(&mut child).await;
        }
    }

    // The stream tasks finish when the child closes its pipes.
    let (stdout_captured, stderr_captured) = tokio::join!(stdout_task, stderr_task);
    let (stdout_captured, stderr_captured) = (
        stdout_captured.unwrap_or_default(),
        stderr_captured.unwrap_or_default(),
    );
    let output_limit_exceeded = shared.load(Ordering::SeqCst) > output_limit;
    let stdout_bytes = stdout_captured.0;
    let stderr_bytes = stderr_captured.0;

    // Settle the final status (may be the one `wait` already saw).
    let status = match child.try_wait()? {
        Some(status) => status,
        None => child.wait().await?,
    };

    let result = ScriptProcessResult {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code: status.code(),
        signal: signal_of(&status),
        timed_out,
        output_limit_exceeded,
        cancelled,
    };
    Ok(result)
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Read one stream, honoring the shared combined output cap.
async fn capture_stream<S>(
    mut stream: S,
    shared: Arc<AtomicUsize>,
    limit: usize,
    overflow_signal: CancellationToken,
) -> (Vec<u8>, bool)
where
    S: tokio::io::AsyncRead + Unpin + Send,
{
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    let mut overflow = false;
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                let raw = n;
                // Track raw bytes so the combined cap trips on overflow; store
                // only what fits in this stream's share of the limit.
                let remaining = limit.saturating_sub(bytes.len());
                let stored = raw.min(remaining);
                bytes.extend_from_slice(&buffer[..stored]);
                if shared.fetch_add(raw, Ordering::SeqCst) + raw > limit {
                    overflow = true;
                    overflow_signal.cancel();
                }
            }
            Err(_) => break,
        }
    }
    (bytes, overflow)
}

#[cfg(unix)]
async fn terminate_group(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        return;
    };
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    tokio::time::sleep(KILL_GRACE).await;
    if child.try_wait().ok().flatten().is_none() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
async fn terminate_group(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_command_selects_the_interpreter_by_extension() {
        let (command, args) = script_command(Path::new("/tmp/x.sh"));
        assert_eq!(command, "/bin/bash");
        assert_eq!(args, vec!["/tmp/x.sh".to_string()]);
        let (command, args) = script_command(Path::new("/tmp/x.py"));
        assert_eq!(command, "python3");
        assert_eq!(args, vec!["/tmp/x.py".to_string()]);
        let (command, args) = script_command(Path::new("/tmp/x.mjs"));
        assert_eq!(command, "node");
        assert_eq!(args, vec!["/tmp/x.mjs".to_string()]);
        let (command, args) = script_command(Path::new("/tmp/x.bin"));
        assert_eq!(command, "/tmp/x.bin");
        assert!(args.is_empty());
    }

    #[test]
    fn path_inside_rejects_escapes() {
        let root = Path::new("/a/.aiden/scripts");
        assert!(path_inside(root, Path::new("/a/.aiden/scripts")));
        assert!(path_inside(root, Path::new("/a/.aiden/scripts/report.sh")));
        assert!(!path_inside(
            root,
            Path::new("/a/.aiden/scripts/../secret.sh")
        ));
        assert!(!path_inside(root, Path::new("/a/other.sh")));
    }

    #[tokio::test]
    async fn resolve_and_list_scripts_find_global_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let scripts = dir.path().join(".aiden").join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("report.sh"), "#!/bin/bash\necho hi\n").unwrap();
        std::fs::write(scripts.join("other.txt"), "not a script\n").unwrap();

        let resolved = resolve_scheduled_script("report.sh", None, Some(dir.path()))
            .await
            .unwrap();
        assert_eq!(resolved, scripts.join("report.sh").canonicalize().unwrap());

        // Every regular file is listed (the TS lists by file check, not extension).
        let listed = list_scheduled_scripts(None, Some(dir.path()))
            .await
            .unwrap();
        assert_eq!(
            listed,
            vec!["other.txt".to_string(), "report.sh".to_string()]
        );
    }

    #[tokio::test]
    async fn resolve_script_prefers_the_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let ws_scripts = workspace.join(".aiden").join("scripts");
        let global_scripts = dir.path().join(".aiden").join("scripts");
        std::fs::create_dir_all(&ws_scripts).unwrap();
        std::fs::create_dir_all(&global_scripts).unwrap();
        std::fs::write(ws_scripts.join("run.sh"), "echo workspace\n").unwrap();
        std::fs::write(global_scripts.join("run.sh"), "echo global\n").unwrap();

        let resolved = resolve_scheduled_script("run.sh", Some(&workspace), Some(dir.path()))
            .await
            .unwrap();
        assert_eq!(resolved, ws_scripts.join("run.sh").canonicalize().unwrap());
    }

    #[tokio::test]
    async fn resolve_script_rejects_symlink_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let scripts = dir.path().join(".aiden").join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let outside = dir.path().join("secret.sh");
        std::fs::write(&outside, "echo secret\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, scripts.join("escape.sh")).unwrap();

        let result = resolve_scheduled_script("escape.sh", None, Some(dir.path())).await;
        #[cfg(unix)]
        assert!(matches!(result, Err(ScriptError::OutsideRoot(_, _))));
        #[cfg(not(unix))]
        assert!(matches!(result, Err(ScriptError::NotFound(_, _))));
    }

    #[tokio::test]
    async fn run_scheduled_script_executes_and_captures_output() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hello.sh");
        std::fs::write(&script, "#!/bin/bash\necho hello\n").unwrap();
        let result = run_scheduled_script(&script, dir.path(), Some(10_000), None)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "hello");
        assert!(!result.timed_out);
        assert!(!result.output_limit_exceeded);
    }

    #[tokio::test]
    async fn run_scheduled_script_reports_failures_and_timeouts() {
        let dir = tempfile::tempdir().unwrap();
        let failing = dir.path().join("failing.sh");
        std::fs::write(&failing, "#!/bin/bash\necho oops >&2\nexit 3\n").unwrap();
        let result = run_scheduled_script(&failing, dir.path(), Some(10_000), None)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.stderr.trim(), "oops");

        let sleeping = dir.path().join("sleep.sh");
        std::fs::write(&sleeping, "#!/bin/bash\nsleep 30\n").unwrap();
        let result = run_scheduled_script(&sleeping, dir.path(), Some(200), None)
            .await
            .unwrap();
        assert!(result.timed_out);
        assert!(result.exit_code.is_none() || result.exit_code != Some(0));
    }

    #[tokio::test]
    async fn run_scheduled_script_enforces_the_output_cap() {
        let dir = tempfile::tempdir().unwrap();
        let noisy = dir.path().join("noisy.sh");
        std::fs::write(
            &noisy,
            "#!/bin/bash\nfor i in $(seq 1 1000); do echo xxxxxx; done\n",
        )
        .unwrap();
        let result = run_scheduled_script(&noisy, dir.path(), Some(10_000), Some(4096))
            .await
            .unwrap();
        assert!(result.output_limit_exceeded);
        assert!(result.stdout.len() <= 4096);
    }

    #[tokio::test]
    async fn cancellation_terminates_the_process_group_and_reports_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("sleep.sh");
        std::fs::write(&script, "#!/bin/bash\nsleep 30 &\nwait\n").unwrap();
        let cancellation = CancellationToken::new();
        let cancelling = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancelling.cancel();
        });
        let started = std::time::Instant::now();
        let result =
            run_scheduled_script_with_cancel(&script, dir.path(), Some(10_000), None, cancellation)
                .await
                .unwrap();
        assert!(result.cancelled);
        assert!(!result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
