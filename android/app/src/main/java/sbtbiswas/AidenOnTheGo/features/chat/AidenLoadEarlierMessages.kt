package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Elevated tonal capsule at the top of a windowed transcript that pages back
 * through earlier messages. Shares the tonal pill treatment of the jump-to-latest
 * control so it stays subordinate to the transcript.
 */
@Composable
fun AidenLoadEarlierMessages(
    isLoading: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val label = if (isLoading) "Loading earlier messages" else "Load earlier messages"
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
        contentAlignment = Alignment.Center
    ) {
        Surface(
            onClick = onClick,
            enabled = !isLoading,
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = palette.secondary,
            shadowElevation = 2.dp,
            interactionSource = interaction,
            modifier = Modifier
                .heightIn(min = 36.dp)
                .tactilePress(interaction)
                .semantics {
                    role = Role.Button
                    if (isLoading) stateDescription = "Loading"
                }
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                AnimatedContent(
                    targetState = isLoading,
                    transitionSpec = {
                        fadeIn(AidenMotion.nonSpatial(reduceMotion)) togetherWith fadeOut(AidenMotion.nonSpatial(reduceMotion))
                    },
                    label = "load_earlier_icon"
                ) { loading ->
                    if (loading && reduceMotion) {
                        CircularProgressIndicator(
                            progress = { 0.75f },
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = palette.secondary
                        )
                    } else if (loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = palette.secondary
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.ArrowUpward,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp)
                        )
                    }
                }
                Text(text = label, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
