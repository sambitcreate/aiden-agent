package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape
import sbtbiswas.AidenOnTheGo.models.AidenStreamState
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotAvatarState as S

@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotSpriteTest {
    private val sprite: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json missing" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("botAvatarSprite").jsonObject
    }

    // ---- Parity with the shared fixture (desktop and iOS draw from the same values) ----

    @Test
    fun bodiesTonesAndSizesMatchTheSharedFixture() {
        assertEquals(sprite.getValue("gridSize").jsonPrimitive.int, AidenBotSprite.GRID)
        assertEquals(sprite.getValue("viewBox").jsonPrimitive.int.toFloat(), AidenBotSprite.VIEW_BOX)
        assertEquals(sprite.getValue("smallMaxPx").jsonPrimitive.int.toFloat(), AidenBotSprite.SMALL_MAX_DP)
        val bodies = sprite.getValue("bodies").jsonObject
        assertEquals(AidenBotAvatarShape.entries.size, bodies.size)
        for (shape in AidenBotAvatarShape.entries) {
            assertEquals(shape.name, bodies.getValue(shape.name.lowercase()).jsonPrimitive.content, AidenBotSprite.bodies.getValue(shape))
        }
        val tones = sprite.getValue("tones").jsonObject
        assertEquals(AidenBotAvatarColor.entries.size, tones.size)
        fun hex(rgb: Int) = "#%06X".format(rgb and 0xFFFFFF)
        for (color in AidenBotAvatarColor.entries) {
            val want = tones.getValue(color.name.lowercase()).jsonObject.mapValues { it.value.jsonPrimitive.content.uppercase() }
            val have = AidenBotSprite.tones(color)
            val got = mapOf(
                "tint" to hex(have.tint), "shade" to hex(have.shade), "deep" to hex(have.deep),
                "light" to hex(have.light), "markLight" to hex(have.markLight), "markDark" to hex(have.markDark)
            )
            assertEquals(color.name, want, got)
        }
    }

    private data class EyeBlock(val x: Float, val y: Float, val w: Float, val h: Float, val rgb: Int)

    private fun eyeBlocks(pose: AidenBotSpritePose, tones: AidenBotSpriteTones, small: Boolean): List<EyeBlock> {
        val blocks = mutableListOf<EyeBlock>()
        aidenBotSpriteOpenEyeBlocks(pose, tones, small) { x, y, w, h, rgb -> blocks += EyeBlock(x, y, w, h, rgb) }
        return blocks
    }

    private fun hex(rgb: Int) = "#%06X".format(rgb and 0xFFFFFF)

    @Test
    fun aSmallOpenEyeIsDeepWithTheFixturesWhiteGlintAtItsTopLeft() {
        val glint = sprite.getValue("smallGlintHex").jsonPrimitive.content.uppercase()
        val open = listOf(S.IDLE, S.THINKING, S.READING, S.TOOL, S.WRITING, S.EDITING, S.WAITING)
        for (color in AidenBotAvatarColor.entries) {
            val tones = AidenBotSprite.tones(color)
            for (state in open) {
                val blocks = eyeBlocks(aidenBotSpritePose(state), tones, small = true)
                val eyes = blocks.filter { hex(it.rgb) == hex(tones.deep) }
                val glints = blocks.filter { hex(it.rgb) == glint }
                assertEquals("$state $color: two deep eyes", 2, eyes.size)
                assertEquals("$state $color: one glint per eye", 2, glints.size)
                for ((eye, spot) in eyes.zip(glints)) {
                    // The glint sits in the eye's top-left corner and covers well under half of it.
                    assertEquals(eye.x, spot.x, 1e-4f)
                    assertEquals(eye.y, spot.y, 1e-4f)
                    assertEquals(0.42f * minOf(eye.w, eye.h), spot.w, 1e-4f)
                    assertEquals(spot.w, spot.h, 1e-4f)
                }
                // The full-size face draws no white at all.
                assertTrue(eyeBlocks(aidenBotSpritePose(state), tones, small = false).none { hex(it.rgb) == glint })
            }
        }
    }

    @Test
    fun shutHappyAndWincingSmallFacesShowNoWhite() {
        val glint = sprite.getValue("smallGlintHex").jsonPrimitive.content.uppercase()
        for (color in AidenBotAvatarColor.entries) {
            val tones = AidenBotSprite.tones(color)
            // Mid-blink: the eyes are a deep line with no glint.
            for ((state, t) in listOf(S.IDLE to 5_900L, S.WAITING to 2_350L)) {
                val blocks = eyeBlocks(aidenBotSpritePose(state, t), tones, small = true)
                assertTrue("$state $color shut", blocks.isNotEmpty() && blocks.none { hex(it.rgb) == glint })
            }
            // Done's happy marks and error's wince are deep strokes, with no eye blocks or glint.
            for (state in listOf(S.DONE, S.ERROR)) {
                for (t in listOf<Long?>(null, 0L, 300L, 2_000L)) {
                    assertEquals("$state $color at $t", emptyList<EyeBlock>(), eyeBlocks(aidenBotSpritePose(state, t), tones, small = true))
                }
            }
        }
    }

    @Test
    fun blinksShutForTheLastThreePercentOfTheirLoop() {
        fun shut(state: S, t: Long) = aidenBotSpritePose(state, t).lid < AIDEN_BOT_SPRITE_GLINT_MIN_LID
        assertTrue(!shut(S.IDLE, 5_819) && shut(S.IDLE, 5_820) && shut(S.IDLE, 5_999) && !shut(S.IDLE, 6_000))
        assertTrue(!shut(S.WAITING, 2_327) && shut(S.WAITING, 2_328) && shut(S.WAITING, 2_399) && !shut(S.WAITING, 2_400))
        assertEquals(180, (0L until 6_000L).count { shut(S.IDLE, it) })
        assertEquals(72, (0L until 2_400L).count { shut(S.WAITING, it) })
    }

    @Test
    fun anOlderBotChatsHeaderFollowsItsReplyStream() {
        assertEquals(S.IDLE, aidenBotStreamAvatarTarget(null, stopRequested = false))
        assertEquals(S.THINKING, aidenBotStreamAvatarTarget(AidenStreamState.QUEUED, stopRequested = false))
        assertEquals(S.THINKING, aidenBotStreamAvatarTarget(AidenStreamState.RUNNING, stopRequested = false))
        assertEquals(S.THINKING, aidenBotStreamAvatarTarget(AidenStreamState.RECONCILING, stopRequested = false))
        assertEquals(S.WAITING, aidenBotStreamAvatarTarget(AidenStreamState.WAITING_FOR_APPROVAL, stopRequested = false))
        assertEquals(S.DONE, aidenBotStreamAvatarTarget(AidenStreamState.DONE, stopRequested = false))
        assertEquals(S.ERROR, aidenBotStreamAvatarTarget(AidenStreamState.ERROR, stopRequested = false))
        assertEquals(S.ERROR, aidenBotStreamAvatarTarget(AidenStreamState.INTERRUPTED, stopRequested = false))
        assertEquals(S.IDLE, aidenBotStreamAvatarTarget(AidenStreamState.CANCELLED, stopRequested = false))
        // A pending Stop keeps the reply working until it really ends, and then the end is quiet.
        assertEquals(S.THINKING, aidenBotStreamAvatarTarget(AidenStreamState.RUNNING, stopRequested = true))
        assertEquals(S.WAITING, aidenBotStreamAvatarTarget(AidenStreamState.WAITING_FOR_APPROVAL, stopRequested = true))
        assertEquals(S.IDLE, aidenBotStreamAvatarTarget(AidenStreamState.DONE, stopRequested = true))
        assertEquals(S.IDLE, aidenBotStreamAvatarTarget(AidenStreamState.ERROR, stopRequested = true))
        assertEquals(S.IDLE, aidenBotStreamAvatarTarget(AidenStreamState.INTERRUPTED, stopRequested = true))
    }

    @Test
    fun theExpansionReproducesTheFixturesGridsAtBothSizes() {
        val grids = sprite.getValue("grids").jsonObject
        fun render(grid: List<List<AidenBotSpriteCell>>) = grid.map { row ->
            row.joinToString("") {
                when (it) {
                    AidenBotSpriteCell.EMPTY -> "."
                    AidenBotSpriteCell.OUTLINE -> "o"
                    AidenBotSpriteCell.BODY -> "b"
                    AidenBotSpriteCell.HIGHLIGHT -> "h"
                }
            }
        }
        for (shape in AidenBotAvatarShape.entries) {
            val want = grids.getValue(shape.name.lowercase()).jsonObject
            for ((key, small) in listOf("full" to false, "small" to true)) {
                assertEquals(
                    "${shape.name} $key",
                    want.getValue(key).jsonArray.map { it.jsonPrimitive.content },
                    render(AidenBotSprite.grid(shape, small))
                )
            }
        }
    }

    @Test
    fun theSmallCutStartsAtTwentyFourDp() {
        assertTrue(AidenBotSprite.isSmall(24f))
        assertTrue(!AidenBotSprite.isSmall(28f))
    }

    // ---- Motion: stepped, redrawn only when the picture changes ----

    /** Everything a frame draws for [state] at [t]: the pose, every cell's opacity and the dots'. */
    private fun picture(state: S, t: Long?): List<Any> {
        val grid = AidenBotSprite.grid(AidenBotAvatarShape.ORB, small = false)
        val cells = grid.flatMapIndexed { y, row -> row.mapIndexed { x, cell -> aidenBotSpriteCellAlpha(state, t, x, y, cell) } }
        return listOf(aidenBotSpritePose(state, t), cells, (0 until 3).map { aidenBotSpriteDotAlpha(if (aidenBotSpritePose(state).dots) t else null, it) })
    }

    @Test
    fun theRedrawScheduleNeverMissesAChangeInThePicture() {
        // Every state, reading's scan included, changes in steps the schedule names in advance.
        for (state in S.entries) {
            var previous = picture(state, 0)
            for (t in 1L..7_000L) {
                val now = picture(state, t)
                if (now != previous) {
                    assertEquals("$state changes at $t", t, aidenBotSpriteNextChangeMs(state, t - 1))
                }
                previous = now
            }
        }
    }

    @Test
    fun readingsScanStepsEachRowPairDownInTurn() {
        val grid = AidenBotSprite.grid(AidenBotAvatarShape.ORB, small = false)
        fun dimRows(t: Long) = (0 until AidenBotSprite.GRID).filter { y ->
            (0 until AidenBotSprite.GRID).any { x -> aidenBotSpriteCellAlpha(S.READING, t, x, y, grid[y][x]) < 1f }
        }
        // Only two opacities: full, or the scan's dim.
        val alphas = (0L until 1_100L).flatMap { t ->
            grid.flatMapIndexed { y, row -> row.mapIndexed { x, cell -> aidenBotSpriteCellAlpha(S.READING, t, x, y, cell) } }
        }.toSet()
        assertEquals(setOf(1f, 0.42f), alphas)
        assertEquals(emptyList<Int>(), dimRows(131))
        assertEquals(listOf(0, 1), dimRows(132))
        // 110 ms later the next row pair dims too; the first holds until 24 % of its loop.
        assertEquals(listOf(0, 1, 2, 3), dimRows(242))
        assertEquals(listOf(2, 3), dimRows(264))
    }

    @Test
    fun writingTypesColumnPairsWhileTheOutlineStaysSolid() {
        val grid = AidenBotSprite.grid(AidenBotAvatarShape.ORB, small = false)
        for (t in listOf<Long?>(null, 0L, 200L, 700L, 1_500L)) {
            for (y in grid.indices) for (x in grid[y].indices) {
                val cell = grid[y][x]
                if (cell == AidenBotSpriteCell.EMPTY) continue
                val alpha = aidenBotSpriteCellAlpha(S.WRITING, t, x, y, cell)
                if (cell == AidenBotSpriteCell.OUTLINE) assertEquals(1f, alpha) else assertTrue(alpha == 0.35f || alpha == 0.92f)
            }
        }
        fun bodyAlpha(x: Int, t: Long): Float {
            val y = grid.indices.first { grid[it][x] == AidenBotSpriteCell.BODY }
            return aidenBotSpriteCellAlpha(S.WRITING, t, x, y, AidenBotSpriteCell.BODY)
        }
        // Columns 6 and 7 (pair 3) start typing 450 ms in, dim for 420 ms, then show at .92.
        assertEquals(0.92f, bodyAlpha(6, 449))
        assertEquals(0.35f, bodyAlpha(6, 450))
        assertEquals(0.35f, bodyAlpha(7, 869))
        assertEquals(0.92f, bodyAlpha(7, 870))
        assertEquals(0.35f, bodyAlpha(6, 1_650))
    }

    @Test
    fun errorDropsStraightDownWhileItsRowsGlitch() {
        val poses = (0L..600L).map { aidenBotSpritePose(S.ERROR, it) }
        assertTrue(poses.all { it.rigDx == 0f })
        assertEquals(0f, aidenBotSpritePose(S.ERROR, 259).rigDy)
        assertEquals(1.5f, aidenBotSpritePose(S.ERROR, 260).rigDy)
        assertEquals(setOf(-3f, 3f, -1.5f, 1.5f), poses.map { it.glitchDx }.toSet())
    }

    @Test
    fun loopsRepeatWithinOnePointTwoSecondsApartFromBlinks() {
        // Idle's and waiting's blinks are rare; everything else repeats every 1.2 s or sooner.
        val periods = mapOf(S.THINKING to 1_200L, S.READING to 1_100L, S.TOOL to 1_200L, S.WRITING to 1_200L, S.EDITING to 1_000L)
        for ((state, period) in periods) {
            for (t in 2_000L..3_300L step 7) {
                assertEquals("$state at $t", picture(state, t), picture(state, t + period))
            }
        }
        for (t in 0L..2_400L step 5) {
            assertEquals(aidenBotSpritePose(S.WAITING, t).rigDy, aidenBotSpritePose(S.WAITING, t + 1_200).rigDy)
        }
    }

    @Test
    fun doneAndErrorPlayOnceAndEndOnTheirStillPose() {
        for (state in listOf(S.DONE, S.ERROR)) {
            assertNull("$state stops", aidenBotSpriteNextChangeMs(state, 600))
            assertEquals(picture(state, null), picture(state, 600))
            assertEquals(picture(state, null), picture(state, 60_000))
            // It does move on the way.
            assertTrue((0L..600L).any { picture(state, it) != picture(state, null) })
        }
    }

    @Test
    fun motionMovesInWholeHalfCellSteps() {
        for (state in S.entries) {
            for (t in listOf<Long?>(null) + (0L..2_400L step 10)) {
                val p = aidenBotSpritePose(state, t)
                // Waiting's breathe is the one quarter-cell step, as the plan's table sets it.
                val moves = if (state == S.WAITING) listOf(p.rigDx, p.rigDy * 2f) else listOf(p.rigDx, p.rigDy, p.plugDx, p.glitchDx)
                for (v in moves) {
                    val steps = v / 1.5f
                    assertEquals("$state at $t moves $v", Math.round(steps).toFloat(), steps, 1e-4f)
                }
            }
        }
    }

    @Test
    fun eachStateHasItsOwnStillPose() {
        val stills = S.entries.map { picture(it, null) }
        assertEquals("no two states look alike when still", stills.size, stills.toSet().size)
        assertEquals(AidenBotSpriteEyes.HAPPY, aidenBotSpritePose(S.DONE).eyes)
        assertEquals(AidenBotSpriteEyes.WINCE, aidenBotSpritePose(S.ERROR).eyes)
        assertTrue(aidenBotSpritePose(S.THINKING).dots)
        assertTrue(aidenBotSpritePose(S.TOOL).plug)
        assertTrue(aidenBotSpritePose(S.EDITING).cursor)
    }

    // ---- Settling: working changes wait; done or error show at once, only right after work ----

    private fun TestScope.settled(script: suspend FlowCollector<S>.() -> Unit): List<Pair<Long, S>> {
        val seen = mutableListOf<Pair<Long, S>>()
        val start = currentTime
        launch { flow(script).aidenBotAvatarSettled().collect { seen += (currentTime - start) to it } }
        advanceUntilIdle()
        return seen
    }

    @Test
    fun theFirstValueShowsAtOnceAndAFinishedTurnOpensIdle() = runTest {
        assertEquals(listOf(0L to S.TOOL), settled { emit(S.TOOL) })
        assertEquals(listOf(0L to S.IDLE), settled { emit(S.DONE) })
        assertEquals(listOf(0L to S.IDLE), settled { emit(S.ERROR) })
    }

    @Test
    fun aQuickBurstOfToolsDoesNotFlicker() = runTest {
        val seen = settled {
            emit(S.THINKING)
            delay(100); emit(S.TOOL)
            delay(100); emit(S.THINKING)
            delay(1_000)
        }
        assertEquals(listOf(0L to S.THINKING), seen)
    }

    @Test
    fun aChangeThatHoldsShowsAfterTheDebounce() = runTest {
        val seen = settled {
            emit(S.THINKING)
            delay(1_000); emit(S.READING)
            delay(1_000)
        }
        assertEquals(listOf(0L to S.THINKING, 1_250L to S.READING), seen)
    }

    @Test
    fun doneAndErrorShowAtOnceBrieflyThenRestAtIdle() = runTest {
        assertEquals(
            listOf(0L to S.WRITING, 1_000L to S.DONE, 2_500L to S.IDLE),
            settled { emit(S.WRITING); delay(1_000); emit(S.DONE) }
        )
        assertEquals(
            listOf(0L to S.TOOL, 1_000L to S.ERROR, 2_500L to S.IDLE),
            settled { emit(S.TOOL); delay(1_000); emit(S.ERROR) }
        )
    }

    @Test
    fun aShownErrorHoldsItsFullMomentWhenTheTargetFlipsToDone() = runTest {
        assertEquals(
            listOf(0L to S.TOOL, 1_000L to S.ERROR, 2_500L to S.IDLE),
            settled { emit(S.TOOL); delay(1_000); emit(S.ERROR); delay(200); emit(S.DONE); delay(5_000) }
        )
    }

    @Test
    fun aTurnThatEndsBeforeAnyWorkingPoseShowsSettlesQuietly() = runTest {
        // Thinking never got past the debounce, so the end that follows is no celebration.
        assertEquals(
            listOf(0L to S.IDLE),
            settled { emit(S.IDLE); delay(1_000); emit(S.THINKING); delay(100); emit(S.DONE); delay(5_000) }
        )
    }

    @Test
    fun anErrorReportedWhileDoneShowsReplacesIt() = runTest {
        assertEquals(
            listOf(0L to S.WRITING, 1_000L to S.DONE, 1_500L to S.ERROR, 3_000L to S.IDLE),
            settled { emit(S.WRITING); delay(1_000); emit(S.DONE); delay(500); emit(S.ERROR); delay(5_000) }
        )
    }

    @Test
    fun aNewTurnDuringTheRestSkipsIdleAndAnEndWithoutWorkStaysIdle() = runTest {
        assertEquals(
            listOf(0L to S.THINKING, 1_000L to S.DONE, 2_250L to S.THINKING),
            settled { emit(S.THINKING); delay(1_000); emit(S.DONE); delay(1_000); emit(S.THINKING); delay(5_000) }
        )
        assertEquals(
            listOf(0L to S.IDLE),
            settled { emit(S.DONE); delay(1_000); emit(S.ERROR); delay(5_000) }
        )
    }
}
