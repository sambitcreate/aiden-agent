package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
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
 * Real-time voice amplitude bars. By default they sit in a soft accent pill with a
 * recording dot and a label; pass `contained = false` to embed bare bars in another surface.
 */
@Composable
fun AidenVoiceWaveform(
    amplitude: Float,
    barCount: Int = 7,
    color: Color = AidenTheme.palette.accent,
    modifier: Modifier = Modifier,
    label: String? = "Listening...",
    contained: Boolean = true
) {
    val reduceMotion = aidenReduceMotion()
    val animatedAmp by animateFloatAsState(
        targetValue = amplitude.coerceIn(0.1f, 1f),
        animationSpec = if (reduceMotion) snap() else spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness = Spring.StiffnessHigh
        ),
        label = "voice_amp"
    )

    val content: @Composable () -> Unit = {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
            modifier = Modifier.height(32.dp)
        ) {
            if (contained) {
                AidenRecordingDot(AidenTheme.palette.danger, reduceMotion)
                Spacer(modifier = Modifier.width(8.dp))
            }
            Canvas(modifier = Modifier.size(width = 88.dp, height = 24.dp)) {
                val barWidth = 4.dp.toPx()
                val heights = AidenVoiceWaveformBars.heights(animatedAmp, barCount, size.height, 4.dp.toPx())
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
            if (label != null) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = color
                )
            }
        }
    }

    if (contained) {
        Surface(
            color = AidenTheme.palette.accent.copy(alpha = 0.12f),
            shape = CircleShape,
            modifier = modifier
        ) {
            Box(modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) { content() }
        }
    } else {
        Box(modifier = modifier) { content() }
    }
}

@Composable
private fun AidenRecordingDot(color: Color, reduceMotion: Boolean) {
    if (reduceMotion) {
        RecordingDot(color) { 1f }
    } else {
        val transition = rememberInfiniteTransition(label = "recording_dot")
        val pulse by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "recording_dot_alpha"
        )
        RecordingDot(color) { pulse }
    }
}

@Composable
private fun RecordingDot(color: Color, alpha: () -> Float) {
    Box(
        modifier = Modifier
            .size(8.dp)
            .drawBehind { drawCircle(color.copy(alpha = color.alpha * alpha())) }
    )
}
