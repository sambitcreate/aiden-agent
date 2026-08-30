package sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import kotlin.math.*

enum class OrbState(val label: String) {
    IDLE("Idle"),
    WORKING("Working"),
    THINKING("Thinking"),
    STREAMING("Streaming"),
    SUCCESS("Completed"),
    ERROR("Error"),
    PAUSED("Paused")
}

enum class OrbSize(val dp: Dp, val points: Double) {
    PX16(16.dp, 16.0),
    PX20(20.dp, 20.0),
    PX24(24.dp, 24.0),
    PX32(32.dp, 32.0),
    PX48(48.dp, 48.0),
    PX64(64.dp, 64.0),
    PX96(96.dp, 96.0),
    PX128(128.dp, 128.0)
}

data class OrbDot(
    val x: Double,
    val y: Double,
    val z: Double,
    val r: Double,
    val white: Double,
    val alpha: Double
)

data class OrbLine(
    val x1: Double,
    val y1: Double,
    val x2: Double,
    val y2: Double,
    val alpha: Double,
    val strokeWidth: Double
)

object ThinkingOrbMath {
    fun renderFrame(
        state: OrbState,
        size: Double,
        t: Double,
        isDark: Boolean,
        accentColor: Color
    ): Pair<List<OrbLine>, List<OrbDot>> {
        val cx = size / 2.0
        val cy = size / 2.0
        val baseRadius = size * 0.38
        val dots = mutableListOf<OrbDot>()
        val lines = mutableListOf<OrbLine>()

        val nodeCount = when (state) {
            OrbState.IDLE -> 18
            OrbState.WORKING -> 32
            OrbState.THINKING -> 42
            OrbState.STREAMING -> 36
            OrbState.SUCCESS -> 24
            OrbState.ERROR -> 24
            OrbState.PAUSED -> 16
        }

        val speed = when (state) {
            OrbState.IDLE -> 0.8
            OrbState.WORKING -> 1.5
            OrbState.THINKING -> 2.2
            OrbState.STREAMING -> 1.8
            OrbState.SUCCESS -> 0.5
            OrbState.ERROR -> 0.3
            OrbState.PAUSED -> 0.0
        }

        val animT = t * speed

        for (i in 0 until nodeCount) {
            val phi = acos(1.0 - 2.0 * (i + 0.5) / nodeCount)
            val theta = Math.PI * (1.0 + sqrt(5.0)) * i + animT * 0.5

            val wobble = sin(animT * 2.0 + i * 0.6) * (baseRadius * 0.15)
            val r = baseRadius + wobble

            val x3 = r * sin(phi) * cos(theta)
            val y3 = r * cos(phi)
            val z3 = r * sin(phi) * sin(theta)

            // Tilt and Yaw rotation
            val tilt = 0.35
            val cosTilt = cos(tilt)
            val sinTilt = sin(tilt)

            val yRot = y3 * cosTilt - z3 * sinTilt
            val zRot = y3 * sinTilt + z3 * cosTilt

            val xProj = cx + x3
            val yProj = cy + yRot

            val depth = (zRot + baseRadius) / (2.0 * baseRadius)
            val dotRadius = max(0.8, (size * 0.035) * (0.6 + 0.6 * depth))
            val alpha = (0.3 + 0.7 * depth).coerceIn(0.1, 1.0)

            dots.add(OrbDot(x = xProj, y = yProj, z = zRot, r = dotRadius, white = depth, alpha = alpha))
        }

        // Web connections between nearby dots
        if (state == OrbState.THINKING || state == OrbState.WORKING || state == OrbState.STREAMING) {
            val maxDist = size * 0.28
            for (i in dots.indices) {
                for (j in (i + 1) until dots.size) {
                    val d1 = dots[i]
                    val d2 = dots[j]
                    val dist = hypot(d1.x - d2.x, d1.y - d2.y)
                    if (dist < maxDist) {
                        val lineAlpha = ((1.0 - dist / maxDist) * 0.4 * min(d1.alpha, d2.alpha)).coerceIn(0.0, 1.0)
                        lines.add(
                            OrbLine(
                                x1 = d1.x,
                                y1 = d1.y,
                                x2 = d2.x,
                                y2 = d2.y,
                                alpha = lineAlpha,
                                strokeWidth = max(0.5, size * 0.015)
                            )
                        )
                    }
                }
            }
        }

        // Z-sort dots for 3D depth rendering
        dots.sortBy { it.z }

        return Pair(lines, dots)
    }
}

@Composable
fun ThinkingOrb(
    state: OrbState = OrbState.WORKING,
    size: OrbSize = OrbSize.PX64,
    modifier: Modifier = Modifier,
    speed: Double = 1.0,
    paused: Boolean = false,
    displaySize: Dp? = null
) {
    val isDark = isSystemInDarkTheme()
    val palette = AidenTheme.palette
    val config = AidenTheme.config
    val actualSize = displaySize ?: size.dp

    val transition = rememberInfiniteTransition(label = "OrbClock")
    val time by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1000f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_000_000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "OrbTime"
    )

    val currentT = if (config.reduceMotion || paused) 0.0 else (time.toDouble() * speed)

    Box(modifier = modifier.size(actualSize)) {
        Canvas(modifier = Modifier.matchParentSize()) {
            val canvasSizePx = this.size.minDimension.toDouble()
            val (lines, dots) = ThinkingOrbMath.renderFrame(
                state = state,
                size = canvasSizePx,
                t = currentT,
                isDark = isDark,
                accentColor = when (state) {
                    OrbState.ERROR -> palette.danger
                    OrbState.SUCCESS -> palette.success
                    OrbState.THINKING -> palette.accent
                    else -> palette.foreground
                }
            )

            val baseColor = when (state) {
                OrbState.ERROR -> palette.danger
                OrbState.SUCCESS -> palette.success
                OrbState.THINKING -> palette.accent
                else -> palette.foreground
            }

            // 1. Draw connecting lines
            for (line in lines) {
                drawLine(
                    color = baseColor.copy(alpha = line.alpha.toFloat()),
                    start = Offset(line.x1.toFloat(), line.y1.toFloat()),
                    end = Offset(line.x2.toFloat(), line.y2.toFloat()),
                    strokeWidth = line.strokeWidth.toFloat()
                )
            }

            // 2. Draw dots in depth order
            for (dot in dots) {
                val dotColor = if (state == OrbState.IDLE) {
                    palette.secondary.copy(alpha = dot.alpha.toFloat())
                } else {
                    baseColor.copy(alpha = dot.alpha.toFloat())
                }
                drawCircle(
                    color = dotColor,
                    radius = dot.r.toFloat(),
                    center = Offset(dot.x.toFloat(), dot.y.toFloat())
                )
            }
        }
    }
}
