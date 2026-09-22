package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Compact jump-to-latest affordance that stays visually subordinate to the composer.
 */
@Composable
fun AidenJumpToBottom(
    visible: Boolean,
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
        IconButton(
            onClick = onClick,
            modifier = Modifier.size(48.dp)
        ) {
            Surface(
                shape = androidx.compose.foundation.shape.CircleShape,
                color = palette.raised,
                shadowElevation = 3.dp,
                modifier = Modifier.size(32.dp)
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Default.ArrowDownward,
                        contentDescription = "Jump to latest",
                        tint = palette.accent,
                        modifier = Modifier.size(16.dp)
                    )
                }
            }
        }
    }
}
