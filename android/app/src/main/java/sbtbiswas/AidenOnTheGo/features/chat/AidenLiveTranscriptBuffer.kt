package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Accumulates streamed reply and reasoning deltas without copying the whole
 * transcript on every token, and publishes at most one snapshot per frame.
 *
 * Callers must use it from one thread (the main dispatcher in the app). Call
 * [flush] before applying any event whose meaning depends on the text length,
 * such as a timeline offset or a terminal state, so observers never see a
 * timeline that points past the published text.
 */
class AidenLiveTranscriptBuffer(
    private val scope: CoroutineScope,
    private val frameMillis: Long = DEFAULT_FRAME_MILLIS,
    private val publish: (text: String, reasoning: String) -> Unit
) {
    private val text = StringBuilder()
    private val reasoning = StringBuilder()
    private var publishedText = ""
    private var publishedReasoning = ""
    private var frame: Job? = null

    val textLength: Int get() = text.length

    fun appendText(delta: String) {
        if (delta.isEmpty()) return
        text.append(delta)
        scheduleFrame()
    }

    fun appendReasoning(delta: String) {
        if (delta.isEmpty()) return
        reasoning.append(delta)
        scheduleFrame()
    }

    fun clearReasoning() {
        reasoning.setLength(0)
        flush()
    }

    /** Publishes pending deltas now. */
    fun flush() {
        frame?.cancel()
        frame = null
        val nextText = if (text.length == publishedText.length) publishedText else text.toString()
        val nextReasoning = if (reasoning.length == publishedReasoning.length) publishedReasoning else reasoning.toString()
        if (nextText === publishedText && nextReasoning === publishedReasoning) return
        publishedText = nextText
        publishedReasoning = nextReasoning
        publish(nextText, nextReasoning)
    }

    /** Drops both buffers and publishes the empty transcript immediately. */
    fun reset() {
        frame?.cancel()
        frame = null
        text.setLength(0)
        reasoning.setLength(0)
        publishedText = ""
        publishedReasoning = ""
        publish("", "")
    }

    private fun scheduleFrame() {
        if (frame?.isActive == true) return
        frame = scope.launch {
            delay(frameMillis)
            frame = null
            flush()
        }
    }

    companion object {
        /** About two display frames at 60 Hz. */
        const val DEFAULT_FRAME_MILLIS = 33L
    }
}
