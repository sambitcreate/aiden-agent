package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.pow

/**
 * Material 3 Expressive and Aiden-tuned spring motion specifications.
 */
object AidenMotion {
    fun <T> spatialExpressiveSpring(): SpringSpec<T> = spring(
        dampingRatio = 0.8f,
        stiffness = 380f
    )

    fun <T> nonSpatialExpressiveSpring(): SpringSpec<T> = spring(
        dampingRatio = 1f,
        stiffness = 1600f
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
 * Hairline border with subtle opacity conforming to the Aiden design tokens.
 */
fun Modifier.hairlineBorder(
    color: Color,
    shape: Shape = RoundedCornerShape(12.dp),
    width: Dp = 0.5.dp
): Modifier = this.border(
    border = BorderStroke(width, color),
    shape = shape
)

/**
 * Gradient border for hero cards, active bots, and focused inputs.
 */
fun Modifier.gradientBorder(
    colors: List<Color>,
    shape: Shape = RoundedCornerShape(12.dp),
    width: Dp = 1.dp
): Modifier = this.border(
    width = width,
    brush = Brush.linearGradient(colors),
    shape = shape
)

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

/**
 * Smoothly animates gradient border appearance on active or selected cards.
 */
fun Modifier.fadeInGradientBorder(
    showBorder: Boolean,
    colors: List<Color>,
    shape: Shape = RoundedCornerShape(16.dp),
    borderWidth: Dp = 1.5.dp
): Modifier = composed {
    val animatedColors = List(colors.size) { i ->
        animateColorAsState(
            targetValue = if (showBorder) colors[i] else colors[i].copy(alpha = 0f),
            animationSpec = spring(dampingRatio = 0.8f, stiffness = 400f),
            label = "border_color_$i"
        ).value
    }
    this.border(
        width = borderWidth,
        brush = Brush.linearGradient(animatedColors),
        shape = shape
    )
}
