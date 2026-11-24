package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape
import sbtbiswas.AidenOnTheGo.models.AidenBotConversationActivityState
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionState
import sbtbiswas.AidenOnTheGo.models.AidenStreamState

/**
 * The Hi-bit sprite Bot avatar (docs/plans/hibit-sprite-avatars-plan.md). Bodies and tones are
 * copies of `botAvatarSprite` in the shared contract fixture, checked against it by tests.
 */
enum class AidenBotAvatarState {
    IDLE, THINKING, READING, TOOL, WRITING, EDITING, WAITING, DONE, ERROR;

    /** A turn is at work or waits on the person; done, error and idle are not. */
    val isActive: Boolean get() = this != IDLE && this != DONE && this != ERROR
}

/** One cell of the 16×16 sprite grid. */
enum class AidenBotSpriteCell { EMPTY, OUTLINE, BODY, HIGHLIGHT }

/** A tint's precomputed colours, as 0xRRGGBB. */
data class AidenBotSpriteTones(
    val tint: Int,
    val shade: Int,
    val deep: Int,
    val light: Int,
    val markLight: Int,
    val markDark: Int
)

enum class AidenBotSpriteEyes { OPEN, HAPPY, WINCE }

/**
 * Where a state's face and props sit, in 48-unit viewBox coordinates. The still pose is what
 * Reduce Motion shows, and where every animation starts and ends.
 */
data class AidenBotSpritePose(
    val rigDx: Float = 0f,
    val rigDy: Float = 0f,
    val lookDx: Float = 0f,
    val lookDy: Float = 0f,
    /** The lid's scaleY on the open eyes. */
    val lid: Float = 1f,
    /** The open eyes' scale (waiting looks up wide). */
    val eyeScale: Float = 1f,
    val eyes: AidenBotSpriteEyes = AidenBotSpriteEyes.OPEN,
    val dots: Boolean = false,
    val plug: Boolean = false,
    val plugDx: Float = 0f,
    val cursor: Boolean = false,
    val cursorAlpha: Float = 1f,
    /** The x shift of the odd row pairs (error's glitch). */
    val glitchDx: Float = 0f
)

object AidenBotSprite {
    const val GRID = 16
    const val VIEW_BOX = 48f
    const val CELL = 3f

    /** At this size and below the sprite drops its highlight cells and draws bolder, square eyes. */
    const val SMALL_MAX_DP = 24f

    /** The eyes' left edges and top, and the centre the lid and eye scale pivot on. */
    val EYE_X = floatArrayOf(15f, 27f)
    const val EYE_Y = 18f
    const val EYES_CENTER_X = 24f
    const val EYES_CENTER_Y = 21f

    /** The small cut's eye glint, white so the deep eyes still catch the light at list size (`smallGlintHex`). */
    const val SMALL_GLINT = 0xFFFFFF

    /** A glint's side, as a share of its eye's shorter side, at every size. */
    const val GLINT_SHARE = 0.42f

    val bodies: Map<AidenBotAvatarShape, String> = mapOf(
        AidenBotAvatarShape.WISP to "000000/000011/000111/002111/002111/001111/111111/111211/012111/001111/001101/001000",
        AidenBotAvatarShape.ORB to "000000/000011/000111/001111/001111/011111/121111/012111/002112/001111/000010/001000",
        AidenBotAvatarShape.DROP to "000010/000111/000111/002111/001111/011111/111111/121111/001111/001111/000111/001100",
        AidenBotAvatarShape.HEX to "000010/000111/000121/011111/011111/001111/021111/021211/011111/001101/000000/000000",
        AidenBotAvatarShape.CLOUD to "000001/000011/000211/001111/002111/011111/021111/021111/011112/012101/001111/000000",
        AidenBotAvatarShape.PEAK to "000010/000011/000111/001111/001111/001111/011111/111111/002111/011111/001000/001100",
        AidenBotAvatarShape.SQUIRCLE to "000000/000111/000111/001111/012111/011111/021111/011111/012111/012111/001111/001000",
        AidenBotAvatarShape.CAPSULE to "000001/000122/001111/011111/011111/001111/011111/011211/012111/001111/001011/001000",
    )

    val tones: Map<AidenBotAvatarColor, AidenBotSpriteTones> = mapOf(
        AidenBotAvatarColor.LILAC to AidenBotSpriteTones(0xC6A9FF, 0xA87EEE, 0x42246C, 0xF8F5FE, 0x8C58D8, 0xC6A9FF),
        AidenBotAvatarColor.SKY to AidenBotSpriteTones(0x83D8FF, 0x2EB7EB, 0x003E54, 0xEFF9FD, 0x0686B0, 0x83D8FF),
        AidenBotAvatarColor.MINT to AidenBotSpriteTones(0x88E8B1, 0x35CB84, 0x004427, 0xE8FDF0, 0x0E915A, 0x88E8B1),
        AidenBotAvatarColor.SUN to AidenBotSpriteTones(0xFFDA7B, 0xE4B416, 0x463502, 0xFEF6E2, 0x96760D, 0xFFDA7B),
        AidenBotAvatarColor.PERIWINKLE to AidenBotSpriteTones(0xB2BCFF, 0x8C96EE, 0x2C2C74, 0xF5F6FC, 0x676ED0, 0xB2BCFF),
        AidenBotAvatarColor.CORAL to AidenBotSpriteTones(0xFF9F9B, 0xEB6F6E, 0x681118, 0xFFF4F3, 0xCE4146, 0xFF9F9B),
        AidenBotAvatarColor.PEACH to AidenBotSpriteTones(0xFFC294, 0xE89858, 0x562B01, 0xFDF5EF, 0xB4620A, 0xFFC294),
        AidenBotAvatarColor.AQUA to AidenBotSpriteTones(0x78E8DF, 0x16C8BE, 0x06413E, 0xE3FDFA, 0x008D86, 0x78E8DF),
        AidenBotAvatarColor.ROSE to AidenBotSpriteTones(0xFFA3C7, 0xE973A6, 0x63123B, 0xFEF4F7, 0xC64080, 0xFFA3C7),
        AidenBotAvatarColor.LIME to AidenBotSpriteTones(0xC6EC7E, 0x9DCB1D, 0x2E3F01, 0xF2FAE6, 0x678800, 0xC6EC7E),
        AidenBotAvatarColor.PLUM to AidenBotSpriteTones(0xDDA8F2, 0xC27CDD, 0x4F1E60, 0xFBF4FE, 0xA251C0, 0xDDA8F2),
        AidenBotAvatarColor.GRAPHITE to AidenBotSpriteTones(0xC5C5CE, 0xA2A1B3, 0x36354B, 0xF6F6F9, 0x797988, 0xC5C5CE),
    )

    fun tones(color: AidenBotAvatarColor): AidenBotSpriteTones = tones.getValue(color)

    fun isSmall(sizeDp: Float): Boolean = sizeDp <= SMALL_MAX_DP

    private fun slot(shape: AidenBotAvatarShape, small: Boolean): Int = shape.ordinal * 2 + if (small) 1 else 0

    /** Every shape's grid at both cuts, expanded once and looked up by index while drawing. */
    private val grids: Array<List<List<AidenBotSpriteCell>>> by lazy {
        Array(AidenBotAvatarShape.entries.size * 2) { i ->
            expand(bodies.getValue(AidenBotAvatarShape.entries[i / 2]), small = i % 2 == 1)
        }
    }
    private val topRows: IntArray by lazy { IntArray(grids.size) { topRow(grids[it]) } }

    /** The 16×16 grid of [shape], rows top to bottom; [small] is the cut at 24 dp and below. */
    fun grid(shape: AidenBotAvatarShape, small: Boolean): List<List<AidenBotSpriteCell>> = grids[slot(shape, small)]

    /** The first row of [shape]'s grid with any body or outline cell. */
    fun topRow(shape: AidenBotAvatarShape, small: Boolean): Int = topRows[slot(shape, small)]

    /** The first row with any body or outline cell. */
    fun topRow(grid: List<List<AidenBotSpriteCell>>): Int =
        grid.indexOfFirst { row -> row.any { it != AidenBotSpriteCell.EMPTY } }.coerceAtLeast(0)

    /** Expands 12 mirrored rows of 6 half-columns into the 16×16 grid (the plan's steps 1–5). */
    fun expand(body: String, small: Boolean): List<List<AidenBotSpriteCell>> {
        val b = Array(GRID) { BooleanArray(GRID) }
        val o = Array(GRID) { BooleanArray(GRID) }
        body.split('/').forEachIndexed { ry, row ->
            row.forEachIndexed { h, c ->
                val y = ry + 2
                val target = when (c) {
                    '1' -> b
                    '2' -> o
                    else -> null
                } ?: return@forEachIndexed
                target[y][2 + h] = true
                target[y][13 - h] = true
            }
        }
        fun isBody(x: Int, y: Int) = x in 0 until GRID && y in 0 until GRID && b[y][x]
        for (y in 0 until GRID) for (x in 0 until GRID) {
            if (!b[y][x] && (isBody(x - 1, y) || isBody(x + 1, y) || isBody(x, y - 1) || isBody(x, y + 1))) o[y][x] = true
        }
        for (y in 0 until GRID) for (x in 0 until GRID) {
            if (!o[y][x]) continue
            var touches = false
            for (dy in -1..1) for (dx in -1..1) if ((dx != 0 || dy != 0) && isBody(x + dx, y + dy)) touches = true
            if (!touches) o[y][x] = false
        }
        return List(GRID) { y ->
            List(GRID) { x ->
                when {
                    b[y][x] && !small && y < 9 && !isBody(x, y - 1) -> AidenBotSpriteCell.HIGHLIGHT
                    b[y][x] -> AidenBotSpriteCell.BODY
                    o[y][x] -> AidenBotSpriteCell.OUTLINE
                    else -> AidenBotSpriteCell.EMPTY
                }
            }
        }
    }
}

// ---- Poses and motion -------------------------------------------------------------------------

private const val BLINK_LID = 0.08f

/** Below this lid the eyes read as shut (the blink's closed frame), and the glints hide. */
const val AIDEN_BOT_SPRITE_GLINT_MIN_LID = 0.5f

/**
 * The blocks [pose]'s open eyes are drawn from, in 48-unit viewBox coordinates before the lid,
 * eye scale and offsets: each eye in `deep`, then its glint over the eye's top-left corner. The
 * glint is white at the small cut and `light` at full size, and hides while the lid is shut.
 * Happy and wince eyes are strokes, not blocks, so they give none.
 */
inline fun aidenBotSpriteOpenEyeBlocks(
    pose: AidenBotSpritePose,
    tones: AidenBotSpriteTones,
    small: Boolean,
    block: (x: Float, y: Float, w: Float, h: Float, rgb: Int) -> Unit
) {
    if (pose.eyes != AidenBotSpriteEyes.OPEN) return
    val w = if (small) 6f else 5f
    val h = 6f
    val inset = if (small) 0f else 0.5f
    val glint = AidenBotSprite.GLINT_SHARE * minOf(w, h)
    val glintRgb = if (small) AidenBotSprite.SMALL_GLINT else tones.light
    val showsGlint = pose.lid >= AIDEN_BOT_SPRITE_GLINT_MIN_LID
    for (ex in AidenBotSprite.EYE_X) {
        block(ex + inset, AidenBotSprite.EYE_Y, w, h, tones.deep)
        if (showsGlint) block(ex + inset, AidenBotSprite.EYE_Y, glint, glint, glintRgb)
    }
}

/** [state]'s still pose, or its pose [timeMs] into its animation. */
fun aidenBotSpritePose(state: AidenBotAvatarState, timeMs: Long? = null): AidenBotSpritePose {
    val still = when (state) {
        AidenBotAvatarState.IDLE -> AidenBotSpritePose()
        AidenBotAvatarState.THINKING -> AidenBotSpritePose(lookDx = 1.05f, lookDy = -1.19f, dots = true)
        AidenBotAvatarState.READING -> AidenBotSpritePose(lookDx = -1.12f, lookDy = 0.63f, lid = 0.78f)
        AidenBotAvatarState.TOOL -> AidenBotSpritePose(lookDx = 1.54f, plug = true)
        AidenBotAvatarState.WRITING -> AidenBotSpritePose(lookDy = 1.19f)
        AidenBotAvatarState.EDITING -> AidenBotSpritePose(lookDx = 0.84f, lookDy = 0.49f, lid = 0.5f, cursor = true)
        AidenBotAvatarState.WAITING -> AidenBotSpritePose(eyeScale = 1.14f)
        AidenBotAvatarState.DONE -> AidenBotSpritePose(eyes = AidenBotSpriteEyes.HAPPY)
        AidenBotAvatarState.ERROR -> AidenBotSpritePose(eyes = AidenBotSpriteEyes.WINCE, rigDy = 1.5f, glitchDx = 1.5f)
    }
    val t = timeMs ?: return still
    return when (state) {
        // Blinks shut for the last 3 % of the loop, as the Mac's steps(1, end) blink does.
        AidenBotAvatarState.IDLE -> still.copy(lid = if (Math.floorMod(t, 6_000L) >= 5_820L) BLINK_LID else 1f)
        AidenBotAvatarState.THINKING -> still.copy(rigDy = if (Math.floorMod(t, 1_200L) >= 600L) -1.5f else 0f)
        AidenBotAvatarState.TOOL -> still.copy(
            plugDx = when (Math.floorMod(t, 1_200L)) {
                in 0L until 300L -> -4.5f
                in 300L until 600L -> -1.5f
                in 600L until 1_104L -> 0f
                else -> -3f
            }
        )
        AidenBotAvatarState.EDITING -> still.copy(cursorAlpha = if (Math.floorMod(t, 1_000L) < 500L) 0.35f else 1f)
        AidenBotAvatarState.WAITING -> still.copy(
            rigDy = if (Math.floorMod(t, 1_200L) >= 600L) -0.75f else 0f,
            lid = if (Math.floorMod(t, 2_400L) >= 2_328L) BLINK_LID else 1f
        )
        AidenBotAvatarState.DONE -> still.copy(
            rigDy = when {
                t < 120L -> 0f
                t < 270L -> -3f
                t < 420L -> -4.5f
                t < 510L -> -1.5f
                else -> 0f
            }
        )
        // The rig only drops, halfway through; the odd row pairs glitch sideways.
        AidenBotAvatarState.ERROR -> when {
            t < 130L -> still.copy(rigDy = 0f, glitchDx = -3f)
            t < 260L -> still.copy(rigDy = 0f, glitchDx = 3f)
            t < 390L -> still.copy(glitchDx = -1.5f)
            else -> still
        }
        AidenBotAvatarState.READING, AidenBotAvatarState.WRITING -> still
    }
}

/** Think dot [index]'s opacity: all three show when still; they fade in turn, 0.3 s apart. */
fun aidenBotSpriteDotAlpha(timeMs: Long?, index: Int): Float {
    val t = timeMs ?: return 1f
    return if (Math.floorMod(t - 300L * index, 1_200L) < 600L) 0.25f else 1f
}

private const val SCAN_PERIOD_MS = 1_100L
private const val SCAN_ROW_DELAY_MS = 110L
/** The scan dims a row pair from 12 % to 24 % of its loop. */
private const val SCAN_DIM_FROM_MS = 132L
private const val SCAN_DIM_UNTIL_MS = 264L
private const val TYPE_PERIOD_MS = 1_200L
private const val TYPE_COLUMN_DELAY_MS = 150L
/** Typing dims a column pair for the first 35 % of its loop. */
private const val TYPE_DIM_UNTIL_MS = 420L

/**
 * The opacity of grid cell ([x], [y]) for [state], in steps: reading dims each row pair in turn,
 * writing types column pairs. Writing's outline cells stay solid.
 */
fun aidenBotSpriteCellAlpha(state: AidenBotAvatarState, timeMs: Long?, x: Int, y: Int, cell: AidenBotSpriteCell): Float {
    val typed = state == AidenBotAvatarState.WRITING && cell != AidenBotSpriteCell.OUTLINE
    val stillAlpha = if (typed) 0.92f else 1f
    val t = timeMs ?: return stillAlpha
    return when {
        state == AidenBotAvatarState.READING -> {
            val m = Math.floorMod(t - SCAN_ROW_DELAY_MS * (y / 2), SCAN_PERIOD_MS)
            if (m >= SCAN_DIM_FROM_MS && m < SCAN_DIM_UNTIL_MS) 0.42f else 1f
        }
        typed -> {
            val delayMs = TYPE_COLUMN_DELAY_MS * (x / 2)
            if (t >= delayMs && (t - delayMs) % TYPE_PERIOD_MS < TYPE_DIM_UNTIL_MS) 0.35f else stillAlpha
        }
        else -> stillAlpha
    }
}

/** Whether row [y] belongs to an odd row pair, which error's glitch shifts. */
fun aidenBotSpriteGlitchRow(y: Int): Boolean = (y shr 1) % 2 == 1

private class AidenBotSpriteSchedule(val periodMs: Long, val offsets: LongArray, val once: Boolean = false)

private val READING_OFFSETS: LongArray = (0 until 8).flatMap { r ->
    listOf(SCAN_DIM_FROM_MS, SCAN_DIM_UNTIL_MS).map { (SCAN_ROW_DELAY_MS * r + it) % SCAN_PERIOD_MS }
}.distinct().sorted().toLongArray()

private val WRITING_OFFSETS: LongArray = (0 until 8).flatMap { c ->
    listOf(TYPE_COLUMN_DELAY_MS * c, (TYPE_COLUMN_DELAY_MS * c + TYPE_DIM_UNTIL_MS) % TYPE_PERIOD_MS)
}.distinct().sorted().toLongArray()

private fun schedule(state: AidenBotAvatarState): AidenBotSpriteSchedule = when (state) {
    AidenBotAvatarState.IDLE -> AidenBotSpriteSchedule(6_000L, longArrayOf(0L, 5_820L))
    AidenBotAvatarState.THINKING -> AidenBotSpriteSchedule(1_200L, longArrayOf(0L, 300L, 600L, 900L))
    AidenBotAvatarState.READING -> AidenBotSpriteSchedule(SCAN_PERIOD_MS, READING_OFFSETS)
    AidenBotAvatarState.TOOL -> AidenBotSpriteSchedule(1_200L, longArrayOf(0L, 300L, 600L, 1_104L))
    AidenBotAvatarState.WRITING -> AidenBotSpriteSchedule(1_200L, WRITING_OFFSETS)
    AidenBotAvatarState.EDITING -> AidenBotSpriteSchedule(1_000L, longArrayOf(0L, 500L))
    AidenBotAvatarState.WAITING -> AidenBotSpriteSchedule(2_400L, longArrayOf(0L, 600L, 1_200L, 1_800L, 2_328L))
    AidenBotAvatarState.DONE -> AidenBotSpriteSchedule(600L, longArrayOf(120L, 270L, 420L, 510L), once = true)
    AidenBotAvatarState.ERROR -> AidenBotSpriteSchedule(520L, longArrayOf(130L, 260L, 390L), once = true)
}

/**
 * When [state]'s picture next changes after [timeMs], or null once a play-once state has
 * settled. The sprite redraws only then, so a stepped loop costs a few frames a second.
 */
fun aidenBotSpriteNextChangeMs(state: AidenBotAvatarState, timeMs: Long): Long? {
    val s = schedule(state)
    if (s.once) return s.offsets.firstOrNull { it > timeMs }
    val base = timeMs - Math.floorMod(timeMs, s.periodMs)
    for (offset in s.offsets) if (base + offset > timeMs) return base + offset
    return base + s.periodMs + s.offsets.first()
}

// ---- Which state a Bot is in ------------------------------------------------------------------

/**
 * The avatar state a Bot chat shows, from the same signal as its status line, in the Mac's
 * order: a card waiting on the person first, then the running turn's phase, then how the last
 * turn ended. An ended turn says DONE, or ERROR for an interrupted session, a failed last turn or
 * a missing model; a Stop or a pause ends quietly at IDLE. [aidenBotAvatarSettled] shows done or
 * error only right after work, then rests at idle.
 */
fun aidenBotAvatarTarget(ui: AidenBotSessionUiState): AidenBotAvatarState {
    val session = ui.session
    val cardWaits = session != null &&
        (session.question != null || session.approval != null || session.handoff != null ||
            session.accessRequest != null || ui.composerHeldForPlan)
    if (cardWaits && !ui.isInterrupted) return AidenBotAvatarState.WAITING
    if (ui.isPaused) return AidenBotAvatarState.IDLE
    if (!(ui.isRunning || ui.isAwaitingTurn)) {
        return when {
            ui.endedByStop -> AidenBotAvatarState.IDLE
            ui.isInterrupted || ui.needsModel || session?.entries?.lastOrNull() is AidenBotSessionEntry.FailedTurn ->
                AidenBotAvatarState.ERROR
            ui.state == AidenBotSessionState.IDLE -> AidenBotAvatarState.DONE
            else -> AidenBotAvatarState.IDLE
        }
    }
    val line = aidenBotStatusLine(ui, 0L)
    if (line == null) {
        // The line hides while the reply's words stream in. Words with no phase, or a writing
        // phase, are the reply being written; a thinking phase is still thinking aloud. A Mac
        // without activity frames has no phase to go by.
        val phase = if (ui.activitySupported) session?.activity?.phase else null
        val streaming = !session?.partial.isNullOrBlank()
        return if (streaming && (phase == null || phase == "writing")) AidenBotAvatarState.WRITING else AidenBotAvatarState.THINKING
    }
    return aidenBotAvatarStateFor(line.display.phase)
}

/** The avatar state for a status-line phase. */
fun aidenBotAvatarStateFor(phase: AidenBotActivityPhase): AidenBotAvatarState = when (phase) {
    AidenBotActivityPhase.PREPARING, AidenBotActivityPhase.THINKING,
    AidenBotActivityPhase.TIDYING, AidenBotActivityPhase.STOPPING, AidenBotActivityPhase.RESUMING,
    AidenBotActivityPhase.RECONNECTING -> AidenBotAvatarState.THINKING
    AidenBotActivityPhase.READING, AidenBotActivityPhase.PHOTO, AidenBotActivityPhase.SEARCHING -> AidenBotAvatarState.READING
    AidenBotActivityPhase.EDITING -> AidenBotAvatarState.EDITING
    AidenBotActivityPhase.WRITING -> AidenBotAvatarState.WRITING
    AidenBotActivityPhase.WAITING -> AidenBotAvatarState.WAITING
    AidenBotActivityPhase.COMMAND, AidenBotActivityPhase.APP, AidenBotActivityPhase.HELPER,
    AidenBotActivityPhase.COMPUTER, AidenBotActivityPhase.REMEMBERING, AidenBotActivityPhase.ROUTINE,
    AidenBotActivityPhase.WORKING -> AidenBotAvatarState.TOOL
}

/**
 * The avatar state a Bots home row shows. The list knows only working, waiting and the session
 * state, with no failed-turn or Stop mark, so it can't tell a finished turn from a stopped or
 * failed one: a turn that ends rests quietly at idle, and done shows only in the chat header.
 * An interrupted Bot or one missing its model shows error. A card waiting on the person shows
 * waiting first, even on a paused Bot, which otherwise rests at idle.
 */
fun aidenBotHomeAvatarTarget(row: AidenBotHomeRow): AidenBotAvatarState = when {
    row.conversation?.activityState == AidenBotConversationActivityState.WAITING_FOR_APPROVAL -> AidenBotAvatarState.WAITING
    row.bot.paused || row.bot.sessionState == AidenBotSessionState.PAUSED -> AidenBotAvatarState.IDLE
    row.isWorking -> AidenBotAvatarState.THINKING
    row.bot.sessionState == AidenBotSessionState.INTERRUPTED ||
        row.bot.sessionState == AidenBotSessionState.NEEDS_MODEL -> AidenBotAvatarState.ERROR
    else -> AidenBotAvatarState.IDLE
}

/**
 * The avatar state an older (non-durable) Bot chat's header shows, from its reply stream. A turn
 * someone asked to stop keeps working until it really ends, then ends quietly at idle, as a
 * cancelled reply does.
 */
fun aidenBotStreamAvatarTarget(stream: AidenStreamState?, stopRequested: Boolean): AidenBotAvatarState = when {
    stream == null -> AidenBotAvatarState.IDLE
    stream == AidenStreamState.WAITING_FOR_APPROVAL -> AidenBotAvatarState.WAITING
    !stream.isTerminal -> AidenBotAvatarState.THINKING
    stopRequested -> AidenBotAvatarState.IDLE
    else -> when (stream) {
        AidenStreamState.ERROR, AidenStreamState.INTERRUPTED -> AidenBotAvatarState.ERROR
        AidenStreamState.DONE -> AidenBotAvatarState.DONE
        else -> AidenBotAvatarState.IDLE
    }
}

private val AidenBotAvatarState.isMoment: Boolean
    get() = this == AidenBotAvatarState.DONE || this == AidenBotAvatarState.ERROR

/**
 * Settles raw avatar targets into what the avatar shows, as the Mac's settler does. The first
 * value shows at once (a turn already over opens at idle). Working targets wait [debounceMs] so
 * quick tool bursts don't flicker. DONE and ERROR show at once, but only right after a working
 * pose was on screen (a turn that ended before one showed settles quietly), and hold for
 * [restMs] before idle. An ERROR that lands while DONE shows (the failure reported just after
 * the turn ended) replaces it, and a shown ERROR holds its full moment whatever the target
 * becomes, short of new work. IDLE straight from work is a quiet end (a Stop or a pause).
 */
fun Flow<AidenBotAvatarState>.aidenBotAvatarSettled(
    debounceMs: Long = 250L,
    restMs: Long = 1_500L
): Flow<AidenBotAvatarState> = channelFlow {
    // The collector and the timers it launches share its dispatcher (the main thread in Compose),
    // and none of them suspends between reading and writing this state.
    var shown: AidenBotAvatarState? = null
    var pending: Job? = null
    var rest: Job? = null
    suspend fun show(next: AidenBotAvatarState) {
        if (next == shown) return
        shown = next
        send(next)
    }
    fun startMoment(moment: AidenBotAvatarState) {
        rest?.cancel()
        rest = launch(start = CoroutineStart.UNDISPATCHED) {
            show(moment)
            delay(restMs)
            show(AidenBotAvatarState.IDLE)
        }
    }
    distinctUntilChanged().collect { target ->
        val current = shown
        if (current == null) {
            show(if (target.isActive) target else AidenBotAvatarState.IDLE)
            return@collect
        }
        pending?.cancel()
        pending = null
        when {
            target.isActive -> if (target != current) {
                pending = launch {
                    delay(debounceMs)
                    rest?.cancel()
                    show(target)
                }
            }
            target.isMoment && current.isActive -> startMoment(target)
            target == AidenBotAvatarState.ERROR && current == AidenBotAvatarState.DONE -> startMoment(target)
            // A done or error moment on screen plays out; otherwise the end is quiet.
            current.isMoment -> Unit
            else -> show(AidenBotAvatarState.IDLE)
        }
    }
}
