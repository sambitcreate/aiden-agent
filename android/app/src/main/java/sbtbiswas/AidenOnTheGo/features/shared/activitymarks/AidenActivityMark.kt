package sbtbiswas.AidenOnTheGo.features.shared.activitymarks

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

const val AIDEN_ACTIVITY_MARK_TEST_TAG = "aiden-activity-mark"

private const val VIEW_BOX = 24f
private const val DEFAULT_AMP2 = 3f

/**
 * Aiden's activity mark. Draws one of the shared marks from docs/activity-marks.md.
 *
 * The frame clock lives in a state object that only the draw pass reads, so each
 * frame invalidates drawing and never recomposes. A frozen mark (inactive, or Reduced
 * Motion on) holds its t = 0 pose and runs no frame loop.
 *
 * [level] (0..1) sizes Helix · Swell's second wave in five steps. Other marks ignore it.
 */
@Composable
fun AidenActivityMark(
    mark: AidenActivityMarkKind,
    modifier: Modifier = Modifier,
    size: Dp = 20.dp,
    active: Boolean = true,
    color: Color = AidenTheme.palette.foreground,
    level: Float? = null,
) {
    val spec = remember(mark) { mark.spec() }
    val animate = active && !aidenReduceMotion()
    val clockMs = remember { mutableLongStateOf(0L) }

    LaunchedEffect(animate) {
        if (!animate) {
            clockMs.longValue = 0L
            return@LaunchedEffect
        }
        var startMs = Long.MIN_VALUE
        while (true) {
            withFrameMillis { frameMs ->
                if (startMs == Long.MIN_VALUE) startMs = frameMs
                clockMs.longValue = frameMs - startMs
            }
        }
    }

    // Same five steps as the desktop CSS: amp2 = 1 + round(level × 4).
    val amp2 = if (level != null && !level.isNaN()) 1f + Math.round(level.coerceIn(0f, 1f) * 4f) else DEFAULT_AMP2

    Canvas(
        modifier = modifier
            .size(size)
            // Whole-mark alpha (Helix · Flat) composites once, like the desktop's group
            // opacity, so its overlapping strands don't darken each other.
            .then(if (spec.overallAlpha < 1f) Modifier.graphicsLayer { alpha = spec.overallAlpha } else Modifier)
            .testTag(AIDEN_ACTIVITY_MARK_TEST_TAG)
            .clearAndSetSemantics {},
    ) {
        // The only read of the clock. It happens in the draw phase.
        drawActivityMark(spec, clockMs.longValue, amp2, color, this.size.minDimension / VIEW_BOX)
    }
}

private fun DrawScope.drawActivityMark(
    spec: AidenActivityMarkSpec,
    timeMs: Long,
    amp2: Float,
    color: Color,
    unit: Float,
) {
    withTransform({ scale(unit, unit, Offset.Zero) }) {
        for (shape in spec.shapes) {
            var groupTranslateX = 0f
            var groupRotation = 0f
            var groupOriginX = 0f
            var groupOriginY = 0f
            if (shape.groupIndex >= 0) {
                val group = spec.groups[shape.groupIndex]
                groupOriginX = group.originX
                groupOriginY = group.originY
                group.track(AidenActivityMarkProperty.TRANSLATE_X)?.let { groupTranslateX = it.valueAt(timeMs) }
                group.track(AidenActivityMarkProperty.ROTATION_DEG)?.let { groupRotation = it.valueAt(timeMs) }
            }

            var translateX = 0f
            var translateY = 0f
            var rotation = 0f
            var scaleX = 1f
            var scaleY = 1f
            var opacity = 1f
            shape.track(AidenActivityMarkProperty.TRANSLATE_X)?.let { translateX = it.valueAt(timeMs) }
            shape.track(AidenActivityMarkProperty.TRANSLATE_Y)?.let { translateY = it.valueAt(timeMs) }
            shape.track(AidenActivityMarkProperty.ROTATION_DEG)?.let { rotation = it.valueAt(timeMs) }
            shape.track(AidenActivityMarkProperty.SCALE)?.let {
                val uniform = it.valueAt(timeMs)
                scaleX *= uniform
                scaleY *= uniform
            }
            shape.track(AidenActivityMarkProperty.SCALE_X)?.let { scaleX *= it.valueAt(timeMs) }
            shape.track(AidenActivityMarkProperty.SCALE_Y)?.let { scaleY *= it.valueAt(timeMs) }
            shape.track(AidenActivityMarkProperty.OPACITY)?.let { opacity = it.valueAt(timeMs) }
            shape.secondWave?.let { translateY += it.valueAt(timeMs) * amp2 }

            val alpha = opacity * shape.strandAlpha
            val pivot = Offset(shape.pivotX, shape.pivotY)
            val groupOrigin = Offset(groupOriginX, groupOriginY)

            // Group first (outermost), then the shape's own translate, rotate and scale.
            withTransform({
                if (shape.groupIndex >= 0) {
                    translate(groupTranslateX, 0f)
                    rotate(groupRotation, groupOrigin)
                }
                translate(translateX, translateY)
                rotate(rotation, pivot)
                scale(scaleX, scaleY, pivot)
            }) {
                when (val geometry = shape.geometry) {
                    is AidenActivityMarkGeometry.Circle -> drawCircle(
                        color = color,
                        radius = geometry.r,
                        center = Offset(geometry.cx, geometry.cy),
                        alpha = alpha,
                    )
                    is AidenActivityMarkGeometry.RoundRect -> drawRoundRect(
                        color = color,
                        topLeft = Offset(geometry.x, geometry.y),
                        size = geometry.size,
                        cornerRadius = geometry.corner,
                        alpha = alpha,
                    )
                }
            }
        }
    }
}
