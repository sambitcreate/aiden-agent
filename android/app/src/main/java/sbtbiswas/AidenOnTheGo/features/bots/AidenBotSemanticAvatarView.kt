package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Canvas as GraphicsCanvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PaintingStyle
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.chat.aidenPowerSaveMode
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * What a Bot's mark looks like: a colour and a shape, drawn as a Hi-bit sprite. Every Bot
 * shares one face, so the wire's legacy eye and accessory fields are not drawn.
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
    }
}

object AidenBotAvatarColors {
    /** The eye mark colour, shared with desktop (`BOT_AVATAR_FACE_HEX`). */
    const val FACE_RGB: Int = 0x292735

    /** The colour as 0xRRGGBB, exactly desktop's `BOT_AVATAR_COLOR_HEX`. */
    fun rgb(color: AidenBotAvatarColor): Int = when (color) {
        AidenBotAvatarColor.LILAC -> 0xC6A9FF
        AidenBotAvatarColor.SKY -> 0x83D8FF
        AidenBotAvatarColor.MINT -> 0x88E8B1
        AidenBotAvatarColor.SUN -> 0xFFDA7B
        AidenBotAvatarColor.PERIWINKLE -> 0xB2BCFF
        AidenBotAvatarColor.CORAL -> 0xFF9F9B
        AidenBotAvatarColor.PEACH -> 0xFFC294
        AidenBotAvatarColor.AQUA -> 0x78E8DF
        AidenBotAvatarColor.ROSE -> 0xFFA3C7
        AidenBotAvatarColor.LIME -> 0xC6EC7E
        AidenBotAvatarColor.PLUM -> 0xDDA8F2
        AidenBotAvatarColor.GRAPHITE -> 0xC5C5CE
    }

    /** The flat fill used by avatars and the Character card. */
    fun swatch(color: AidenBotAvatarColor): Color = Color(0xFF000000.toInt() or rgb(color))

    val face: Color get() = Color(0xFF000000.toInt() or FACE_RGB)
}

/**
 * What [botId]'s live avatar shows for [target], settled by [aidenBotAvatarSettled]: working
 * changes wait a moment, and done or error show briefly before idle. Null while the Bot rests,
 * so the avatar stays still. A row reused for another Bot starts its own settler.
 */
@Composable
fun rememberAidenBotAvatarState(botId: String, target: AidenBotAvatarState): AidenBotAvatarState? {
    val latest by rememberUpdatedState(target)
    val settled = remember(botId) { snapshotFlow { latest }.aidenBotAvatarSettled() }
    val shown by settled.collectAsState(initial = if (target.isActive) target else AidenBotAvatarState.IDLE)
    return shown.takeIf { it != AidenBotAvatarState.IDLE }
}

/** No clock: the sprite shows its state's still pose. */
private const val STILL = -1L

@Composable
fun AidenBotSemanticAvatarView(
    avatar: AidenBotSemanticAvatar,
    name: String = "",
    size: Dp = 48.dp,
    /** The Bot is working; without a [state] the sprite thinks. */
    working: Boolean = false,
    modifier: Modifier = Modifier,
    /**
     * What the Bot is doing, for the Bot chat header and running Bot cards. The sprite plays the
     * state's motion; Reduce Motion, battery saver and the background hold its still pose.
     */
    state: AidenBotAvatarState? = null
) {
    val presentation = aidenBotAvatarPresentation(avatar)
    val avatarLabel = if (name.isNotEmpty()) stringResource(R.string.bots_avatar_cd, name) else null
    val live = state != null || working
    val shown = state ?: if (working) AidenBotAvatarState.THINKING else AidenBotAvatarState.IDLE
    val animates = aidenBotFaceMotion(
        working = live,
        photo = false,
        reduceMotion = aidenReduceMotion(),
        powerSave = live && aidenPowerSaveMode(),
        resumed = aidenBotIsResumed()
    ).animates
    val small = AidenBotSprite.isSmall(size.value)
    val dark = AidenTheme.palette.isDark
    val paints = remember { AidenBotSpritePaints() }

    // A stepped clock: it changes only when the picture does, and is read only in the draw phase.
    // A new state starts its clock at 0 in the same frame, so it never draws at the old state's time.
    val clockMs = remember(animates, shown) { mutableLongStateOf(if (animates) 0L else STILL) }
    LaunchedEffect(animates, shown) {
        if (!animates) {
            clockMs.longValue = STILL
            return@LaunchedEffect
        }
        val startMs = withFrameMillis { it }
        var elapsed = 0L
        while (true) {
            clockMs.longValue = elapsed
            val next = aidenBotSpriteNextChangeMs(shown, elapsed) ?: break
            delay(next - elapsed)
            elapsed = withFrameMillis { it } - startMs
        }
    }

    Box(
        modifier = modifier
            .size(size)
            .semantics { if (avatarLabel != null) contentDescription = avatarLabel }
    ) {
        Canvas(modifier = Modifier.matchParentSize()) {
            val t = clockMs.longValue.takeIf { it != STILL }
            drawAidenBotSprite(presentation.shape, presentation.color, shown, t, small, dark, paints = paints)
        }
    }
}

/** A sprite's body in [color], still: the shape picker's choices. */
@Composable
fun AidenBotSpriteBody(
    shape: AidenBotAvatarShape,
    color: AidenBotAvatarColor,
    size: Dp,
    modifier: Modifier = Modifier
) {
    val small = AidenBotSprite.isSmall(size.value)
    val paints = remember { AidenBotSpritePaints() }
    Canvas(modifier = modifier.size(size)) {
        drawAidenBotSprite(shape, color, AidenBotAvatarState.IDLE, null, small, dark = false, face = false, paints = paints)
    }
}

/** The paints and path a sprite reuses from frame to frame, so drawing allocates nothing. */
internal class AidenBotSpritePaints {
    val fill = Paint().apply { isAntiAlias = false; style = PaintingStyle.Fill }
    val stroke = Paint().apply {
        isAntiAlias = false
        style = PaintingStyle.Stroke
        strokeCap = StrokeCap.Square
        strokeJoin = StrokeJoin.Miter
    }
    val path = Path()
}

private fun argb(rgb: Int, alpha: Float = 1f): Color = Color(0xFF000000.toInt() or rgb).copy(alpha = alpha)

/**
 * Draws the sprite in [state]'s pose at [timeMs] (null for the still pose): square cells snapped
 * to whole pixels, with anti-aliasing off so edges stay crisp at every size.
 */
internal fun DrawScope.drawAidenBotSprite(
    shape: AidenBotAvatarShape,
    color: AidenBotAvatarColor,
    state: AidenBotAvatarState,
    timeMs: Long?,
    small: Boolean,
    dark: Boolean,
    face: Boolean = true,
    paints: AidenBotSpritePaints
) {
    val u = min(size.width, size.height) / AidenBotSprite.VIEW_BOX
    val tones = AidenBotSprite.tones(color)
    val grid = AidenBotSprite.grid(shape, small)
    val topRow = AidenBotSprite.topRow(shape, small)
    val pose = aidenBotSpritePose(state, timeMs)
    val mark = if (dark) tones.markDark else tones.markLight
    val fill = paints.fill

    drawIntoCanvas { canvas ->
        fun rect(x: Float, y: Float, w: Float, h: Float, rgb: Int, alpha: Float = 1f) {
            if (alpha <= 0f || w <= 0f || h <= 0f) return
            val left = ((x + pose.rigDx) * u).roundToInt().toFloat()
            val top = ((y + pose.rigDy) * u).roundToInt().toFloat()
            val right = ((x + w + pose.rigDx) * u).roundToInt().toFloat()
            val bottom = ((y + h + pose.rigDy) * u).roundToInt().toFloat()
            if (right <= left || bottom <= top) return
            fill.color = argb(rgb, alpha)
            canvas.drawRect(left, top, right, bottom, fill)
        }

        // Body cells; error's glitch shifts the odd row pairs.
        for (y in 0 until AidenBotSprite.GRID) {
            val dx = if (aidenBotSpriteGlitchRow(y)) pose.glitchDx else 0f
            for (x in 0 until AidenBotSprite.GRID) {
                val cell = grid[y][x]
                val rgb = when (cell) {
                    AidenBotSpriteCell.EMPTY -> continue
                    AidenBotSpriteCell.OUTLINE -> tones.shade
                    AidenBotSpriteCell.BODY -> tones.tint
                    AidenBotSpriteCell.HIGHLIGHT -> tones.light
                }
                val alpha = aidenBotSpriteCellAlpha(state, timeMs, x, y, cell)
                rect(x * AidenBotSprite.CELL + dx, y * AidenBotSprite.CELL, AidenBotSprite.CELL, AidenBotSprite.CELL, rgb, alpha)
            }
        }
        if (!face) return@drawIntoCanvas

        drawAidenBotSpriteEyes(canvas, paints, pose, tones, small, u)

        // Props, in the mark tone so they read on both appearances.
        if (pose.dots) {
            val dotY = maxOf(0.5f, topRow * AidenBotSprite.CELL - 4f)
            for (i in 0 until 3) rect(36f + i * 3.9f, dotY, 2.6f, 2.6f, mark, aidenBotSpriteDotAlpha(timeMs, i))
        }
        if (pose.plug) {
            rect(42f + pose.plugDx, 27f, 4.5f, 3f, tones.shade)
            rect(42f + 4.5f - 0.6f + pose.plugDx, 27f - 1.05f, 3.3f, 5.1f, mark)
        }
        if (pose.cursor) rect(45f, 16.5f, 2f, 8f, mark, pose.cursorAlpha)
    }
}

private fun DrawScope.drawAidenBotSpriteEyes(
    canvas: GraphicsCanvas,
    paints: AidenBotSpritePaints,
    pose: AidenBotSpritePose,
    tones: AidenBotSpriteTones,
    small: Boolean,
    u: Float
) {
    val ox = pose.rigDx + pose.lookDx
    val oy = pose.rigDy + pose.lookDy
    val cx = AidenBotSprite.EYES_CENTER_X
    val cy = AidenBotSprite.EYES_CENTER_Y

    if (pose.eyes == AidenBotSpriteEyes.OPEN) {
        val fill = paints.fill
        val sx = pose.eyeScale
        val sy = pose.eyeScale * pose.lid
        // The lid squashes the eyes vertically, and waiting widens them, both about the eyes' centre.
        aidenBotSpriteOpenEyeBlocks(pose, tones, small) { x, y, w, h, rgb ->
            val left = ((cx + (x - cx) * sx + ox) * u).roundToInt().toFloat()
            val right = ((cx + (x + w - cx) * sx + ox) * u).roundToInt().toFloat()
            val top = ((cy + (y - cy) * sy + oy) * u).roundToInt().toFloat()
            // A closing lid always leaves a one-pixel line.
            val bottom = maxOf(top + 1f, ((cy + (y + h - cy) * sy + oy) * u).roundToInt().toFloat())
            if (right > left) {
                fill.color = argb(rgb)
                canvas.drawRect(left, top, right, bottom, fill)
            }
        }
        return
    }

    val sw = if (small) 2.4f else 1.6f
    val w = if (small) 6f else 5f
    val h = 6f
    val stroke = paints.stroke.apply {
        strokeWidth = sw * u
        color = argb(tones.deep)
    }
    val path = paints.path
    AidenBotSprite.EYE_X.forEachIndexed { index, ex ->
        val x = (if (small) ex else ex + 0.5f) + ox
        val y = AidenBotSprite.EYE_Y + oy
        path.reset()
        if (pose.eyes == AidenBotSpriteEyes.HAPPY) {
            path.moveTo((x + sw / 2f) * u, (y + 0.78f * h) * u)
            path.lineTo((x + w / 2f) * u, (y + 0.2f * h) * u)
            path.lineTo((x + w - sw / 2f) * u, (y + 0.78f * h) * u)
        } else {
            // Wince: chevrons pointing inward, the left eye to the right and the right eye to the left.
            val near = x + sw / 2f
            val far = x + w - sw / 2f
            val x0 = if (index == 0) near else far
            val x1 = if (index == 0) far else near
            path.moveTo(x0 * u, (y + sw / 2f) * u)
            path.lineTo(x1 * u, (y + h / 2f) * u)
            path.lineTo(x0 * u, (y + h - sw / 2f) * u)
        }
        canvas.drawPath(path, stroke)
    }
}
