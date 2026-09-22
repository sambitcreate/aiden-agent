package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import kotlin.math.max
import kotlin.math.sin

/**
 * Animated real-time voice amplitude waveform visualizer with organic harmonics.
 */
@Composable
fun AidenVoiceWaveform(
    amplitude: Float,
    barCount: Int = 7,
    color: Color = AidenTheme.palette.accent,
    modifier: Modifier = Modifier
) {
    val animatedAmp by animateFloatAsState(
        targetValue = amplitude.coerceIn(0.1f, 1f),
        animationSpec = spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness = Spring.StiffnessHigh
        ),
        label = "voice_amp"
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        modifier = modifier.height(32.dp)
    ) {
        Canvas(modifier = Modifier.size(width = 88.dp, height = 24.dp)) {
            val barWidth = 4.dp.toPx()
            val spacing = (size.width - (barWidth * barCount)) / (barCount - 1)
            val maxHeight = size.height

            for (i in 0 until barCount) {
                // Organic harmonic curve (sinusoidal peak in center bars)
                val harmonic = (sin((i.toFloat() + 0.5f) / barCount * Math.PI)).toFloat()
                val barHeight = max(4.dp.toPx(), maxHeight * animatedAmp * harmonic)
                val left = i * (barWidth + spacing)
                val top = (maxHeight - barHeight) / 2f

                drawRoundRect(
                    color = color,
                    topLeft = Offset(left, top),
                    size = Size(barWidth, barHeight),
                    cornerRadius = CornerRadius(2.dp.toPx(), 2.dp.toPx())
                )
            }
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "Listening...",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = color
        )
    }
}
