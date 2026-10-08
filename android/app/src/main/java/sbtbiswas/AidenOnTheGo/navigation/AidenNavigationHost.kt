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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.currentAidenWindowWidthClass
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

    /**
     * Opens [screen] from the product shell. On a phone the shell is only visible at the
     * root, so this is a push; beside a detail pane it replaces whatever the pane held
     * instead of stacking on top of it.
     */
    fun openFromShell(screen: AidenScreen) = navigate(stack.resetTo(screen))

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
 *
 * On expanded windows the shell and the chats it opened share the window as a
 * list-detail layout (see [aidenNavigationScene]); chat changes then animate, and
 * predictive back scrubs, inside the detail pane while the shell stays put.
 */
@Composable
fun AidenNavigationHost(
    navigator: AidenNavigator,
    reduceMotion: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable (AidenScreen) -> Unit
) {
    val widthClass = currentAidenWindowWidthClass()
    val scene = aidenNavigationScene(navigator.stack, widthClass)
    val sceneState = remember { SeekableTransitionState(scene) }
    val sceneTransition = rememberTransition(sceneState, label = "ScreenTransition")
    // The detail pane keeps its last chat while another scene covers the window, so
    // returning to the list-detail layout shows it without a second transition.
    val detailState = remember { SeekableTransitionState((scene as? AidenNavigationScene.ListDetail)?.detail) }
    val detailTransition = rememberTransition(detailState, label = "DetailPaneTransition")
    val gesture = remember { PredictiveBackGestureState() }
    val scope = rememberCoroutineScope()
    val currentReduceMotion by rememberUpdatedState(reduceMotion)
    val currentWidthClass by rememberUpdatedState(widthClass)
    val axisOffsetPx = with(LocalDensity.current) { SharedAxisOffset.roundToPx() }

    val settledWidthClass = remember { arrayOf(widthClass) }
    LaunchedEffect(scene) {
        // A live back gesture owns the transitions and settles them itself; animating
        // here would retarget a transition away from the screen it is revealing.
        if (gesture.ownsTransition) return@LaunchedEffect
        // A resized window (a fold opening, split screen) relayouts in place rather
        // than sliding as if the user had navigated.
        val resized = settledWidthClass[0] != currentWidthClass
        settledWidthClass[0] = currentWidthClass
        // Also finishes a released back gesture from wherever the finger left it.
        sceneState.settleTo(scene, currentReduceMotion || resized)
        if (!gesture.inProgress && !gesture.inDetailPane) gesture.reset()
    }
    val listDetail = scene as? AidenNavigationScene.ListDetail
    LaunchedEffect(listDetail) {
        if (listDetail == null || gesture.ownsTransition) return@LaunchedEffect
        // Entering the layout (a pop back to it, or the window widening) shows the
        // chat at once; only changes within the layout animate in the pane.
        val entering = sceneState.currentState !is AidenNavigationScene.ListDetail
        detailState.settleTo(listDetail.detail, currentReduceMotion || entering)
        if (!gesture.inProgress && gesture.inDetailPane) gesture.reset()
    }

    PredictiveBackHandler(enabled = navigator.stack.canPop) { events ->
        val origin = navigator.stack
        val from = aidenNavigationScene(origin, currentWidthClass)
        val to = origin.pop()?.let { aidenNavigationScene(it, currentWidthClass) }
        // Popping a chat inside the list-detail layout scrubs the detail pane alone.
        val inPane = from is AidenNavigationScene.ListDetail && to is AidenNavigationScene.ListDetail
        val fromDetail = (from as? AidenNavigationScene.ListDetail)?.detail
        val toDetail = (to as? AidenNavigationScene.ListDetail)?.detail
        var seeking = false
        try {
            events.collect { event ->
                if (to == null || currentReduceMotion) return@collect
                if (!seeking) {
                    seeking = true
                    gesture.ownsTransition = true
                    // A gesture can start before the push that opened this screen has
                    // finished (or even started) animating. Land that push first so the
                    // gesture scrubs from the current screen towards the one below it.
                    sceneState.landOn(from)
                    if (inPane) detailState.landOn(fromDetail)
                    val leavingKey = if (inPane) fromDetail?.stateKey ?: from.key else from.key
                    gesture.begin(leavingKey, event.swipeEdge, detailPane = inPane)
                }
                gesture.progress.snapTo(event.progress)
                val fraction = predictiveBackSeekFraction(event.progress)
                if (inPane) detailState.seekTo(fraction, toDetail) else sceneState.seekTo(fraction, to)
            }
            gesture.inProgress = false
            gesture.ownsTransition = false
            if (navigator.stack == origin) {
                navigator.back()
            } else if (seeking) {
                // Something else navigated mid-gesture; its own transition was held back above.
                scope.launch {
                    val now = aidenNavigationScene(navigator.stack, currentWidthClass)
                    sceneState.settleTo(now, currentReduceMotion)
                    if (now is AidenNavigationScene.ListDetail) detailState.snapTo(now.detail)
                    gesture.reset()
                }
            }
        } catch (cancelled: CancellationException) {
            gesture.inProgress = false
            gesture.ownsTransition = false
            if (seeking && to != null) {
                // The handler's own job is cancelled with the gesture, so settle on the host's scope.
                scope.launch {
                    if (inPane) {
                        gesture.settleCancelled(detailState, toDetail) {
                            (aidenNavigationScene(navigator.stack, currentWidthClass) as? AidenNavigationScene.ListDetail)?.detail
                        }
                    } else {
                        gesture.settleCancelled(sceneState, to) { aidenNavigationScene(navigator.stack, currentWidthClass) }
                    }
                }
            }
            throw cancelled
        }
    }

    @Composable
    fun Entry(screen: AidenScreen) {
        navigator.entryStates.SaveableStateProvider(screen.stateKey) {
            // A screen revealed by a back gesture, or still animating out, is composed
            // but not yet (or no longer) the committed destination.
            CompositionLocalProvider(LocalAidenIsCommittedDestination provides (screen.stateKey in scene.screenKeys)) {
                content(screen)
            }
        }
    }

    sceneTransition.AnimatedContent(
        modifier = modifier,
        contentKey = { it.key },
        transitionSpec = {
            when {
                reduceMotion -> ContentTransform(EnterTransition.None, ExitTransition.None, sizeTransform = null)
                gesture.inProgress && !gesture.inDetailPane -> predictiveBackTransform(axisOffsetPx)
                else -> sharedAxisX(forward = !navigator.isNavigatingBack, offsetPx = axisOffsetPx)
            }
        }
    ) { shown ->
        // A screen moving between layouts (the window widened or narrowed) is composed
        // only by the layout it is moving to: one saved-state key, one composition.
        val target = sceneTransition.targetState
        val composes = { key: String -> shown.key == target.key || key !in target.screenKeys }
        Box(
            modifier = Modifier.predictiveBackDepth(gesture, shown.key, reduceMotion),
            propagateMinConstraints = true
        ) {
            when (shown) {
                is AidenNavigationScene.Single -> if (composes(shown.screen.stateKey)) Entry(shown.screen)
                is AidenNavigationScene.ListDetail -> Row(Modifier.fillMaxSize()) {
                    Box(Modifier.width(AidenListPaneWidth).fillMaxHeight(), propagateMinConstraints = true) {
                        if (composes(AidenScreen.ProductShell.stateKey)) Entry(AidenScreen.ProductShell)
                    }
                    VerticalDivider(color = AidenTheme.palette.raised)
                    detailTransition.AnimatedContent(
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                        contentKey = { it?.stateKey ?: DetailPlaceholderKey },
                        transitionSpec = {
                            when {
                                reduceMotion -> ContentTransform(EnterTransition.None, ExitTransition.None, sizeTransform = null)
                                gesture.inProgress && gesture.inDetailPane -> predictiveBackTransform(axisOffsetPx)
                                else -> sharedAxisX(forward = !navigator.isNavigatingBack, offsetPx = axisOffsetPx)
                            }
                        }
                    ) { detail ->
                        if (detail == null) {
                            AidenDetailPlaceholder()
                        } else if (composes(detail.stateKey)) {
                            Box(
                                modifier = Modifier.predictiveBackDepth(gesture, detail.stateKey, reduceMotion),
                                propagateMinConstraints = true
                            ) {
                                // The list pane already leads back from the chat it opened.
                                CompositionLocalProvider(
                                    LocalAidenShowsUpNavigation provides !navigator.stack.opensFromShell(detail)
                                ) {
                                    Entry(detail)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * False while a screen sits in a pane whose neighbour already leads back (the chat
 * beside the shell's list), so it hides its own up/back arrow. System back still
 * pops it.
 */
val LocalAidenShowsUpNavigation = compositionLocalOf { true }

/**
 * True only for a screen that belongs to the committed navigation stack. Side effects that
 * mean "the user is looking at this" (marking a chat read, quieting its notification) must
 * wait for it, since predictive back composes the previous screen before the pop commits.
 */
val LocalAidenIsCommittedDestination = compositionLocalOf { true }

/** M3 list pane width beside a detail pane. */
val AidenListPaneWidth = 360.dp

private const val DetailPlaceholderKey = "detail-placeholder"

@Composable
private fun AidenDetailPlaceholder() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        AidenEmptyState(
            icon = Icons.Outlined.ChatBubbleOutline,
            title = stringResource(R.string.navigation_detail_placeholder_title),
            body = stringResource(R.string.navigation_detail_placeholder_body)
        )
    }
}

/** Animates (or, with [snap], jumps) to [target] unless already settled there. */
private suspend fun <S> SeekableTransitionState<S>.settleTo(target: S, snap: Boolean) {
    if (snap) snapTo(target) else animateTo(target, NavigationFractionSpec)
}

/** Lands any in-flight transition on [state] so a gesture can scrub from it. */
private suspend fun <S> SeekableTransitionState<S>.landOn(state: S) {
    if (currentState != state || targetState != state) snapTo(state)
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

private fun <S> AnimatedContentTransitionScope<S>.sharedAxisX(forward: Boolean, offsetPx: Int): ContentTransform {
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
private fun <S> AnimatedContentTransitionScope<S>.predictiveBackTransform(offsetPx: Int): ContentTransform {
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

    /** While true, stack changes do not start their own transition; the gesture settles it. */
    var ownsTransition = false

    /** Whether the gesture scrubs the detail pane's transition rather than the whole window's. */
    var inDetailPane by mutableStateOf(false)
        private set

    fun begin(key: String, edge: Int, detailPane: Boolean) {
        leavingKey = key
        swipeEdge = edge
        inDetailPane = detailPane
        inProgress = true
    }

    suspend fun reset() {
        progress.snapTo(0f)
        leavingKey = null
    }

    /** Scrubs a cancelled gesture back to rest, then drops the revealed screen. */
    suspend fun <S> settleCancelled(
        transitionState: SeekableTransitionState<S>,
        previous: S,
        current: () -> S
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
