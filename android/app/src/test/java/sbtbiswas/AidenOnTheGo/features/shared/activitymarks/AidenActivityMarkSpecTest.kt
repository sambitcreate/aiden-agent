package sbtbiswas.AidenOnTheGo.features.shared.activitymarks

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AidenActivityMarkSpecTest {
    private val tolerance = 0.001f

    private fun assertFloat(expected: Float, actual: Float) {
        assertEquals(expected, actual, tolerance)
    }

    private fun AidenActivityMarkShape.requireTrack(property: AidenActivityMarkProperty): AidenActivityMarkTrack =
        checkNotNull(track(property)) { "Expected a $property track" }

    @Test
    fun shapeCountsMatchTheSpec() {
        assertEquals(3, AidenActivityMarkKind.TRI_STEP.spec().shapes.size)
        assertEquals(4, AidenActivityMarkKind.QUAD_SHUFFLE.spec().shapes.size)
        assertEquals(3, AidenActivityMarkKind.COMPOSE.spec().shapes.size)
        assertEquals(9, AidenActivityMarkKind.SCAN_GRID.spec().shapes.size)
        assertEquals(2, AidenActivityMarkKind.GLANCE.spec().shapes.size)
        assertEquals(3, AidenActivityMarkKind.BOUNCE.spec().shapes.size)
        listOf(
            AidenActivityMarkKind.HELIX_CALM,
            AidenActivityMarkKind.HELIX_TWIST,
            AidenActivityMarkKind.HELIX_SWELL,
            AidenActivityMarkKind.HELIX_DUPLEX,
            AidenActivityMarkKind.HELIX_FLAT,
        ).forEach { kind ->
            assertEquals("$kind shape count", 10, kind.spec().shapes.size)
        }
    }

    @Test
    fun wireNamesMatchTheSharedMarkNames() {
        assertEquals(
            listOf(
                "tri-step", "quad-shuffle", "compose", "scan-grid", "glance", "bounce",
                "helix-calm", "helix-twist", "helix-swell", "helix-duplex", "helix-flat",
            ),
            AidenActivityMarkKind.entries.map { it.wireName },
        )
    }

    @Test
    fun triStepRotationIsHeldAtOneHundredTwentyDegreesAtThreeTenthsOfCycle() {
        // 0.3 of the 2700 ms cycle sits inside the 0.22 to 0.3333 hold.
        val rotation = AidenActivityMarkKind.TRI_STEP.spec().groups.single()
            .track(AidenActivityMarkProperty.ROTATION_DEG)
        assertFloat(120f, checkNotNull(rotation).valueAt(810L))
    }

    @Test
    fun quadShuffleTopLeftMovesDiagonallyAtItsKeyframe() {
        val topLeft = AidenActivityMarkKind.QUAD_SHUFFLE.spec().shapes[0]
        // 0.18 of the 2600 ms cycle.
        assertFloat(-2.2f, topLeft.requireTrack(AidenActivityMarkProperty.TRANSLATE_X).valueAt(468L))
        assertFloat(-2.2f, topLeft.requireTrack(AidenActivityMarkProperty.TRANSLATE_Y).valueAt(468L))
    }

    @Test
    fun composeLineStartsAtFullWidth() {
        val firstLine = AidenActivityMarkKind.COMPOSE.spec().shapes[0]
        assertFloat(1f, firstLine.requireTrack(AidenActivityMarkProperty.SCALE_X).valueAt(0L))
    }

    @Test
    fun bounceCircleRisesAtItsKeyframe() {
        // 0.27 of the 1200 ms cycle.
        val first = AidenActivityMarkKind.BOUNCE.spec().shapes[0]
        assertFloat(-5f, first.requireTrack(AidenActivityMarkProperty.TRANSLATE_Y).valueAt(324L))
    }

    @Test
    fun helixFlatHasNoTracksAndRestsAtReducedAlpha() {
        val spec = AidenActivityMarkKind.HELIX_FLAT.spec()
        assertTrue(spec.shapes.all { it.tracks.isEmpty() && it.secondWave == null })
        assertFloat(0.45f, spec.overallAlpha)
    }

    @Test
    fun duplexDrawsStrandBAtFiftyFivePercentInkBeforeStrandA() {
        val shapes = AidenActivityMarkKind.HELIX_DUPLEX.spec().shapes
        // Strand b is drawn first, so the first five shapes are strand b.
        assertFloat(0.55f, shapes[0].strandAlpha)
        assertFloat(1f, shapes[5].strandAlpha)
    }

    @Test
    fun scanGridFirstColumnIsLitAtRest() {
        // Column 0 starts at local phase 0.3 of its cycle, the lit peak: scale 1.18, opacity 1.
        val firstColumn = AidenActivityMarkKind.SCAN_GRID.spec().shapes[0]
        assertFloat(1.18f, firstColumn.requireTrack(AidenActivityMarkProperty.SCALE).valueAt(0L))
        assertFloat(1f, firstColumn.requireTrack(AidenActivityMarkProperty.OPACITY).valueAt(0L))
    }

    @Test
    fun trackValueRepeatsAfterEachCycle() {
        val track = AidenActivityMarkKind.BOUNCE.spec().shapes[0].requireTrack(AidenActivityMarkProperty.TRANSLATE_Y)
        assertFloat(track.valueAt(324L), track.valueAt(324L + 1200L * 4))
    }

    @Test
    fun toolRowsMapToMarksByNameAndApproval() {
        assertEquals(AidenActivityMarkKind.GLANCE, aidenActivityMarkForTool("bash", awaitingApproval = true))
        assertEquals(AidenActivityMarkKind.GLANCE, aidenActivityMarkForTool("find_files", awaitingApproval = true))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("render_artifact", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("grep", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("workspace:list", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("read-file", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("web_search", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.SCAN_GRID, aidenActivityMarkForTool("Glob", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.QUAD_SHUFFLE, aidenActivityMarkForTool("bash", awaitingApproval = false))
        assertEquals(AidenActivityMarkKind.QUAD_SHUFFLE, aidenActivityMarkForTool("findings_write", awaitingApproval = false))
    }
}
