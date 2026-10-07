package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.*

/**
 * What a Bot's mark looks like: a colour and a shape. Every Bot shares one fixed eye
 * mark, so the wire's legacy eye and accessory fields are not drawn.
 */
data class AidenBotAvatarPresentation(
    val shape: AidenBotAvatarShape,
    val color: AidenBotAvatarColor
)

fun aidenBotAvatarPresentation(avatar: AidenBotSemanticAvatar): AidenBotAvatarPresentation {
    return when (avatar) {
        is AidenBotSemanticAvatar.Recipe -> AidenBotAvatarPresentation(
            shape = avatar.recipe.shape,
            color = avatar.recipe.color
        )
        is AidenBotSemanticAvatar.Legacy -> when (avatar.legacy) {
            AidenBotLegacyAvatar.SPARK -> AidenBotAvatarPresentation(AidenBotAvatarShape.WISP, AidenBotAvatarColor.SUN)
            AidenBotLegacyAvatar.ORBIT -> AidenBotAvatarPresentation(AidenBotAvatarShape.ORB, AidenBotAvatarColor.LILAC)
            AidenBotLegacyAvatar.LEAF -> AidenBotAvatarPresentation(AidenBotAvatarShape.DROP, AidenBotAvatarColor.MINT)
            AidenBotLegacyAvatar.PRISM -> AidenBotAvatarPresentation(AidenBotAvatarShape.HEX, AidenBotAvatarColor.PERIWINKLE)
            AidenBotLegacyAvatar.WAVE -> AidenBotAvatarPresentation(AidenBotAvatarShape.CLOUD, AidenBotAvatarColor.AQUA)
            AidenBotLegacyAvatar.EMBER -> AidenBotAvatarPresentation(AidenBotAvatarShape.PEAK, AidenBotAvatarColor.CORAL)
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

    /** The flat swatch colour used by the Character card. */
    fun swatch(color: AidenBotAvatarColor): Color = getGradient(color).first()
}

@Composable
fun AidenBotSemanticAvatarView(
    avatar: AidenBotSemanticAvatar,
    name: String = "",
    size: Dp = 48.dp,
    modifier: Modifier = Modifier
) {
    val presentation = aidenBotAvatarPresentation(avatar)
    val fill = AidenBotAvatarColors.swatch(presentation.color)

    Box(
        modifier = modifier
            .size(size)
            .semantics { if (name.isNotEmpty()) contentDescription = "$name avatar" }
    ) {
        Canvas(modifier = Modifier.matchParentSize()) {
            val w = this.size.width
            val h = this.size.height
            val shapePath = aidenBotShapePath(presentation.shape, w, h)
            drawPath(path = shapePath, color = fill)

            // The one fixed eye mark: two slanted white pills.
            val eyeWidth = w * 0.11f
            val eyeHeight = h * 0.24f
            val eyeTop = h * 0.42f
            listOf(w * 0.40f, w * 0.58f).forEach { left ->
                rotate(degrees = 12f, pivot = Offset(left + eyeWidth / 2f, eyeTop + eyeHeight / 2f)) {
                    drawRoundRect(
                        color = Color.White,
                        topLeft = Offset(left, eyeTop),
                        size = Size(eyeWidth, eyeHeight),
                        cornerRadius = CornerRadius(eyeWidth / 2f, eyeWidth / 2f)
                    )
                }
            }
        }
    }
}

/** The outline of a Bot shape inside a [w] x [h] box. */
fun aidenBotShapePath(shape: AidenBotAvatarShape, w: Float, h: Float): Path {
    val shapePath = Path()
    when (shape) {
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
    return shapePath
}
