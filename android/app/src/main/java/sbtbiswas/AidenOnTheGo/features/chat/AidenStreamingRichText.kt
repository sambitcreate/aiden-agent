package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.Animatable
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
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

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
    val splitter = remember { AidenStreamingMarkdownSplitter.Session() }
    val segments = remember(text) { splitter.split(text) }
    val reduceMotion = aidenReduceMotion()
    // The text length on screen after the previous composition; -1 before the
    // first, when the card itself is appearing and nothing should fade.
    val previouslyShown = remember { intArrayOf(-1) }
    val shownBefore = previouslyShown[0]
    SideEffect { previouslyShown[0] = text.length }
    val bodyStyle = aidenMessageBodyStyle(palette)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    // In one text a blank line adds a full line, but each separate text trims
    // the space above its first line and below its last, so the gap between
    // two chunks gives that trimmed space back as well.
    val blankLineGap = remember(bodyStyle, density) {
        with(density) {
            val oneLine = measurer.measure("A", bodyStyle).size.height
            (MESSAGE_LINE_HEIGHT.toPx() * 2 - oneLine).toDp()
        }
    }
    val chunks = segments.stableChunks
    val tail = segments.activeMarkdown

    Column(modifier = modifier) {
        for ((index, chunk) in chunks.withIndex()) {
            key(chunk.id) {
                val fades = remember { !reduceMotion && shownBefore >= 0 && chunk.start >= shownBefore }
                val alpha = remember { Animatable(if (fades) 0f else 1f) }
                if (fades) {
                    LaunchedEffect(Unit) { alpha.animateTo(1f, AidenMotion.nonSpatial(reduceMotion)) }
                }
                val previous = chunks.getOrNull(index - 1)
                val body = remember(chunk.text, previous?.text) {
                    val trimmed = chunk.text.trimEnd()
                    if (previous != null && AidenStreamingSeams.joinsCode(previous.text, chunk.text)) trimmed.trimStart() else trimmed
                }
                Box(Modifier.graphicsLayer { this.alpha = alpha.value }) {
                    RichFormattedMessage(body, palette, onCopy, onOpenUrl)
                }
                val next = chunks.getOrNull(index + 1)?.text ?: tail
                Spacer(Modifier.height(AidenStreamingSeams.gap(chunk, next, blankLineGap)))
            }
        }
        val shownTail = chunks.lastOrNull()
            ?.takeIf { AidenStreamingSeams.joinsCode(it.text, tail) }
            ?.let { tail.trimStart() }
            ?: tail
        if (shownTail.isNotEmpty() || showCursor) {
            Row(verticalAlignment = Alignment.Bottom) {
                if (shownTail.isNotEmpty()) {
                    RichFormattedMessage(shownTail, palette, onCopy, onOpenUrl, Modifier.weight(1f, fill = false))
                }
                if (showCursor) AidenStreamingCursor(palette = palette)
            }
        }
    }
}

/**
 * The gap between two pieces of a split reply, matching what the finished
 * message shows there. The renderer trims prose next to a code block and sets
 * the two 8dp apart; anywhere else a blank line keeps its own line height.
 */
internal object AidenStreamingSeams {
    val CODE_GAP = 8.dp

    /** Whether a code block sits on either side of the seam between [before] and [after]. */
    fun joinsCode(before: String, after: String): Boolean =
        endsWithCodeBlock(before.trimEnd()) || startsWithCodeBlock(after.trimStart())

    fun gap(chunk: AidenStreamingMarkdownSplitter.Chunk, next: String, blankLineGap: Dp): Dp = when {
        joinsCode(chunk.text, next) -> CODE_GAP
        chunk.seam == AidenStreamingMarkdownSplitter.Seam.BLANK_LINE -> blankLineGap
        else -> 0.dp
    }

    private fun startsWithCodeBlock(text: String): Boolean =
        text.startsWith("```") && CODE_BLOCK_REGEX.find(text)?.range?.first == 0

    private fun endsWithCodeBlock(text: String): Boolean =
        text.endsWith("```") && CODE_BLOCK_REGEX.findAll(text).lastOrNull()?.range?.last == text.lastIndex
}

/** The reply body's line height, shared with [RichFormattedMessage]. */
internal val MESSAGE_LINE_HEIGHT = 22.sp
