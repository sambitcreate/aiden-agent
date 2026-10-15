package sbtbiswas.AidenOnTheGo.ui.theme

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import kotlin.math.pow

/**
 * Aiden motion tokens.
 *
 * Spatial movement (slides, scale, size/shape morphs, drag settle) keeps Material 3
 * Expressive springs. Non-spatial changes (fades, color/opacity crossfades, short state
 * swaps) use the Untitled duration/easing tokens shared with the desktop renderer
 * (`--motion-duration` 200ms and the large 360ms step).
 *
 * The raw springs stay available for call sites that need a [SpringSpec]. UI code should
 * prefer the reduce-motion-aware variants ([spatial], [nonSpatial], [short], [long],
 * [snappy], [bouncy]), which collapse to [snap] when [aidenReduceMotion] is true.
 */
object AidenMotion {
    /** Untitled short step: 200ms, `cubic-bezier(0.16, 1, 0.3, 1)`. */
    const val ShortDurationMillis = 200

    /** Untitled long step: 360ms, `cubic-bezier(0.22, 1, 0.36, 1)`. */
    const val LongDurationMillis = 360

    val StandardEasing: Easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
    val EmphasizedEasing: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

    /** Short non-spatial transition. Collapses to an instant change under reduced motion. */
    fun <T> short(reduceMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else tween(ShortDurationMillis, easing = StandardEasing)

    /** Long non-spatial transition. Collapses to an instant change under reduced motion. */
    fun <T> long(reduceMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else tween(LongDurationMillis, easing = EmphasizedEasing)

    /** Reduced motion when the user opts in inside Aiden or turns system animations off. */
    fun isReducedMotion(appPreference: Boolean, systemAnimatorScale: Float): Boolean =
        appPreference || systemAnimatorScale == 0f

    fun <T> spatialExpressiveSpring(): SpringSpec<T> = spring(
        dampingRatio = 0.8f,
        stiffness = 380f
    )

    fun <T> bouncySpring(): SpringSpec<T> = spring(
        dampingRatio = Spring.DampingRatioLowBouncy,
        stiffness = Spring.StiffnessMediumLow
    )

    fun <T> snappySpring(): SpringSpec<T> = spring(
        dampingRatio = Spring.DampingRatioNoBouncy,
        stiffness = Spring.StiffnessMedium
    )

    /** Spring for movement, size, and shape changes; instant when motion is reduced. */
    fun <T> spatial(reduceMotion: Boolean): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else spatialExpressiveSpring()

    /** Color and opacity changes: the Untitled [short] step; instant when motion is reduced. */
    fun <T> nonSpatial(reduceMotion: Boolean): FiniteAnimationSpec<T> = short(reduceMotion)

    /** Critically damped spring for small indicators; instant when motion is reduced. */
    fun <T> snappy(reduceMotion: Boolean): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else snappySpring()

    /** Playful overshoot spring for hero moments; instant when motion is reduced. */
    fun <T> bouncy(reduceMotion: Boolean): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else bouncySpring()

    /** Scale a pressed surface settles at; 1f (no compression) when motion is reduced. */
    fun pressedScale(pressed: Boolean, reduceMotion: Boolean, targetScale: Float = 0.96f): Float =
        if (pressed && !reduceMotion) targetScale else 1f
}

/**
 * True when the user turned on Appearance → Reduce motion, or when the system animator
 * duration scale is off. Every spring, morph, infinite transition, and press compression
 * must hold still when this is true.
 */
@Composable
fun aidenReduceMotion(): Boolean {
    val configReduce = AidenTheme.config.reduceMotion
    val context = LocalContext.current
    val systemScale = remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
    }
    return AidenMotion.isReducedMotion(configReduce, systemScale)
}

/** Alias of [aidenReduceMotion] kept for the Untitled call sites. */
@Composable
fun rememberAidenReduceMotion(): Boolean = aidenReduceMotion()

/**
 * Adds a subtle, tactile scale compression on pointer down (0.96x).
 *
 * Pass [onClick] only when this modifier is the element's sole click handler; it then
 * also exposes button semantics. When the element already uses `clickable`, a `Button`,
 * or an `IconButton`, prefer the [InteractionSource] overload so a tap fires once.
 */
fun Modifier.tactilePress(
    targetScale: Float = 0.96f,
    onClick: (() -> Unit)? = null
): Modifier = composed {
    val reduceMotion = aidenReduceMotion()
    var isPressed by remember { mutableStateOf(false) }
    val currentOnClick by rememberUpdatedState(onClick)
    val scale by animateFloatAsState(
        targetValue = AidenMotion.pressedScale(isPressed, reduceMotion, targetScale),
        animationSpec = if (reduceMotion) snap() else spring(dampingRatio = 0.7f, stiffness = 500f),
        label = "tactile_scale"
    )

    val clickSemantics = if (onClick != null) {
        Modifier.semantics {
            role = Role.Button
            onClick { currentOnClick?.invoke(); true }
        }
    } else {
        Modifier
    }

    this
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .then(clickSemantics)
        .pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown().also { isPressed = true }
                val up = waitForUpOrCancellation()
                isPressed = false
                if (up != null) currentOnClick?.invoke()
            }
        }
}

/**
 * Press compression driven by an existing [InteractionSource], so it pairs with
 * `clickable`, `Button`, or `Surface(onClick)` without registering a second tap handler.
 */
fun Modifier.tactilePress(
    interactionSource: InteractionSource,
    targetScale: Float = 0.96f
): Modifier = composed {
    val reduceMotion = aidenReduceMotion()
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = AidenMotion.pressedScale(pressed, reduceMotion, targetScale),
        animationSpec = if (reduceMotion) snap() else spring(dampingRatio = 0.7f, stiffness = 500f),
        label = "tactile_scale"
    )
    graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/**
 * Exponential vertical scrim with natural curve decay (prevents banding on glass headers/footers).
 */
fun Modifier.exponentialVerticalScrim(
    color: Color,
    startYPercentage: Float = 0f,
    endYPercentage: Float = 1f,
    decay: Float = 1.8f,
    numStops: Int = 16
): Modifier = this.drawWithCache {
    val brush = Brush.verticalGradient(
        colors = exponentialScrimColors(color, decay, numStops, startYPercentage < endYPercentage)
    )
    onDrawWithContent {
        drawContent()
        val top = size.height * minOf(startYPercentage, endYPercentage)
        val height = size.height * kotlin.math.abs(endYPercentage - startYPercentage)
        drawRect(brush = brush, topLeft = Offset(0f, top), size = Size(size.width, height))
    }
}

/**
 * Gradient stops for [exponentialVerticalScrim]: transparent at the leading edge and
 * reaching [color] at the trailing edge along an `x^decay` curve.
 */
fun exponentialScrimColors(
    color: Color,
    decay: Float = 1.8f,
    numStops: Int = 16,
    ascending: Boolean = true
): List<Color> {
    val colors = List(numStops) { i ->
        val x = i.toFloat() / (numStops - 1)
        color.copy(alpha = color.alpha * x.pow(decay))
    }
    return if (ascending) colors else colors.reversed()
}
