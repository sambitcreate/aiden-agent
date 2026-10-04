package sbtbiswas.AidenOnTheGo.navigation

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion

/** Owns the saveable back stack and the per-entry UI state of the screens on it. */
@Stable
class AidenNavigator internal constructor(
    private val state: MutableState<AidenNavigationStack>,
    internal val entryStates: SaveableStateHolder
) {
    val stack: AidenNavigationStack get() = state.value

    /** Whether the most recent change removed screens, which picks the transition direction. */
    var isNavigatingBack by mutableStateOf(false)
        private set

    fun navigate(next: AidenNavigationStack) {
        val previous = state.value
        if (next == previous) return
        next.discardedFrom(previous).forEach { entryStates.removeState(it.stateKey) }
        isNavigatingBack = next.isBackFrom(previous)
        state.value = next
    }

    fun push(screen: AidenScreen) = navigate(stack.push(screen))

    fun back() {
        stack.pop()?.let(::navigate)
    }
}

@Composable
fun rememberAidenNavigator(): AidenNavigator {
    val state = rememberSaveable(stateSaver = AidenNavigationStack.Saver) {
        mutableStateOf(AidenNavigationStack.Root)
    }
    val entryStates = rememberSaveableStateHolder()
    return remember(state, entryStates) { AidenNavigator(state, entryStates) }
}

/**
 * Hosts the current screen. System back (including the predictive gesture)
 * pops one screen; at the root it falls through so the app can close. Screens
 * with their own in-screen back targets register a [androidx.activity.compose.BackHandler],
 * which takes precedence while it is enabled.
 */
@Composable
fun AidenNavigationHost(
    navigator: AidenNavigator,
    reduceMotion: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable (AidenScreen) -> Unit
) {
    var backProgress by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler(enabled = navigator.stack.canPop) { events ->
        try {
            events.collect { backProgress = it.progress }
            navigator.back()
        } finally {
            backProgress = 0f
        }
    }

    AnimatedContent(
        targetState = navigator.stack.current,
        contentKey = { it.stateKey },
        label = "ScreenTransition",
        modifier = modifier.graphicsLayer {
            // Predictive back: the departing screen recedes with the gesture.
            if (!reduceMotion) {
                val scale = 1f - 0.08f * backProgress
                scaleX = scale
                scaleY = scale
            }
        },
        transitionSpec = {
            if (navigator.isNavigatingBack) {
                (slideInVertically(
                    initialOffsetY = { -it / 10 },
                    animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                ) + fadeIn(AidenMotion.nonSpatialExpressiveSpring<Float>())).togetherWith(
                    slideOutVertically(
                        targetOffsetY = { it / 10 },
                        animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                    ) + fadeOut(AidenMotion.nonSpatialExpressiveSpring<Float>())
                )
            } else {
                (slideInVertically(
                    initialOffsetY = { it / 8 },
                    animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                ) + fadeIn(AidenMotion.nonSpatialExpressiveSpring<Float>())).togetherWith(
                    slideOutVertically(
                        targetOffsetY = { -it / 8 },
                        animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                    ) + fadeOut(AidenMotion.nonSpatialExpressiveSpring<Float>())
                )
            }
        }
    ) { screen ->
        navigator.entryStates.SaveableStateProvider(screen.stateKey) {
            content(screen)
        }
    }
}
