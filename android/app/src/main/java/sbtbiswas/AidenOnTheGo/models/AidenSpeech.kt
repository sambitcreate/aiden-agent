package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.Serializable

@Serializable
data class AidenSpeechEngine(val ready: Boolean, val error: String? = null)

@Serializable
data class AidenSpeechDownload(
    val id: String,
    val percentage: Int,
    val phase: String,
    val status: String,
    val error: String? = null
)

@Serializable
data class AidenSpeechModel(
    val id: String,
    val name: String,
    val description: String,
    val sizeLabel: String,
    val languagesLabel: String,
    val recommended: Boolean,
    val installed: Boolean,
    val download: AidenSpeechDownload? = null
)

@Serializable
data class AidenSpeechInputContract(
    val encoding: String,
    val sampleRate: Int,
    val channels: Int,
    val maximumSeconds: Int,
    val partialResults: Boolean
)

@Serializable
data class AidenSpeechStatus(
    val engine: AidenSpeechEngine,
    val selectedModelId: String? = null,
    val models: List<AidenSpeechModel>,
    val input: AidenSpeechInputContract
)

@Serializable
data class AidenSpeechSelectionRequest(val modelId: String)

@Serializable
data class AidenSpeechTranscriptionRequest(
    val encoding: String = "pcm_s16le",
    val sampleRate: Int = 16_000,
    val channels: Int = 1,
    val pcmBase64: String,
    val modelId: String
)

@Serializable
data class AidenSpeechTranscription(val text: String, val modelId: String)
