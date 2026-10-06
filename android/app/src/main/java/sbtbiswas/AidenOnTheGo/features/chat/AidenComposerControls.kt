package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Round composer action whose corners morph between a circle and a squircle as [state]
 * changes, with a tonal container that crossfades and a tactile press. Both settle
 * instantly when motion is reduced.
 */
@Composable
internal fun AidenComposerMorphingAction(
    state: AidenComposerActionState,
    containerColor: Color,
    onClick: () -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = AidenUi.MinimumTouchTarget,
    content: @Composable BoxScope.() -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val corner by animateDpAsState(
        targetValue = aidenComposerActionCornerRadius(state, size),
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "composer_action_corner"
    )
    val fill by animateColorAsState(
        targetValue = containerColor,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "composer_action_fill"
    )
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(corner),
        color = fill,
        interactionSource = interaction,
        modifier = modifier
            .size(size)
            .tactilePress(interaction)
            .semantics { role = Role.Button }
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize(), content = content)
    }
}

private class AidenComposerRetained<T : Any> {
    var value: T? = null
}

/**
 * Springs a composer banner (attachments, skill chip, suggestions, receipts) in and out.
 * While it collapses it keeps drawing the last non-null [value]; with reduced motion it
 * appears and disappears without animating.
 */
@Composable
internal fun <T : Any> AidenComposerReveal(
    value: T?,
    modifier: Modifier = Modifier,
    content: @Composable (T) -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val retained = remember { AidenComposerRetained<T>() }
    if (value != null) retained.value = value
    AnimatedVisibility(
        visible = value != null,
        modifier = modifier,
        enter = if (reduceMotion) {
            EnterTransition.None
        } else {
            expandVertically(AidenMotion.spatialExpressiveSpring(), expandFrom = Alignment.Bottom) +
                fadeIn(AidenMotion.nonSpatialExpressiveSpring())
        },
        exit = if (reduceMotion) {
            ExitTransition.None
        } else {
            shrinkVertically(AidenMotion.spatialExpressiveSpring(), shrinkTowards = Alignment.Bottom) +
                fadeOut(AidenMotion.nonSpatialExpressiveSpring())
        }
    ) {
        retained.value?.let { content(it) }
    }
}
