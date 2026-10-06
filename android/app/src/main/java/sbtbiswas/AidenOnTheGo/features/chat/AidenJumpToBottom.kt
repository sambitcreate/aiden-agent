package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Compact jump-to-latest affordance that stays visually subordinate to the composer:
 * an arrow-only tonal pill that springs up from below.
 */
@Composable
fun AidenJumpToBottom(
    visible: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()

    AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(AidenMotion.spatial(reduceMotion)) { it } +
            scaleIn(AidenMotion.bouncy(reduceMotion), initialScale = 0.8f) +
            fadeIn(AidenMotion.nonSpatial(reduceMotion)),
        exit = slideOutVertically(AidenMotion.spatial(reduceMotion)) { it } +
            scaleOut(AidenMotion.spatial(reduceMotion), targetScale = 0.8f) +
            fadeOut(AidenMotion.nonSpatial(reduceMotion)),
        modifier = modifier
    ) {
        val interaction = remember { MutableInteractionSource() }
        Box(modifier = Modifier.padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
            Surface(
                onClick = onClick,
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surfaceContainerHighest,
                contentColor = palette.accent,
                shadowElevation = 4.dp,
                interactionSource = interaction,
                modifier = Modifier
                    .size(width = 56.dp, height = 36.dp)
                    .tactilePress(interaction, targetScale = 0.92f)
                    .semantics {
                        role = Role.Button
                        contentDescription = "Jump to latest"
                    }
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Default.ArrowDownward,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}
