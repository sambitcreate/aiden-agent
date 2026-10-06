package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import kotlin.math.sin

internal object AidenHarmonicWaveformShape {
    /** Phase held when motion is reduced; the curve still rises and falls with the live level. */
    const val FROZEN_PHASE = 0f
    const val POINTS = 32

    /** Envelope-windowed sample points of the harmonic curve; the ends stay pinned to the midline. */
    fun points(width: Float, height: Float, amplitude: Float, phase: Float, count: Int = POINTS): List<Offset> {
        val midY = height / 2f
        val effectiveAmp = amplitude.coerceIn(0.1f, 1f)
        val steps = (count - 1).coerceAtLeast(1)
        return List(count.coerceAtLeast(2)) { i ->
            val normX = i.toFloat() / steps
            val envelope = sin(normX * Math.PI).toFloat()
            val y = midY + sin(phase + normX * 4 * Math.PI.toFloat()) * (effectiveAmp * midY * 0.85f) * envelope
            Offset(normX * width, y)
        }
    }
}

/**
 * JetLagged-inspired continuous harmonic audio curve drawn with cubic Bezier interpolation.
 * The travelling phase stops when motion is reduced.
 */
@Composable
fun AidenHarmonicWaveform(
    amplitude: Float,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    if (aidenReduceMotion()) {
        HarmonicCurve(amplitude, palette, modifier) { AidenHarmonicWaveformShape.FROZEN_PHASE }
    } else {
        val infiniteTransition = rememberInfiniteTransition(label = "wave_phase")
        val phase by infiniteTransition.animateFloat(
            initialValue = 0f,
            targetValue = (2 * Math.PI).toFloat(),
            animationSpec = infiniteRepeatable(tween(2500, easing = LinearEasing), repeatMode = RepeatMode.Restart),
            label = "phase"
        )
        HarmonicCurve(amplitude, palette, modifier) { phase }
    }
}

@Composable
private fun HarmonicCurve(
    amplitude: Float,
    palette: AidenPalette,
    modifier: Modifier,
    phase: () -> Float
) {
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(36.dp)
    ) {
        val height = size.height
        val points = AidenHarmonicWaveformShape.points(size.width, height, amplitude, phase())
        val path = Path()
        val fillPath = Path()
        points.forEachIndexed { i, point ->
            if (i == 0) {
                path.moveTo(point.x, point.y)
                fillPath.moveTo(point.x, point.y)
            } else {
                val prev = points[i - 1]
                val cx = (prev.x + point.x) / 2f
                path.cubicTo(cx, prev.y, cx, point.y, point.x, point.y)
                fillPath.cubicTo(cx, prev.y, cx, point.y, point.x, point.y)
            }
        }

        fillPath.lineTo(size.width, height)
        fillPath.lineTo(0f, height)
        fillPath.close()

        val gradient = Brush.verticalGradient(
            colors = listOf(palette.accent.copy(alpha = 0.35f), Color.Transparent),
            startY = 0f,
            endY = height
        )

        drawPath(fillPath, brush = gradient)
        drawPath(path, color = palette.accent, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
    }
}
