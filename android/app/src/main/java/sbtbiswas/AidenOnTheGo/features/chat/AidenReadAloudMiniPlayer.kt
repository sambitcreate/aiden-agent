package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

/** Values the mini player shows; retained while it collapses after Read Aloud stops. */
data class AidenReadAloudMiniPlayerState(
    val phase: AidenReadAloudPhase,
    val label: String,
    val progressRatio: Float,
    val totalSegments: Int
)

/**
 * Floating tonal pill shown while Read Aloud is active: a mini waveform, the phase
 * label with live segment progress, and a squircle Stop action.
 */
@Composable
fun AidenReadAloudMiniPlayer(
    phase: AidenReadAloudPhase,
    label: String,
    progressRatio: Float,
    totalSegments: Int,
    onStop: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val stopDescription = stringResource(R.string.chat_read_aloud_stop)
    val reduceMotion = aidenReduceMotion()
    val playing = phase == AidenReadAloudPhase.PLAYING
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shadowElevation = 4.dp,
        modifier = modifier.widthIn(max = 420.dp)
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            AidenReadAloudMiniWaveform(playing = playing, reduceMotion = reduceMotion)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                )
                AidenReadAloudSegmentBar(
                    progressRatio = progressRatio,
                    totalSegments = totalSegments,
                    playing = playing,
                    reduceMotion = reduceMotion
                )
            }
            val interaction = remember { MutableInteractionSource() }
            Surface(
                onClick = onStop,
                shape = AidenShape.Button,
                color = palette.danger.copy(alpha = 0.12f),
                contentColor = palette.danger,
                interactionSource = interaction,
                modifier = Modifier
                    .size(44.dp)
                    .tactilePress(interaction)
                    .semantics {
                        role = Role.Button
                        contentDescription = stopDescription
                    }
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun AidenReadAloudMiniWaveform(playing: Boolean, reduceMotion: Boolean) {
    val modifier = Modifier
        .size(width = 48.dp, height = 24.dp)
        .clearAndSetSemantics { }
    val color = AidenTheme.palette.accent
    if (playing && !reduceMotion) {
        val transition = rememberInfiniteTransition(label = "read_aloud_wave")
        val pulse by transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 0.9f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 420), RepeatMode.Reverse),
            label = "read_aloud_wave_amp"
        )
        // Read only while drawing so the pulse redraws the bars without recomposing.
        AidenVoiceBars(amplitude = { pulse }, barCount = 5, color = color, modifier = modifier)
    } else {
        val still = if (reduceMotion) 0.6f else 0.25f
        AidenVoiceBars(amplitude = { still }, barCount = 5, color = color, modifier = modifier)
    }
}

@Composable
private fun AidenReadAloudSegmentBar(
    progressRatio: Float,
    totalSegments: Int,
    playing: Boolean,
    reduceMotion: Boolean
) {
    val palette = AidenTheme.palette
    val ratio by animateFloatAsState(
        targetValue = progressRatio.coerceIn(0f, 1f),
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "read_aloud_progress"
    )
    val fill by animateColorAsState(
        targetValue = if (playing) palette.accent else palette.secondary,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "read_aloud_fill"
    )
    val track = palette.secondary.copy(alpha = 0.18f)
    val segments = AidenReadAloudProgress.visibleSegments(totalSegments)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(4.dp)
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(progressRatio.coerceIn(0f, 1f), 0f..1f) },
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        repeat(segments) { index ->
            val segmentFill = AidenReadAloudProgress.segmentFill(index, segments, ratio)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(track)
            ) {
                if (segmentFill > 0f) {
                    Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(segmentFill)
                            .background(fill)
                    )
                }
            }
        }
    }
}
