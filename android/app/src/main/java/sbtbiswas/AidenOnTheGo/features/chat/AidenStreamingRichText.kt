package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/** How long a chunk that arrives already sealed takes to fade in. */
internal const val AIDEN_SEALED_CHUNK_FADE_MILLIS = 180

/**
 * A streaming reply rendered with the same formatting as the finished
 * message: sealed chunks that never re-render, then the active tail.
 *
 * A chunk normally seals from text the reader already watched arrive in the
 * tail, so it appears without any motion. Only a chunk whose text was never
 * on screen (a burst, or catching up with a run already in progress) fades in,
 * once, and not when motion is reduced.
 */
@Composable
internal fun AidenStreamingRichText(
    text: String,
    palette: AidenPalette,
    showCursor: Boolean,
    onCopy: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val segments = remember(text) { AidenStreamingMarkdownSplitter.split(text) }
    val reduceMotion = aidenReduceMotion()
    // The text length on screen after the previous composition; -1 before the
    // first, when the card itself is appearing and nothing should fade.
    val previouslyShown = remember { intArrayOf(-1) }
    val shownBefore = previouslyShown[0]
    SideEffect { previouslyShown[0] = text.length }
    val blankLineGap = with(LocalDensity.current) { MESSAGE_LINE_HEIGHT.toDp() }

    Column(modifier = modifier) {
        for (chunk in segments.stableChunks) {
            key(chunk.id) {
                val fades = remember { !reduceMotion && shownBefore >= 0 && chunk.start >= shownBefore }
                val alpha = remember { Animatable(if (fades) 0f else 1f) }
                if (fades) {
                    LaunchedEffect(Unit) { alpha.animateTo(1f, tween(AIDEN_SEALED_CHUNK_FADE_MILLIS)) }
                }
                Box(Modifier.graphicsLayer { this.alpha = alpha.value }) {
                    RichFormattedMessage(chunk.text.trimEnd(), palette, onCopy, onOpenUrl)
                }
                // Match the gap the whole reply shows at this point when it is
                // rendered as one message.
                when (chunk.seam) {
                    AidenStreamingMarkdownSplitter.Seam.BLANK_LINE -> Spacer(Modifier.height(blankLineGap))
                    AidenStreamingMarkdownSplitter.Seam.CODE_FENCE -> Spacer(Modifier.height(8.dp))
                    AidenStreamingMarkdownSplitter.Seam.SINGLE_LINE_BLOCK -> Unit
                }
            }
        }
        val tail = segments.activeMarkdown
        if (tail.isNotEmpty() || showCursor) {
            Row(verticalAlignment = Alignment.Bottom) {
                if (tail.isNotEmpty()) {
                    RichFormattedMessage(tail, palette, onCopy, onOpenUrl, Modifier.weight(1f, fill = false))
                }
                if (showCursor) AidenStreamingCursor(palette = palette)
            }
        }
    }
}

/** The reply body's line height, shared with [RichFormattedMessage]. */
internal val MESSAGE_LINE_HEIGHT = 22.sp
