package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenModel

/**
 * What the composer's round actions are doing. Controls waiting for input stay full
 * circles; controls that stop something already running morph into a squircle.
 */
enum class AidenComposerActionState { IDLE, READY, BUSY, RECORDING }

/** Squircle radius a 48dp composer action settles at while it stops a run or dictation. */
val AidenComposerActiveCornerRadius: Dp = 14.dp

fun aidenComposerSendActionState(isStreaming: Boolean, canSend: Boolean): AidenComposerActionState = when {
    isStreaming -> AidenComposerActionState.BUSY
    canSend -> AidenComposerActionState.READY
    else -> AidenComposerActionState.IDLE
}

fun aidenComposerVoiceActionState(isListening: Boolean): AidenComposerActionState =
    if (isListening) AidenComposerActionState.RECORDING else AidenComposerActionState.IDLE

/** Corner radius for a composer action of [size] in [state]: half the size draws a circle. */
fun aidenComposerActionCornerRadius(state: AidenComposerActionState, size: Dp): Dp = when (state) {
    AidenComposerActionState.IDLE, AidenComposerActionState.READY -> size / 2
    AidenComposerActionState.BUSY, AidenComposerActionState.RECORDING -> minOf(AidenComposerActiveCornerRadius, size / 2)
}

enum class AidenComposerThinkingSelector { NONE, SEGMENTED, LIST }

/** Up to four efforts fit one connected segmented row on a phone; longer ladders become a list. */
fun aidenComposerThinkingSelector(levels: List<String>): AidenComposerThinkingSelector = when (levels.size) {
    0 -> AidenComposerThinkingSelector.NONE
    in 2..4 -> AidenComposerThinkingSelector.SEGMENTED
    else -> AidenComposerThinkingSelector.LIST
}

/** The effort the sheet marks as chosen: the stored level when the model still offers it, else the model default. */
fun aidenComposerSelectedThinkingLevel(model: AidenModel, selected: String?): String? {
    val levels = model.thinkingLevels.orEmpty()
    return selected?.takeIf { it in levels } ?: model.effectiveThinkingLevel
}

/** A pending composer attachment, identified by its durable reference id (names may repeat). */
/**
 * How far the attachments being sent to the Mac have got: which one of the batch is going
 * ([index] of [count], from 0) and the share of its bytes already sent.
 */
data class AidenUploadProgress(val index: Int, val count: Int, val fraction: Float) {
    /** The whole batch, 0 to 1. */
    val overall: Float
        get() = if (count <= 0) 0f else ((index + fraction.coerceIn(0f, 1f)) / count).coerceIn(0f, 1f)

    val percent: Int
        get() = (overall * 100).toInt()

    /**
     * The same batch with the current upload at [fraction], or null when that would not move
     * the bar by a whole percent (the body reports often) or would move it back.
     */
    fun advancedTo(fraction: Float): AidenUploadProgress? {
        val next = copy(fraction = fraction)
        return if (next.percent > percent || (fraction >= 1f && this.fraction < 1f)) next else null
    }
}

data class AidenComposerPendingAttachment(val id: String, val name: String, val isImage: Boolean)
