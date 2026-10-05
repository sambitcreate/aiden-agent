package sbtbiswas.AidenOnTheGo.ui.theme

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import kotlin.math.pow

/**
 * Aiden motion tokens.
 *
 * Spatial movement (slides, scale, drag settle) keeps Material 3 Expressive springs.
 * Non-spatial changes (fades, color/opacity crossfades, short state swaps) use the
 * Untitled duration/easing tokens shared with the desktop renderer
 * (`--motion-duration` 200ms and the large 360ms step).
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
}

/**
 * Whether motion should be reduced, combining Aiden's Reduce Motion setting with the
 * system "Remove animations" / animator duration scale.
 */
@Composable
fun rememberAidenReduceMotion(): Boolean {
    val appPreference = AidenTheme.config.reduceMotion
    val context = LocalContext.current
    val systemScale = remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
    }
    return AidenMotion.isReducedMotion(appPreference, systemScale)
}

/**
 * Adds a subtle, tactile scale compression effect on pointer touch down (0.96x).
 */
fun Modifier.tactilePress(
    targetScale: Float = 0.96f,
    onClick: (() -> Unit)? = null
): Modifier = composed {
    var isPressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (isPressed) targetScale else 1f,
        animationSpec = spring(
            dampingRatio = 0.7f,
            stiffness = 500f
        ),
        label = "tactile_scale"
    )

    this
        .scale(scale)
        .pointerInput(onClick) {
            awaitEachGesture {
                awaitFirstDown().also { isPressed = true }
                val up = waitForUpOrCancellation()
                isPressed = false
                if (up != null && onClick != null) {
                    onClick()
                }
            }
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
    val colors = List(numStops) { i ->
        val x = i.toFloat() / (numStops - 1)
        val opacity = x.pow(decay)
        color.copy(alpha = color.alpha * opacity)
    }
    val brush = Brush.verticalGradient(
        colors = if (startYPercentage < endYPercentage) colors else colors.reversed()
    )
    onDrawWithContent {
        drawContent()
        val top = size.height * minOf(startYPercentage, endYPercentage)
        val height = size.height * kotlin.math.abs(endYPercentage - startYPercentage)
        drawRect(brush = brush, topLeft = Offset(0f, top), size = Size(size.width, height))
    }
}
