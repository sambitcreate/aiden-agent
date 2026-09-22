package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import kotlin.math.sin

/**
 * JetLagged-inspired continuous harmonic audio curve drawn with cubic Bezier interpolation.
 */
@Composable
fun AidenHarmonicWaveform(
    amplitude: Float,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "wave_phase")
    val phase by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = (2 * Math.PI).toFloat(),
        animationSpec = infiniteRepeatable(tween(2500, easing = LinearEasing), repeatMode = RepeatMode.Restart),
        label = "phase"
    )

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(36.dp)
    ) {
        val width = size.width
        val height = size.height
        val midY = height / 2f
        val points = 32
        val dx = width / (points - 1)

        val path = Path()
        val fillPath = Path()

        var prevX = 0f
        var prevY = midY

        path.moveTo(0f, midY)
        fillPath.moveTo(0f, midY)

        val effectiveAmp = amplitude.coerceIn(0.1f, 1f)

        for (i in 0 until points) {
            val x = i * dx
            val normX = i.toFloat() / (points - 1)
            // Envelope dampens at the edges (sinusoidal window)
            val envelope = sin(normX * Math.PI).toFloat()
            val y = midY + sin(phase + normX * 4 * Math.PI.toFloat()) * (effectiveAmp * midY * 0.85f) * envelope

            if (i == 0) {
                path.moveTo(x, y)
                fillPath.moveTo(x, y)
            } else {
                val cx1 = (prevX + x) / 2f
                val cy1 = prevY
                val cx2 = (prevX + x) / 2f
                val cy2 = y
                path.cubicTo(cx1, cy1, cx2, cy2, x, y)
                fillPath.cubicTo(cx1, cy1, cx2, cy2, x, y)
            }
            prevX = x
            prevY = y
        }

        fillPath.lineTo(width, height)
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
