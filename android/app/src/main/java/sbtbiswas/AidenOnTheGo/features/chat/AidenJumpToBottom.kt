package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.OrbSize
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.OrbState
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.ThinkingOrb
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.hairlineBorder

/**
 * Modern floating Jump To Bottom capsule button with active streaming status.
 */
@Composable
fun AidenJumpToBottom(
    visible: Boolean,
    isStreaming: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette

    AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(
            initialOffsetY = { it },
            animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
        ) + fadeIn(animationSpec = AidenMotion.nonSpatialExpressiveSpring<Float>()),
        exit = slideOutVertically(
            targetOffsetY = { it },
            animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
        ) + fadeOut(animationSpec = AidenMotion.nonSpatialExpressiveSpring<Float>()),
        modifier = modifier
    ) {
        ExtendedFloatingActionButton(
            onClick = onClick,
            containerColor = palette.raised,
            contentColor = palette.foreground,
            elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 6.dp, pressedElevation = 8.dp),
            shape = RoundedCornerShape(20.dp),
            icon = {
                Icon(
                    imageVector = Icons.Default.ArrowDownward,
                    contentDescription = "Jump to bottom",
                    tint = palette.accent,
                    modifier = Modifier.size(18.dp)
                )
            },
            text = {
                if (isStreaming) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ThinkingOrb(state = OrbState.WORKING, size = OrbSize.PX16)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "New tokens",
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.foreground
                        )
                    }
                } else {
                    Text(
                        text = "Jump to latest",
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.foreground
                    )
                }
            },
            modifier = Modifier
                .height(40.dp)
                .hairlineBorder(color = palette.secondary.copy(alpha = 0.2f), shape = RoundedCornerShape(20.dp))
        )
    }
}
