package sbtbiswas.AidenOnTheGo.navigation

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlin.math.sign

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
 *
 * Pushes and pops use the Material 3 shared-axis X pattern: the incoming screen
 * slides in from the end (from the start on a pop) while the two fade through
 * each other. A predictive back gesture scrubs the pop: the screen underneath is
 * composed and revealed while the departing screen recedes with the finger.
 * Cancelling settles back; releasing finishes that same transition rather than
 * starting a new one, so neither screen is recreated.
 */
@Composable
fun AidenNavigationHost(
    navigator: AidenNavigator,
    reduceMotion: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable (AidenScreen) -> Unit
) {
    val transitionState = remember { SeekableTransitionState(navigator.stack.current) }
    val transition = rememberTransition(transitionState, label = "ScreenTransition")
    val gesture = remember { PredictiveBackGestureState() }
    val scope = rememberCoroutineScope()
    val currentReduceMotion by rememberUpdatedState(reduceMotion)
    val axisOffsetPx = with(LocalDensity.current) { SharedAxisOffset.roundToPx() }

    val target = navigator.stack.current
    LaunchedEffect(target) {
        // Also finishes a released back gesture from wherever the finger left it.
        if (currentReduceMotion) {
            transitionState.snapTo(target)
        } else {
            transitionState.animateTo(target, NavigationFractionSpec)
        }
        if (!gesture.inProgress) gesture.reset()
    }

    PredictiveBackHandler(enabled = navigator.stack.canPop) { events ->
        val origin = navigator.stack
        val previous = origin.pop()?.current
        var seeking = false
        try {
            events.collect { event ->
                if (previous == null || currentReduceMotion) return@collect
                if (!seeking) {
                    seeking = true
                    gesture.begin(origin.current.stateKey, event.swipeEdge)
                }
                gesture.progress.snapTo(event.progress)
                transitionState.seekTo(predictiveBackSeekFraction(event.progress), previous)
            }
            gesture.inProgress = false
            if (navigator.stack == origin) navigator.back()
        } catch (cancelled: CancellationException) {
            gesture.inProgress = false
            if (seeking && previous != null) {
                // The handler's own job is cancelled with the gesture, so settle on the host's scope.
                scope.launch { gesture.settleCancelled(transitionState, previous) { navigator.stack.current } }
            }
            throw cancelled
        }
    }

    transition.AnimatedContent(
        modifier = modifier,
        contentKey = { it.stateKey },
        transitionSpec = {
            when {
                reduceMotion -> ContentTransform(EnterTransition.None, ExitTransition.None, sizeTransform = null)
                gesture.inProgress -> predictiveBackTransform(axisOffsetPx)
                else -> sharedAxisX(forward = !navigator.isNavigatingBack, offsetPx = axisOffsetPx)
            }
        }
    ) { screen ->
        Box(
            modifier = Modifier.predictiveBackDepth(gesture, screen.stateKey, reduceMotion),
            propagateMinConstraints = true
        ) {
            navigator.entryStates.SaveableStateProvider(screen.stateKey) {
                content(screen)
            }
        }
    }
}

/** M3 shared-axis transition length; [NavigationFractionSpec] eases it as a whole. */
private const val SharedAxisDurationMillis = 300

/** Fade-through split: the outgoing screen is gone by here, then the incoming one fades in. */
private const val FadeOutDurationMillis = 105

/** M3 shared-axis travel distance. */
private val SharedAxisOffset = 30.dp

/** M3 emphasized easing. */
private val EmphasizedEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/**
 * Child animations run linearly in transition time so a predictive back gesture can
 * scrub them in step with the finger; this curve then eases the whole transition
 * whenever it plays on its own (push, pop, or a released gesture).
 */
private val NavigationFractionSpec = tween<Float>(SharedAxisDurationMillis, easing = EmphasizedEasing)

/**
 * Portion of the pop transition a predictive back gesture scrubs before release:
 * enough to fade the screen underneath in fully and start its parallax, while the
 * departing screen stays opaque so it reads as a card being pulled away.
 */
const val PredictiveBackSeekLimit = 0.35f

/** Transition fraction for a predictive back gesture at [progress] (0..1). */
fun predictiveBackSeekFraction(progress: Float): Float = progress.coerceIn(0f, 1f) * PredictiveBackSeekLimit

private fun AnimatedContentTransitionScope<AidenScreen>.sharedAxisX(forward: Boolean, offsetPx: Int): ContentTransform {
    val towards = if (forward) SlideDirection.Start else SlideDirection.End
    val slide = tween<IntOffset>(SharedAxisDurationMillis, easing = LinearEasing)
    return ContentTransform(
        targetContentEnter = slideIntoContainer(towards, slide) { it.sign * offsetPx } + fadeIn(
            tween(SharedAxisDurationMillis - FadeOutDurationMillis, delayMillis = FadeOutDurationMillis, easing = LinearEasing)
        ),
        initialContentExit = slideOutOfContainer(towards, slide) { it.sign * offsetPx } + fadeOut(
            tween(FadeOutDurationMillis, easing = LinearEasing)
        ),
        sizeTransform = null
    )
}

/**
 * The pop a predictive back gesture scrubs. The screen underneath fades in within the
 * scrubbed range and drifts in from the start; the departing screen, which
 * [predictiveBackDepth] shrinks and shifts with the finger, only fades once released.
 */
private fun AnimatedContentTransitionScope<AidenScreen>.predictiveBackTransform(offsetPx: Int): ContentTransform {
    val scrubbedMillis = (SharedAxisDurationMillis * PredictiveBackSeekLimit).toInt()
    return ContentTransform(
        targetContentEnter = slideIntoContainer(
            SlideDirection.End,
            tween(SharedAxisDurationMillis, easing = LinearEasing)
        ) { it.sign * offsetPx } + fadeIn(tween(scrubbedMillis, easing = LinearEasing)),
        initialContentExit = fadeOut(
            tween(SharedAxisDurationMillis - scrubbedMillis, delayMillis = scrubbedMillis, easing = LinearEasing)
        ),
        // The previous screen is revealed underneath the one being pulled away.
        targetContentZIndex = -1f,
        sizeTransform = null
    )
}

/** Gesture-driven visuals for the screen a predictive back gesture is pulling away. */
@Stable
private class PredictiveBackGestureState {
    val progress = Animatable(0f)
    var leavingKey by mutableStateOf<String?>(null)
        private set
    var swipeEdge by mutableIntStateOf(BackEventCompat.EDGE_LEFT)
        private set
    var inProgress by mutableStateOf(false)

    fun begin(key: String, edge: Int) {
        leavingKey = key
        swipeEdge = edge
        inProgress = true
    }

    suspend fun reset() {
        progress.snapTo(0f)
        leavingKey = null
    }

    /** Scrubs a cancelled gesture back to rest, then drops the revealed screen. */
    suspend fun settleCancelled(
        transitionState: SeekableTransitionState<AidenScreen>,
        previous: AidenScreen,
        current: () -> AidenScreen
    ) {
        coroutineScope {
            val scrub = launch {
                snapshotFlow { progress.value }.collect {
                    transitionState.seekTo(predictiveBackSeekFraction(it), previous)
                }
            }
            progress.animateTo(0f, tween(200, easing = EmphasizedEasing))
            scrub.cancel()
        }
        transitionState.snapTo(current())
        leavingKey = null
    }
}

private fun Modifier.predictiveBackDepth(
    gesture: PredictiveBackGestureState,
    key: String,
    reduceMotion: Boolean
): Modifier = graphicsLayer {
    // Read inside the layer block so gesture frames redraw without recomposing the screen.
    if (gesture.leavingKey != key) return@graphicsLayer
    val progress = gesture.progress.value
    val depth = predictiveBackDepth(progress, reduceMotion)
    scaleX = depth.scale
    scaleY = depth.scale
    translationX = predictiveBackShift(
        progress = progress,
        widthPx = size.width,
        edgeMarginPx = PredictiveBackEdgeMargin.toPx(),
        swipeEdge = gesture.swipeEdge,
        reduceMotion = reduceMotion
    )
    if (depth.cornerRadius > 0.dp) {
        // The departing screen detaches as a rounded, softly elevated surface.
        shape = RoundedCornerShape(depth.cornerRadius)
        clip = true
        shadowElevation = depth.shadowElevation.toPx()
    }
}

/** Gap M3 keeps between a fully pulled predictive back surface and the screen edge. */
private val PredictiveBackEdgeMargin = 8.dp

/** Visual depth of the receding screen during a predictive back gesture. */
data class AidenPredictiveBackDepth(
    val scale: Float,
    val cornerRadius: Dp,
    val shadowElevation: Dp
)

/**
 * Maps predictive back [progress] (0..1) to scale, corner radius, and shadow. The
 * screen settles at the M3 90% scale. Reduced motion keeps the screen still and square.
 */
fun predictiveBackDepth(progress: Float, reduceMotion: Boolean): AidenPredictiveBackDepth {
    val p = progress.coerceIn(0f, 1f)
    if (reduceMotion || p == 0f) return AidenPredictiveBackDepth(1f, 0.dp, 0.dp)
    return AidenPredictiveBackDepth(
        scale = 1f - 0.1f * p,
        cornerRadius = (28f * p).dp,
        shadowElevation = (16f * p).dp
    )
}

/**
 * Horizontal shift, in pixels, of the receding screen: it follows the finger away from
 * the edge the gesture started on, up to a twentieth of its width less [edgeMarginPx],
 * per M3 predictive back. A gesture without an edge only shrinks the screen.
 */
fun predictiveBackShift(
    progress: Float,
    widthPx: Float,
    edgeMarginPx: Float,
    swipeEdge: Int,
    reduceMotion: Boolean
): Float {
    if (reduceMotion) return 0f
    val direction = when (swipeEdge) {
        BackEventCompat.EDGE_LEFT -> 1f
        BackEventCompat.EDGE_RIGHT -> -1f
        else -> return 0f
    }
    val maxShift = (widthPx / 20f - edgeMarginPx).coerceAtLeast(0f)
    return direction * maxShift * progress.coerceIn(0f, 1f)
}
