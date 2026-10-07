package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.getValue
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

/**
 * Placeholder block for content that is still arriving. Aiden never shows a spinner for
 * a read: cached content renders immediately, and only a first load with nothing cached
 * shows these shaped placeholders. The shimmer stops under Reduce Motion.
 */
@Composable
fun AidenSkeletonBlock(
    modifier: Modifier = Modifier,
    width: Dp? = null,
    height: Dp = 14.dp,
    shape: Shape = MaterialTheme.shapes.small
) {
    val reduceMotion = aidenReduceMotion()
    val base = MaterialTheme.colorScheme.surfaceContainerHigh
    val brush = if (reduceMotion) {
        Brush.linearGradient(listOf(base, base))
    } else {
        val highlight = MaterialTheme.colorScheme.surfaceContainerHighest
        val transition = rememberInfiniteTransition(label = "aiden_skeleton")
        val offset by transition.animateFloat(
            initialValue = -300f,
            targetValue = 900f,
            animationSpec = infiniteRepeatable(tween(1_400, easing = LinearEasing), RepeatMode.Restart),
            label = "aiden_skeleton_offset"
        )
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
