package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Breathing geometry for [AidenActivityDot]; phase 0 is dimmest and smallest. */
internal object AidenActivityDotMotion {
    const val PERIOD_MILLIS = 900
    const val MIN_ALPHA = 0.35f
    const val MIN_SCALE = 0.7f
    const val STATIC_ALPHA = 0.9f
}

/**
 * Aiden's activity signal in place of a spinner: a small dot that breathes while work
 * runs on the paired desktop or a write is in flight. It holds still under Reduce
 * Motion. Reads never use it; they show cached content or skeletons instead.
 *
 * Pass [contentDescription] when the dot stands alone. Leave it null when a sibling
 * label already says what is happening, so TalkBack does not read it twice.
 */
@Composable
fun AidenActivityDot(
    modifier: Modifier = Modifier,
    color: Color = AidenTheme.palette.accent,
    size: Dp = 8.dp,
    contentDescription: String? = null
) {
    val semantics = Modifier.clearAndSetSemantics {
        if (contentDescription != null) this.contentDescription = contentDescription
    }
    if (aidenReduceMotion()) {
        Box(
            modifier
                .then(semantics)
                .size(size)
                .drawBehind { drawCircle(color.copy(alpha = color.alpha * AidenActivityDotMotion.STATIC_ALPHA)) }
        )
        return
    }
    val transition = rememberInfiniteTransition(label = "aiden_activity_dot")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(AidenActivityDotMotion.PERIOD_MILLIS, easing = FastOutSlowInEasing),
            RepeatMode.Reverse
        ),
        label = "aiden_activity_dot_phase"
    )
    Box(
        modifier
            .then(semantics)
            .size(size)
            .drawBehind {
                val alpha = AidenActivityDotMotion.MIN_ALPHA + (1f - AidenActivityDotMotion.MIN_ALPHA) * phase
                val scale = AidenActivityDotMotion.MIN_SCALE + (1f - AidenActivityDotMotion.MIN_SCALE) * phase
                drawCircle(color.copy(alpha = color.alpha * alpha), radius = this.size.minDimension / 2f * scale)
            }
    )
}
