package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
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

/** Geometry of [AidenWorkingIndicator], matching the desktop Inbox's Working ring. */
object AidenWorkingIndicatorMotion {
    const val PERIOD_MILLIS = 1_500
    const val SWEEP_DEGREES = 270f
    const val ALPHA = 0.6f
}

/**
 * The desktop's Working indicator: an open three-quarter ring at 60% opacity
 * that turns once every 1.5 seconds. Reduce Motion leaves it still; the row's
 * text still says Working. Silent for TalkBack unless [contentDescription] is set.
 */
@Composable
fun AidenWorkingIndicator(
    modifier: Modifier = Modifier,
    color: Color = AidenTheme.palette.accent,
    size: Dp = 12.dp,
    contentDescription: String? = null
) {
    val semantics = Modifier.clearAndSetSemantics {
        if (contentDescription != null) this.contentDescription = contentDescription
    }
    val reduceMotion = aidenReduceMotion()
    // The turn is read in the draw phase only, so the ring redraws each frame
    // without recomposing the row around it.
    val rotation: State<Float> = if (reduceMotion) {
        remember { mutableFloatStateOf(0f) }
    } else {
        rememberInfiniteTransition(label = "aiden_working_ring").animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                tween(AidenWorkingIndicatorMotion.PERIOD_MILLIS, easing = LinearEasing),
                RepeatMode.Restart
            ),
            label = "aiden_working_ring_turn"
        )
    }
    Box(
        modifier
            .then(semantics)
            .size(size)
            .drawBehind {
                val stroke = maxOf(1.5.dp.toPx(), this.size.minDimension / 7f)
                val inset = stroke / 2f
                drawArc(
                    color = color.copy(alpha = color.alpha * AidenWorkingIndicatorMotion.ALPHA),
                    startAngle = rotation.value - 90f,
                    sweepAngle = AidenWorkingIndicatorMotion.SWEEP_DEGREES,
                    useCenter = false,
                    topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
                    size = androidx.compose.ui.geometry.Size(this.size.width - stroke, this.size.height - stroke),
                    style = Stroke(width = stroke, cap = StrokeCap.Round)
                )
            }
    )
}
