package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import kotlin.math.PI
import kotlin.math.cos

/** Breathing cursor geometry: phase 0 is fully lit and widest, phase 0.5 is dimmest and narrowest. */
internal object AidenStreamingCursorMotion {
    const val STATIC_ALPHA = 0.85f
    const val MIN_ALPHA = 0.3f
    const val PERIOD_MILLIS = 1_100
    val MinWidth: Dp = 4.dp
    val MaxWidth: Dp = 7.dp
    val StaticWidth: Dp = 6.dp

    /** Sine-eased 0..1 intensity, continuous across the loop's wrap from 1 back to 0. */
    fun intensity(phase: Float): Float = (0.5f + 0.5f * cos(2f * PI.toFloat() * phase)).coerceIn(0f, 1f)

    fun alpha(phase: Float): Float = MIN_ALPHA + (1f - MIN_ALPHA) * intensity(phase)

    fun width(phase: Float): Dp = lerp(MinWidth, MaxWidth, intensity(phase))
}

/**
 * Breathing accent capsule for live token generation. Holds a steady capsule without any
 * running transition when motion is reduced.
 */
@Composable
fun AidenStreamingCursor(
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    if (aidenReduceMotion()) {
        CursorCapsule(palette.accent, modifier, { AidenStreamingCursorMotion.STATIC_ALPHA }, { AidenStreamingCursorMotion.StaticWidth })
    } else {
        val transition = rememberInfiniteTransition(label = "cursor_breath")
        val phase by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(AidenStreamingCursorMotion.PERIOD_MILLIS, easing = LinearEasing),
                repeatMode = RepeatMode.Restart
            ),
            label = "cursor_phase"
        )
        CursorCapsule(
            palette.accent,
            modifier,
            { AidenStreamingCursorMotion.alpha(phase) },
            { AidenStreamingCursorMotion.width(phase) }
        )
    }
}

@Composable
private fun CursorCapsule(
    color: Color,
    modifier: Modifier,
    alpha: () -> Float,
    width: () -> Dp
) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    // A fixed slot keeps the trailing text from shifting while the capsule breathes.
    Box(
        modifier = modifier
            .padding(start = 4.dp, bottom = 2.dp)
            .size(width = AidenStreamingCursorMotion.MaxWidth, height = 16.dp)
            .drawBehind {
                val w = width().toPx()
                val radius = CornerRadius(w / 2f, w / 2f)
                drawRoundRect(
                    color = color.copy(alpha = color.alpha * alpha()),
                    topLeft = Offset(if (rtl) size.width - w else 0f, 0f),
                    size = Size(w, size.height),
                    cornerRadius = radius
                )
            }
    )
}
