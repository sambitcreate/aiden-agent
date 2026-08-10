//! Production Apple Foundation Models connection for on-device chat titles.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use aiden_computer_use::{
    create_foundation_models_connection, run_helper_request, FoundationModelsConnection,
    FoundationModelsConnectionError, FoundationModelsResponse, NativeFoundationModelsRequest,
    NativeFoundationModelsRequestRunner, NativeFoundationModelsRunOptions, OpenHelperSpawner,
};
use futures::{future::BoxFuture, FutureExt as _};

const HELPER_APP_NAME: &str = "Aiden Foundation Models Helper.app";
type FoundationModelsRequestFn = dyn Fn(
        NativeFoundationModelsRequest,
        NativeFoundationModelsRunOptions,
    ) -> BoxFuture<'static, Result<FoundationModelsResponse, FoundationModelsConnectionError>>
    + Send
    + Sync;

pub fn production_foundation_models_connection() -> FoundationModelsConnection {
    let helper_path = default_helper_path();
    let environment = OpenHelperSpawner::environment(&std::env::vars().collect::<HashMap<_, _>>());
    let spawner = Arc::new(OpenHelperSpawner {
        helper_path,
        environment,
    });
    let run_request: Arc<FoundationModelsRequestFn> = Arc::new(
        move |request: NativeFoundationModelsRequest, options: NativeFoundationModelsRunOptions| {
            let spawner = spawner.clone();
            async move {
                if !spawner.helper_path.is_dir() {
                    return Err(FoundationModelsConnectionError::new(
                        "helper_missing",
                        "The Apple Foundation Models helper is unavailable.",
                    ));
                }
                run_helper_request(&request, &options, spawner.as_ref(), &std::env::temp_dir())
                    .await
            }
            .boxed()
        },
    );
    production_connection_adapter(
        std::env::consts::OS,
        std::env::consts::ARCH,
        &current_system_version(),
        run_request,
    )
}

fn production_connection_adapter(
    platform: &str,
    arch: &str,
    system_version: &str,
    run_request: NativeFoundationModelsRequestRunner,
) -> FoundationModelsConnection {
    let platform = match platform {
        "macos" => "darwin",
        other => other,
    };
    let arch = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    create_foundation_models_connection(
        platform,
        arch,
        system_version,
        Arc::new(aiden_data::now_millis),
        run_request,
    )
}

fn default_helper_path() -> PathBuf {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(contents) = executable.parent().and_then(std::path::Path::parent) {
            let packaged = contents.join("Helpers").join(HELPER_APP_NAME);
            if packaged.is_dir() {
                return packaged;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("build/native")
        .join(HELPER_APP_NAME)
}

#[cfg(target_os = "macos")]
fn current_system_version() -> String {
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "0".to_string())
}

#[cfg(not(target_os = "macos"))]
fn current_system_version() -> String {
    "0".to_string()
}

#[cfg(test)]
mod tests {
    use aiden_computer_use::{FoundationModelsConnectionState, FoundationModelsState};

    use super::*;

    #[test]
    fn development_helper_path_is_repo_local_and_fixed() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("build/native")
            .join(HELPER_APP_NAME);
        assert!(path.ends_with("build/native/Aiden Foundation Models Helper.app"));
    }

    #[tokio::test]
    async fn production_adapter_normalizes_rust_macos_target_and_reaches_native_status() {
        let run_request: NativeFoundationModelsRequestRunner = Arc::new(|request, _| {
            assert!(matches!(
                request.method,
                aiden_computer_use::NativeFoundationModelsMethod::Availability
            ));
            async {
                Ok(FoundationModelsResponse::success(
                    Some(FoundationModelsState::Ready),
                    None,
                ))
            }
            .boxed()
        });
        let connection = production_connection_adapter("macos", "aarch64", "26.0", run_request);

        assert_eq!(
            connection.status(false).await.unwrap().state,
            FoundationModelsConnectionState::Ready
        );
    }
}
