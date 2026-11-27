package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.sin

internal object AidenVoiceWaveformBars {
    /** Bar heights shaped by a centred harmonic and scaled by the live level, never below [minHeight]. */
    fun heights(amplitude: Float, barCount: Int, maxHeight: Float, minHeight: Float): List<Float> {
        if (barCount <= 0) return emptyList()
        val level = amplitude.coerceIn(0.1f, 1f)
        return List(barCount) { i ->
            val harmonic = sin((i.toFloat() + 0.5f) / barCount * Math.PI).toFloat()
            max(minHeight, maxHeight * level * harmonic).coerceAtMost(maxHeight)
        }
    }
}

/**
 * Bare amplitude bars for a caller that already animates [amplitude]. The value is read
 * only while drawing, so a per-frame source redraws without recomposing.
 */
@Composable
internal fun AidenVoiceBars(
    amplitude: () -> Float,
    barCount: Int,
    color: Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        drawVoiceBars(amplitude().coerceIn(0.1f, 1f), barCount, color)
    }
}

private fun DrawScope.drawVoiceBars(amplitude: Float, barCount: Int, color: Color) {
    val barWidth = 4.dp.toPx()
    val heights = AidenVoiceWaveformBars.heights(amplitude, barCount, size.height, 4.dp.toPx())
    val spacing = if (barCount > 1) (size.width - barWidth * barCount) / (barCount - 1) else 0f
    heights.forEachIndexed { i, barHeight ->
        drawRoundRect(
            color = color,
            topLeft = Offset(i * (barWidth + spacing), (size.height - barHeight) / 2f),
            size = Size(barWidth, barHeight),
            cornerRadius = CornerRadius(2.dp.toPx(), 2.dp.toPx())
        )
    }
}
