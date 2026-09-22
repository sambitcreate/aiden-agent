package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.models.*

data class AidenBotAvatarPresentation(
    val shape: AidenBotAvatarShape,
    val color: AidenBotAvatarColor,
    val eyes: AidenBotAvatarEyes,
    val detail: AidenBotAvatarDetail
)

fun aidenBotAvatarPresentation(avatar: AidenBotSemanticAvatar): AidenBotAvatarPresentation {
    return when (avatar) {
        is AidenBotSemanticAvatar.Recipe -> AidenBotAvatarPresentation(
            shape = avatar.recipe.shape,
            color = avatar.recipe.color,
            eyes = avatar.recipe.eyes,
            detail = avatar.recipe.detail
        )
        is AidenBotSemanticAvatar.Legacy -> when (avatar.legacy) {
            AidenBotLegacyAvatar.SPARK -> AidenBotAvatarPresentation(AidenBotAvatarShape.WISP, AidenBotAvatarColor.SUN, AidenBotAvatarEyes.HAPPY, AidenBotAvatarDetail.SPARKLES)
            AidenBotLegacyAvatar.ORBIT -> AidenBotAvatarPresentation(AidenBotAvatarShape.ORB, AidenBotAvatarColor.LILAC, AidenBotAvatarEyes.FOCUS, AidenBotAvatarDetail.ORBIT)
            AidenBotLegacyAvatar.LEAF -> AidenBotAvatarPresentation(AidenBotAvatarShape.DROP, AidenBotAvatarColor.MINT, AidenBotAvatarEyes.SLEEPY, AidenBotAvatarDetail.NONE)
            AidenBotLegacyAvatar.PRISM -> AidenBotAvatarPresentation(AidenBotAvatarShape.HEX, AidenBotAvatarColor.PERIWINKLE, AidenBotAvatarEyes.WIDE, AidenBotAvatarDetail.HALO)
            AidenBotLegacyAvatar.WAVE -> AidenBotAvatarPresentation(AidenBotAvatarShape.CLOUD, AidenBotAvatarColor.AQUA, AidenBotAvatarEyes.WINK, AidenBotAvatarDetail.ORBIT)
            AidenBotLegacyAvatar.EMBER -> AidenBotAvatarPresentation(AidenBotAvatarShape.PEAK, AidenBotAvatarColor.CORAL, AidenBotAvatarEyes.DOTS, AidenBotAvatarDetail.BOLTS)
        }
    }
}

object AidenBotAvatarColors {
    fun getGradient(color: AidenBotAvatarColor): List<Color> = when (color) {
        AidenBotAvatarColor.LILAC -> listOf(Color(0xFF8A63D2), Color(0xFF6B46C1))
        AidenBotAvatarColor.SKY -> listOf(Color(0xFF0284C7), Color(0xFF0369A1))
        AidenBotAvatarColor.MINT -> listOf(Color(0xFF059669), Color(0xFF047857))
        AidenBotAvatarColor.SUN -> listOf(Color(0xFFD97706), Color(0xFFB45309))
        AidenBotAvatarColor.PERIWINKLE -> listOf(Color(0xFF4F46E5), Color(0xFF4338CA))
        AidenBotAvatarColor.CORAL -> listOf(Color(0xFFE11D48), Color(0xFFBE123C))
        AidenBotAvatarColor.PEACH -> listOf(Color(0xFFEA580C), Color(0xFFC2410C))
        AidenBotAvatarColor.AQUA -> listOf(Color(0xFF0891B2), Color(0xFF0E7490))
    }

    fun getEyeGlyph(eyes: AidenBotAvatarEyes): String = when (eyes) {
        AidenBotAvatarEyes.DOTS -> "•  •"
        AidenBotAvatarEyes.WIDE -> "◉  ◉"
        AidenBotAvatarEyes.HAPPY -> "◠  ◠"
        AidenBotAvatarEyes.SLEEPY -> "—  —"
        AidenBotAvatarEyes.FOCUS -> "◓  ◓"
        AidenBotAvatarEyes.WINK -> "◉  ◠"
    }
}

@Composable
fun AidenBotSemanticAvatarView(
    avatar: AidenBotSemanticAvatar,
    name: String = "",
    size: Dp = 48.dp,
    modifier: Modifier = Modifier
) {
    val presentation = aidenBotAvatarPresentation(avatar)
    val gradientColors = AidenBotAvatarColors.getGradient(presentation.color)
    val eyeGlyph = AidenBotAvatarColors.getEyeGlyph(presentation.eyes)

    Box(
        modifier = modifier.size(size),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.matchParentSize()) {
            val w = this.size.width
            val h = this.size.height
            val brush = Brush.linearGradient(
                colors = gradientColors,
                start = Offset(0f, 0f),
                end = Offset(w, h)
            )

            val shapePath = Path()
            when (presentation.shape) {
                AidenBotAvatarShape.ORB -> {
                    shapePath.addOval(androidx.compose.ui.geometry.Rect(0f, 0f, w, h))
                }
                AidenBotAvatarShape.SQUIRCLE -> {
                    shapePath.addRoundRect(
                        androidx.compose.ui.geometry.RoundRect(
                            0f, 0f, w, h,
                            CornerRadius(w * 0.28f, h * 0.28f)
                        )
                    )
                }
                AidenBotAvatarShape.CAPSULE -> {
                    shapePath.addRoundRect(
                        androidx.compose.ui.geometry.RoundRect(
                            w * 0.08f, 0f, w * 0.92f, h,
                            CornerRadius(w * 0.42f, h * 0.42f)
                        )
                    )
                }
                AidenBotAvatarShape.HEX -> {
                    val cx = w / 2f
                    val cy = h / 2f
                    val r = w * 0.48f
                    for (i in 0 until 6) {
                        val angle = (i * 60.0 - 30.0) * Math.PI / 180.0
                        val px = cx + (r * Math.cos(angle)).toFloat()
                        val py = cy + (r * Math.sin(angle)).toFloat()
                        if (i == 0) shapePath.moveTo(px, py) else shapePath.lineTo(px, py)
                    }
                    shapePath.close()
                }
                AidenBotAvatarShape.PEAK -> {
                    shapePath.moveTo(w * 0.5f, h * 0.05f)
                    shapePath.lineTo(w * 0.95f, h * 0.92f)
                    shapePath.lineTo(w * 0.05f, h * 0.92f)
                    shapePath.close()
                }
                AidenBotAvatarShape.DROP -> {
                    shapePath.moveTo(w * 0.5f, 0f)
                    shapePath.cubicTo(w * 0.85f, h * 0.4f, w, h * 0.7f, w * 0.5f, h)
                    shapePath.cubicTo(0f, h * 0.7f, w * 0.15f, h * 0.4f, w * 0.5f, 0f)
                    shapePath.close()
                }
                AidenBotAvatarShape.CLOUD -> {
                    shapePath.addOval(androidx.compose.ui.geometry.Rect(w * 0.05f, h * 0.2f, w * 0.95f, h * 0.85f))
                    shapePath.addOval(androidx.compose.ui.geometry.Rect(w * 0.2f, h * 0.05f, w * 0.8f, h * 0.75f))
                }
                AidenBotAvatarShape.WISP -> {
                    shapePath.moveTo(w * 0.5f, 0f)
                    shapePath.cubicTo(w * 0.95f, h * 0.25f, w * 0.85f, h * 0.85f, w * 0.5f, h)
                    shapePath.cubicTo(w * 0.15f, h * 0.85f, 0f, h * 0.45f, w * 0.5f, 0f)
                    shapePath.close()
                }
            }

            // Fill shape
            drawPath(path = shapePath, brush = brush)

            // Stroke outline
            drawPath(path = shapePath, color = Color.White.copy(alpha = 0.35f), style = Stroke(width = maxOf(1f, w * 0.02f)))

            // Detail accessories
            when (presentation.detail) {
                AidenBotAvatarDetail.HALO -> {
                    drawOval(
                        color = Color.White.copy(alpha = 0.75f),
                        topLeft = Offset(w * 0.22f, h * 0.02f),
                        size = Size(w * 0.56f, h * 0.18f),
                        style = Stroke(width = maxOf(1.5f, w * 0.035f))
                    )
                }
                AidenBotAvatarDetail.ORBIT -> {
                    drawOval(
                        color = Color.White.copy(alpha = 0.65f),
                        topLeft = Offset(w * 0.08f, h * 0.32f),
                        size = Size(w * 0.84f, h * 0.36f),
                        style = Stroke(width = maxOf(1.2f, w * 0.025f))
                    )
                    drawCircle(
                        color = Color.White,
                        radius = w * 0.05f,
                        center = Offset(w * 0.88f, h * 0.5f)
                    )
                }
                AidenBotAvatarDetail.SPARKLES -> {
                    // Star sparkle
                    val sx = w * 0.8f
                    val sy = h * 0.2f
                    val sr = w * 0.1f
                    drawLine(Color.White.copy(alpha = 0.85f), Offset(sx - sr, sy), Offset(sx + sr, sy), strokeWidth = 2f)
                    drawLine(Color.White.copy(alpha = 0.85f), Offset(sx, sy - sr), Offset(sx, sy + sr), strokeWidth = 2f)
                }
                AidenBotAvatarDetail.ANTENNA -> {
                    drawLine(Color.White.copy(alpha = 0.8f), Offset(w * 0.5f, h * 0.16f), Offset(w * 0.5f, h * 0.02f), strokeWidth = 2f)
                    drawCircle(Color.White, radius = w * 0.05f, center = Offset(w * 0.5f, h * 0.02f))
                }
                AidenBotAvatarDetail.BOLTS -> {
                    drawCircle(Color.White.copy(alpha = 0.8f), radius = w * 0.035f, center = Offset(w * 0.15f, h * 0.3f))
                    drawCircle(Color.White.copy(alpha = 0.8f), radius = w * 0.035f, center = Offset(w * 0.85f, h * 0.3f))
                }
                AidenBotAvatarDetail.NONE -> {}
            }
        }

        // Eyes
        Text(
            text = eyeGlyph,
            fontSize = (size.value * 0.28f).sp,
            fontWeight = FontWeight.Bold,
            color = Color.White,
            letterSpacing = 1.sp
        )
    }
}
