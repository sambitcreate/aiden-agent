package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.Serializable
import java.util.Base64

const val READ_ALOUD_SETUP_GUIDANCE = "Enable Read Aloud in the desktop app: Settings → Text to Speech. Voice and credentials are managed on your Mac. Selected response text is sent from your Mac to Google and may incur charges."

@Serializable data class AidenReadAloudSource(val chatId: String, val messageId: String, val sourceRevision: String)
@Serializable data class AidenReadAloudStart(val requestId: String, val source: AidenReadAloudSource, val settingsRevision: String)
@Serializable data class AidenReadAloudStop(val requestId: String)
@Serializable data class AidenReadAloudError(val message: String)
@Serializable data class AidenReadAloudJob(
    val jobId: String, val chatId: String?, val phase: String,
    val totalSegments: Int, val readySegments: Int, val error: AidenReadAloudError? = null
) {
    companion object {
        const val MAXIMUM_STALLED_POLLS = 240 // 120s, per-segment server timeout is 60s.
        fun nextStalledPollCount(previousReady: Int, currentReady: Int, stalled: Int): Int =
            if (currentReady > previousReady) 0 else stalled + 1
    }
    val isValid: Boolean get() = jobId.matches(Regex("[A-Za-z0-9-]{1,128}")) && totalSegments in 1..256 &&
        readySegments in 0..totalSegments && phase in setOf("preparing", "generating", "buffering", "paused", "completed", "cancelled", "failed")
}
@Serializable data class AidenReadAloudStatus(
    val enabled: Boolean, val ready: Boolean, val settingsRevision: String,
    val source: AidenReadAloudSource? = null, val job: AidenReadAloudJob? = null
)
@Serializable data class AidenReadAloudAudio(
    val bytesBase64: String, val mimeType: String, val sampleRate: Int, val channels: Int,
    val segmentBytes: Int, val nextOffset: Int, val complete: Boolean
) {
    fun validatedBytes(offset: Int, expectedTotal: Int?): ByteArray {
        require(bytesBase64.length <= 87_384) { "Read Aloud audio exceeded its limit." }
        val data = Base64.getDecoder().decode(bytesBase64)
        require(data.size in 1..65_536 && mimeType == "audio/wav" && sampleRate == 24_000 && channels == 1 &&
            segmentBytes in 1..(8 * 1_024 * 1_024) && (expectedTotal == null || expectedTotal == segmentBytes) &&
            nextOffset == offset + data.size && nextOffset <= segmentBytes && complete == (nextOffset == segmentBytes)) {
            "Invalid Read Aloud audio. Generation will not retry automatically."
        }
        return data
    }
}
