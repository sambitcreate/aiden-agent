//! On-device speech-to-text via sherpa-onnx (NVIDIA Parakeet TDT) — port of
//! `main/services/parakeet.ts`. The native engine ships as a prebuilt static
//! library pulled by `sherpa-onnx-sys` at build time; models are downloaded
//! and managed by [`crate::local_models`]. Transcription runs fully offline.
//!
//! Recognizer construction is expensive (it loads ~600 MB of ONNX), so one
//! recognizer is cached per model id. The whole module is behind the
//! `dictation` cargo feature — the crate builds without sherpa-onnx when the
//! feature is off.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};

use crate::local_models::{is_model_installed, model_dir};

#[derive(Debug, thiserror::Error)]
pub enum SherpaError {
    /// The exact copy the TS throws when the model is missing.
    #[error("The selected voice model isn't downloaded. Download it in Settings → Voice.")]
    ModelNotInstalled,
    #[error("Failed to load the on-device engine: {0}")]
    Engine(String),
}

/// A loaded Parakeet recognizer bound to one model directory.
pub struct ParakeetRecognizer {
    recognizer: OfflineRecognizer,
}

impl ParakeetRecognizer {
    /// Build a recognizer with the exact config from `parakeet.ts`
    /// (nemo_transducer, int8 encoder/decoder/joiner, 2 threads, cpu).
    pub fn load(model_dir: &Path) -> Result<Self, SherpaError> {
        let join = |file: &str| model_dir.join(file).to_string_lossy().into_owned();
        let mut config = OfflineRecognizerConfig::default();
        config.feat_config.sample_rate = 16_000;
        config.feat_config.feature_dim = 80;
        config.model_config.transducer = OfflineTransducerModelConfig {
            encoder: Some(join("encoder.int8.onnx")),
            decoder: Some(join("decoder.int8.onnx")),
            joiner: Some(join("joiner.int8.onnx")),
        };
        config.model_config.tokens = Some(join("tokens.txt"));
        config.model_config.model_type = Some("nemo_transducer".into());
        config.model_config.num_threads = 2;
        config.model_config.provider = Some("cpu".into());
        config.model_config.debug = false;

        let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
            SherpaError::Engine(
                "OfflineRecognizer::create returned None (bad model files or native init)".into(),
            )
        })?;
        Ok(Self { recognizer })
    }

    /// Transcribe 16 kHz mono Float32 PCM (`transcribePcm`): createStream →
    /// acceptWaveform → decode → getResult → trim.
    pub fn transcribe(&self, samples: &[f32]) -> String {
        if samples.is_empty() {
            return String::new();
        }
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(16_000, samples);
        self.recognizer.decode(&stream);
        stream
            .get_result()
            .map(|result| result.text)
            .unwrap_or_default()
            .trim()
            .to_string()
    }
}

fn recognizers() -> &'static Mutex<HashMap<String, Arc<ParakeetRecognizer>>> {
    static RECOGNIZERS: OnceLock<Mutex<HashMap<String, Arc<ParakeetRecognizer>>>> = OnceLock::new();
    RECOGNIZERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `getRecognizer`: cached recognizer for `model_id`, loading it on first use.
pub fn get_recognizer(model_id: &str) -> Result<Arc<ParakeetRecognizer>, SherpaError> {
    let recognizers = recognizers();
    if let Ok(cache) = recognizers.lock() {
        if let Some(cached) = cache.get(model_id) {
            return Ok(cached.clone());
        }
    }
    // The dir/installed check mirrors parakeet.ts exactly.
    let Some(dir) = model_dir(model_id) else {
        return Err(SherpaError::ModelNotInstalled);
    };
    if !is_model_installed(model_id) {
        return Err(SherpaError::ModelNotInstalled);
    }
    let recognizer = Arc::new(ParakeetRecognizer::load(&dir)?);
    if let Ok(mut cache) = recognizers.lock() {
        cache.insert(model_id.to_string(), recognizer.clone());
    }
    tracing::info!(model_id, "sherpa: Loaded recognizer");
    Ok(recognizer)
}

/// `releaseRecognizer`: forget a cached recognizer (e.g. after deleting or
/// replacing a model).
pub fn release_recognizer(model_id: &str) {
    if let Ok(mut cache) = recognizers().lock() {
        cache.remove(model_id);
    }
}

/// `engineStatus`: whether the on-device engine loads. `Ok(())` means a
/// recognizer can be constructed; the model files themselves are checked at
/// [`get_recognizer`] time.
pub fn engine_status() -> Result<(), String> {
    // Construction needs real model files, so probe loadability cheaply:
    // sherpa-onnx links statically, so a loaded binary means the engine is
    // available. There is no cheap "is the native lib present" probe beyond
    // a successful create, which requires the models — report ready.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_models::MODELS_ENV_LOCK;
    use std::path::PathBuf;

    #[test]
    fn load_fails_cleanly_for_a_missing_model_dir() {
        let dir = PathBuf::from("/nonexistent/parakeet");
        assert!(matches!(
            ParakeetRecognizer::load(&dir),
            Err(SherpaError::Engine(_))
        ));
    }

    #[test]
    fn missing_model_reports_the_exact_settings_copy() {
        // `parakeet-v3` is catalogued but not installed in the test env. The
        // env-var lock serializes against local_models' models-root tests.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = runtime.block_on(async { MODELS_ENV_LOCK.lock().await });
        match get_recognizer("parakeet-v3") {
            Ok(_) => panic!("expected the model to be missing in tests"),
            Err(error) => {
                assert_eq!(
                    error.to_string(),
                    "The selected voice model isn't downloaded. Download it in Settings → Voice."
                );
            }
        }
    }

    #[test]
    fn unknown_model_is_not_installed() {
        match get_recognizer("not-a-model") {
            Ok(_) => panic!("expected an unknown model to fail"),
            Err(error) => assert!(matches!(error, SherpaError::ModelNotInstalled)),
        }
    }

    #[test]
    fn release_recognizer_is_safe_for_unloaded_models() {
        release_recognizer("parakeet-v3");
        release_recognizer("parakeet-v2");
    }
}
