package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

private const val SHIMMER_MS = 1_400L

/** Frame-driven loops (shimmers, glancing faces) redraw at about 30 frames a second. */
const val AIDEN_CAPPED_FRAME_INTERVAL_MS = 33L

/**
 * Whether a frame [elapsedMs] into a frame-driven loop is due, the last one drawn having been at
 * [shownMs]: at most one every [intervalMs]. A clock that went back (a restarted loop) is due.
 */
fun aidenFrameDue(shownMs: Long, elapsedMs: Long, intervalMs: Long = AIDEN_CAPPED_FRAME_INTERVAL_MS): Boolean =
    elapsedMs == 0L || elapsedMs - shownMs >= intervalMs || elapsedMs < shownMs

/**
 * Placeholder block for content that is still arriving. Aiden never shows a spinner for
 * a read: cached content renders immediately, and only a first load with nothing cached
 * shows these shaped placeholders. The shimmer stops under Reduce Motion, and when
 * [animate] is false (a read that has failed, or an app in the background).
 */
@Composable
fun AidenSkeletonBlock(
    modifier: Modifier = Modifier,
    width: Dp? = null,
    height: Dp = 14.dp,
    shape: Shape = MaterialTheme.shapes.small,
    animate: Boolean = true
) {
    val reduceMotion = aidenReduceMotion()
    val base = MaterialTheme.colorScheme.surfaceContainerHigh
    val brush = if (reduceMotion || !animate) {
        Brush.linearGradient(listOf(base, base))
    } else {
        val highlight = MaterialTheme.colorScheme.surfaceContainerHighest
        // About 30 frames a second: a shimmer needs no more, and a screen of them stays cheap.
        val clockMs = remember { mutableLongStateOf(0L) }
        LaunchedEffect(Unit) {
            var startMs = Long.MIN_VALUE
            while (true) {
                withFrameMillis { frameMs ->
                    if (startMs == Long.MIN_VALUE) startMs = frameMs
                    val elapsed = frameMs - startMs
                    if (aidenFrameDue(clockMs.longValue, elapsed)) clockMs.longValue = elapsed
                }
            }
        }
        val offset = -300f + 1_200f * ((clockMs.longValue % SHIMMER_MS).toFloat() / SHIMMER_MS)
        Brush.linearGradient(
            colors = listOf(base, highlight, base),
            start = Offset(offset, 0f),
            end = Offset(offset + 300f, 0f)
        )
    }
    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth())
            .height(height)
            .clip(shape)
            .background(brush)
    )
}

/** A list-row placeholder: optional leading circle, a headline bar and a supporting bar. */
@Composable
fun AidenSkeletonListRow(
    modifier: Modifier = Modifier,
    leading: Boolean = true,
    supporting: Boolean = true
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = if (supporting) 72.dp else 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        if (leading) AidenSkeletonBlock(Modifier.size(40.dp), width = 40.dp, height = 40.dp, shape = CircleShape)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
            AidenSkeletonBlock(Modifier.fillMaxWidth(0.62f), width = null, height = 14.dp)
            if (supporting) AidenSkeletonBlock(Modifier.fillMaxWidth(0.4f), width = null, height = 12.dp)
        }
    }
}

/**
 * A run of [count] skeleton rows announced once to accessibility services as loading,
 * instead of exposing each placeholder bar.
 */
@Composable
fun AidenSkeletonList(
    count: Int,
    modifier: Modifier = Modifier,
    leading: Boolean = true,
    supporting: Boolean = true,
    loadingDescription: String = stringResource(R.string.state_loading)
) {
    Column(modifier = modifier.clearAndSetSemantics { contentDescription = loadingDescription }) {
        repeat(count) { AidenSkeletonListRow(leading = leading, supporting = supporting) }
    }
}
