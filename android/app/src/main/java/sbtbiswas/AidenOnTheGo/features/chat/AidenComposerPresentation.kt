package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider

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

data class AidenComposerModelRow(val model: AidenModel, val isCurrent: Boolean)

data class AidenComposerModelSection(val provider: AidenProvider, val rows: List<AidenComposerModelRow>)

/**
 * Provider sections for the model sheet. A row is current only when both its provider
 * and model match the selection, and providers without models are left out.
 */
fun aidenComposerModelSections(
    providers: List<AidenProvider>,
    selectedProvider: AidenProvider?,
    selectedModel: AidenModel?
): List<AidenComposerModelSection> = providers
    .filter { it.models.isNotEmpty() }
    .map { provider ->
        AidenComposerModelSection(
            provider = provider,
            rows = provider.models.map { model ->
                AidenComposerModelRow(
                    model = model,
                    isCurrent = selectedProvider?.id == provider.id && selectedModel?.id == model.id
                )
            }
        )
    }
