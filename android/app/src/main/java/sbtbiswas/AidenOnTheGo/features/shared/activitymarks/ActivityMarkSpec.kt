package sbtbiswas.AidenOnTheGo.features.shared.activitymarks

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size

/**
 * Aiden's activity marks, as immutable data. The geometry and timing come from
 * docs/activity-marks.md; the desktop and iOS clients draw the same tables.
 *
 * Everything the draw pass needs is precomputed here, so drawing a frame only reads
 * arrays and calls [AidenActivityMarkTrack.valueAt]. Nothing allocates per frame.
 */
enum class AidenActivityMarkKind(val wireName: String) {
    TRI_STEP("tri-step"),
    QUAD_SHUFFLE("quad-shuffle"),
    COMPOSE("compose"),
    SCAN_GRID("scan-grid"),
    GLANCE("glance"),
    BOUNCE("bounce"),
    HELIX_CALM("helix-calm"),
    HELIX_TWIST("helix-twist"),
    HELIX_SWELL("helix-swell"),
    HELIX_DUPLEX("helix-duplex"),
    HELIX_FLAT("helix-flat"),
}

enum class AidenActivityMarkProperty {
    TRANSLATE_X,
    TRANSLATE_Y,
    ROTATION_DEG,
    SCALE,
    SCALE_X,
    SCALE_Y,
    OPACITY,
}

/** A CSS-style cubic-bezier. The Compose easing is built once, here. */
class AidenCubicBezier(val x1: Float, val y1: Float, val x2: Float, val y2: Float) {
    val easing: Easing = CubicBezierEasing(x1, y1, x2, y2)
}

object AidenActivityMarkEasings {
    /** Overshoots both ends on purpose; y is outside 0..1. */
    val TURN = AidenCubicBezier(0.5f, -0.45f, 0.25f, 1.45f)
    val SHUFFLE = AidenCubicBezier(0.65f, 0f, 0.35f, 1f)
    val COMPOSE = AidenCubicBezier(0.4f, 0f, 0.2f, 1f)
    val IN_OUT = AidenCubicBezier(0.42f, 0f, 0.58f, 1f)
    val LOOK = AidenCubicBezier(0.5f, 0f, 0.3f, 1f)
    val BOUNCE = AidenCubicBezier(0.45f, 0f, 0.55f, 1f)
}

/**
 * One property of one shape or group over time. Local time is
 * `u = ((t - delay) mod duration) / duration`; [valueAt] finds the keyframe segment
 * containing `u`, eases the progress inside it, and lerps between the two values.
 *
 * [offsets] and [values] have the same length, offsets run from 0 to 1, and
 * [easings] holds one curve per segment (`offsets.size - 1`).
 */
class AidenActivityMarkTrack(
    val property: AidenActivityMarkProperty,
    val durationMs: Long,
    val delayMs: Long,
    val offsets: FloatArray,
    val values: FloatArray,
    val easings: Array<AidenCubicBezier>,
) {
    init {
        require(durationMs > 0L) { "Track duration must be positive" }
        require(offsets.size >= 2 && values.size == offsets.size) { "Track needs matching keyframes" }
        require(easings.size == offsets.size - 1) { "Track needs one easing per segment" }
    }

    fun valueAt(timeMs: Long): Float {
        val phase = ((timeMs - delayMs) % durationMs + durationMs) % durationMs
        val u = (phase.toDouble() / durationMs.toDouble()).toFloat()

        val lastSegment = offsets.size - 2
        var segment = 0
        while (segment < lastSegment && u >= offsets[segment + 1]) segment++

        val start = offsets[segment]
        val end = offsets[segment + 1]
        val from = values[segment]
        val to = values[segment + 1]
        val span = end - start
        if (span <= 0f) return to
        val progress = ((u - start) / span).coerceIn(0f, 1f)
        return from + (to - from) * easings[segment].easing.transform(progress)
    }
}

sealed interface AidenActivityMarkGeometry {
    class Circle(val cx: Float, val cy: Float, val r: Float) : AidenActivityMarkGeometry

    class RoundRect(
        val x: Float,
        val y: Float,
        val width: Float,
        val height: Float,
        val radius: Float,
    ) : AidenActivityMarkGeometry {
        val size: Size = Size(width, height)
        val corner: CornerRadius = CornerRadius(radius)
    }
}

/** A group transform (tri-step rotation, glance look) applied around [originX]/[originY]. */
class AidenActivityMarkGroup(
    val originX: Float,
    val originY: Float,
    val tracks: Array<AidenActivityMarkTrack>,
) {
    private val byProperty = indexByProperty(tracks)

    fun track(property: AidenActivityMarkProperty): AidenActivityMarkTrack? = byProperty[property.ordinal]
}

class AidenActivityMarkShape(
    val geometry: AidenActivityMarkGeometry,
    /** Origin for the shape's own rotation and scale, in view-box units. */
    val pivotX: Float,
    val pivotY: Float,
    /** Index into [AidenActivityMarkSpec.groups], or -1 for no group. */
    val groupIndex: Int,
    /** Strand alpha: 1 for most shapes, 0.55 for helix duplex strand b. */
    val strandAlpha: Float,
    val tracks: Array<AidenActivityMarkTrack>,
    /**
     * Helix · Swell second wave: a unit-amplitude translateY track. The draw pass
     * multiplies it by amp2, so the wave can follow a voice level without rebuilding.
     */
    val secondWave: AidenActivityMarkTrack? = null,
) {
    private val byProperty = indexByProperty(tracks)

    fun track(property: AidenActivityMarkProperty): AidenActivityMarkTrack? = byProperty[property.ordinal]
}

class AidenActivityMarkSpec(
    val kind: AidenActivityMarkKind,
    val groups: Array<AidenActivityMarkGroup>,
    val shapes: Array<AidenActivityMarkShape>,
    /** Whole-mark alpha. Helix flat draws at 0.45. */
    val overallAlpha: Float = 1f,
)

private fun indexByProperty(tracks: Array<AidenActivityMarkTrack>): Array<AidenActivityMarkTrack?> {
    val table = arrayOfNulls<AidenActivityMarkTrack>(AidenActivityMarkProperty.entries.size)
    for (track in tracks) {
        require(table[track.property.ordinal] == null) { "Duplicate ${track.property} track" }
        table[track.property.ordinal] = track
    }
    return table
}

private val SPECS: Map<AidenActivityMarkKind, AidenActivityMarkSpec> by lazy {
    AidenActivityMarkKind.entries.associateWith(::buildActivityMarkSpec)
}

/** The precomputed spec for this mark. Built once per kind and then cached. */
fun AidenActivityMarkKind.spec(): AidenActivityMarkSpec = SPECS.getValue(this)

/**
 * Maps a tool row to its mark. Approval waits win. Render-artifact and search-like
 * tools (find, glob, grep, list, read, search as a name segment) read as a scan.
 * Everything else is work.
 */
fun aidenActivityMarkForTool(toolName: String, awaitingApproval: Boolean): AidenActivityMarkKind {
    if (awaitingApproval) return AidenActivityMarkKind.GLANCE
    val name = toolName.lowercase()
    if (name == "render_artifact") return AidenActivityMarkKind.SCAN_GRID
    val segments = name.split('_', ':', '-')
    return if (segments.any { it in SEARCH_SEGMENTS }) {
        AidenActivityMarkKind.SCAN_GRID
    } else {
        AidenActivityMarkKind.QUAD_SHUFFLE
    }
}

private val SEARCH_SEGMENTS = setOf("find", "glob", "grep", "list", "read", "search")

// -- Spec construction. Tables below are transcribed from docs/activity-marks.md. --

private fun buildActivityMarkSpec(kind: AidenActivityMarkKind): AidenActivityMarkSpec = when (kind) {
    AidenActivityMarkKind.TRI_STEP -> triStep()
    AidenActivityMarkKind.QUAD_SHUFFLE -> quadShuffle()
    AidenActivityMarkKind.COMPOSE -> compose()
    AidenActivityMarkKind.SCAN_GRID -> scanGrid()
    AidenActivityMarkKind.GLANCE -> glance()
    AidenActivityMarkKind.BOUNCE -> bounce()
    AidenActivityMarkKind.HELIX_CALM -> helix(kind, HelixParams(amp = 3.4f, durationMs = 3600L, stepMs = 300L, zFront = 1.12f, zBack = 0.78f, opacityBack = 0.5f))
    AidenActivityMarkKind.HELIX_TWIST -> helix(kind, HelixParams(amp = 5f, durationMs = 1500L, stepMs = 375L, zFront = 1.3f, zBack = 0.55f, opacityBack = 0.3f))
    AidenActivityMarkKind.HELIX_SWELL -> helix(kind, HelixParams(amp = 3f, durationMs = 1600L, stepMs = 200L, zFront = 1.3f, zBack = 0.6f, opacityBack = 0.35f, secondWave = true))
    AidenActivityMarkKind.HELIX_DUPLEX -> helix(kind, HelixParams(amp = 5f, durationMs = 2000L, stepMs = 200L, zFront = 1.3f, zBack = 0.6f, opacityBack = 0.35f, strandBAlpha = 0.55f))
    AidenActivityMarkKind.HELIX_FLAT -> helixFlat()
}

private fun track(
    property: AidenActivityMarkProperty,
    durationMs: Long,
    delayMs: Long,
    offsets: FloatArray,
    values: FloatArray,
    easing: AidenCubicBezier,
): AidenActivityMarkTrack = AidenActivityMarkTrack(
    property = property,
    durationMs = durationMs,
    delayMs = delayMs,
    offsets = offsets,
    values = values,
    easings = Array(offsets.size - 1) { easing },
)

private fun circle(
    cx: Float,
    cy: Float,
    r: Float,
    groupIndex: Int = -1,
    strandAlpha: Float = 1f,
    tracks: Array<AidenActivityMarkTrack> = emptyArray(),
    secondWave: AidenActivityMarkTrack? = null,
): AidenActivityMarkShape = AidenActivityMarkShape(
    geometry = AidenActivityMarkGeometry.Circle(cx, cy, r),
    pivotX = cx,
    pivotY = cy,
    groupIndex = groupIndex,
    strandAlpha = strandAlpha,
    tracks = tracks,
    secondWave = secondWave,
)

private fun roundRect(
    x: Float,
    y: Float,
    width: Float,
    height: Float,
    radius: Float,
    pivotX: Float = x + width / 2f,
    pivotY: Float = y + height / 2f,
    groupIndex: Int = -1,
    tracks: Array<AidenActivityMarkTrack> = emptyArray(),
): AidenActivityMarkShape = AidenActivityMarkShape(
    geometry = AidenActivityMarkGeometry.RoundRect(x, y, width, height, radius),
    pivotX = pivotX,
    pivotY = pivotY,
    groupIndex = groupIndex,
    strandAlpha = 1f,
    tracks = tracks,
)

private fun triStep(): AidenActivityMarkSpec {
    val rotation = track(
        AidenActivityMarkProperty.ROTATION_DEG,
        durationMs = 2700L,
        delayMs = 0L,
        offsets = floatArrayOf(0f, 0.22f, 0.3333f, 0.5533f, 0.6666f, 0.8866f, 1f),
        values = floatArrayOf(0f, 120f, 120f, 240f, 240f, 360f, 360f),
        easing = AidenActivityMarkEasings.TURN,
    )
    return AidenActivityMarkSpec(
        kind = AidenActivityMarkKind.TRI_STEP,
        groups = arrayOf(AidenActivityMarkGroup(originX = 12f, originY = 12f, tracks = arrayOf(rotation))),
        shapes = arrayOf(
            circle(12f, 5.5f, 2.6f, groupIndex = 0),
            circle(17.63f, 15.25f, 2.6f, groupIndex = 0),
            circle(6.37f, 15.25f, 2.6f, groupIndex = 0),
        ),
    )
}

private fun quadShuffle(): AidenActivityMarkSpec {
    // Each circle: home, diagonal offset a, corner offset b.
    val homes = arrayOf(7f to 7f, 17f to 7f, 7f to 17f, 17f to 17f)
    val diagonals = arrayOf(-2.2f to -2.2f, -7.4f to 2.6f, 7.4f to -2.6f, 2.2f to 2.2f)
    val corners = arrayOf(10f to 0f, 0f to 10f, 0f to -10f, -10f to 0f)
    val offsets = floatArrayOf(0f, 0.18f, 0.36f, 0.56f, 0.72f, 0.90f, 1f)
    val shapes = Array(4) { i ->
        val (a, b) = diagonals[i] to corners[i]
        val xs = floatArrayOf(0f, a.first, 0f, b.first, b.first, 0f, 0f)
        val ys = floatArrayOf(0f, a.second, 0f, b.second, b.second, 0f, 0f)
        circle(
            cx = homes[i].first,
            cy = homes[i].second,
            r = 2.4f,
            tracks = arrayOf(
                track(AidenActivityMarkProperty.TRANSLATE_X, 2600L, 0L, offsets, xs, AidenActivityMarkEasings.SHUFFLE),
                track(AidenActivityMarkProperty.TRANSLATE_Y, 2600L, 0L, offsets, ys, AidenActivityMarkEasings.SHUFFLE),
            ),
        )
    }
    return AidenActivityMarkSpec(kind = AidenActivityMarkKind.QUAD_SHUFFLE, groups = emptyArray(), shapes = shapes)
}

private fun compose(): AidenActivityMarkSpec {
    val lines = arrayOf(
        Triple(5.5f, 16f, 0f),
        Triple(10.7f, 12f, 1f),
        Triple(15.9f, 14f, 2f),
    )
    val offsets = floatArrayOf(0f, 0.35f, 0.70f, 1f)
    val shapes = Array(lines.size) { i ->
        val (y, width, index) = lines[i]
        val delay = (index * 160f - 1100f).toLong()
        roundRect(
            x = 4f,
            y = y,
            width = width,
            height = 2.6f,
            radius = 1.3f,
            // Scale about the left-centre of the line.
            pivotX = 4f,
            pivotY = y + 1.3f,
            tracks = arrayOf(
                track(AidenActivityMarkProperty.SCALE_X, 2200L, delay, offsets, floatArrayOf(0.16f, 1f, 1f, 0.16f), AidenActivityMarkEasings.COMPOSE),
                track(AidenActivityMarkProperty.OPACITY, 2200L, delay, offsets, floatArrayOf(0.35f, 1f, 1f, 0.35f), AidenActivityMarkEasings.COMPOSE),
            ),
        )
    }
    return AidenActivityMarkSpec(kind = AidenActivityMarkKind.COMPOSE, groups = emptyArray(), shapes = shapes)
}

private fun scanGrid(): AidenActivityMarkSpec {
    val positions = floatArrayOf(6f, 12f, 18f)
    val offsets = floatArrayOf(0f, 0.30f, 0.70f, 1f)
    val shapes = ArrayList<AidenActivityMarkShape>(9)
    for (y in positions) {
        for ((column, x) in positions.withIndex()) {
            val delay = (column * 180L) - 450L
            shapes += circle(
                cx = x,
                cy = y,
                r = 1.9f,
                tracks = arrayOf(
                    track(AidenActivityMarkProperty.SCALE, 1500L, delay, offsets, floatArrayOf(1f, 1.18f, 1f, 1f), AidenActivityMarkEasings.IN_OUT),
                    track(AidenActivityMarkProperty.OPACITY, 1500L, delay, offsets, floatArrayOf(0.2f, 1f, 0.2f, 0.2f), AidenActivityMarkEasings.IN_OUT),
                ),
            )
        }
    }
    return AidenActivityMarkSpec(kind = AidenActivityMarkKind.SCAN_GRID, groups = emptyArray(), shapes = shapes.toTypedArray())
}

private fun glance(): AidenActivityMarkSpec {
    val look = track(
        AidenActivityMarkProperty.TRANSLATE_X,
        durationMs = 4000L,
        delayMs = 0L,
        offsets = floatArrayOf(0f, 0.14f, 0.24f, 0.40f, 0.52f, 0.68f, 0.80f, 1f),
        values = floatArrayOf(0f, 0f, -2.6f, -2.6f, 2.6f, 2.6f, 0f, 0f),
        easing = AidenActivityMarkEasings.LOOK,
    )
    val blink = { ->
        track(
            AidenActivityMarkProperty.SCALE_Y,
            durationMs = 4000L,
            delayMs = 0L,
            offsets = floatArrayOf(0f, 0.86f, 0.90f, 0.94f, 1f),
            values = floatArrayOf(1f, 1f, 0.1f, 1f, 1f),
            easing = AidenActivityMarkEasings.IN_OUT,
        )
    }
    return AidenActivityMarkSpec(
        kind = AidenActivityMarkKind.GLANCE,
        groups = arrayOf(AidenActivityMarkGroup(originX = 0f, originY = 0f, tracks = arrayOf(look))),
        shapes = arrayOf(
            roundRect(7f, 8.5f, 3.4f, 7f, 1.7f, groupIndex = 0, tracks = arrayOf(blink())),
            roundRect(13.6f, 8.5f, 3.4f, 7f, 1.7f, groupIndex = 0, tracks = arrayOf(blink())),
        ),
    )
}

private fun bounce(): AidenActivityMarkSpec {
    val shapes = Array(3) { i ->
        val cx = floatArrayOf(5.5f, 12f, 18.5f)[i]
        circle(
            cx = cx,
            cy = 13f,
            r = 2.4f,
            tracks = arrayOf(
                track(
                    AidenActivityMarkProperty.TRANSLATE_Y,
                    durationMs = 1200L,
                    delayMs = i * 130L,
                    offsets = floatArrayOf(0f, 0.27f, 0.55f, 1f),
                    values = floatArrayOf(0f, -5f, 0f, 0f),
                    easing = AidenActivityMarkEasings.BOUNCE,
                ),
            ),
        )
    }
    return AidenActivityMarkSpec(kind = AidenActivityMarkKind.BOUNCE, groups = emptyArray(), shapes = shapes)
}

private class HelixParams(
    val amp: Float,
    val durationMs: Long,
    val stepMs: Long,
    val zFront: Float,
    val zBack: Float,
    val opacityBack: Float,
    val strandBAlpha: Float = 1f,
    val secondWave: Boolean = false,
)

private fun helix(kind: AidenActivityMarkKind, params: HelixParams): AidenActivityMarkSpec {
    val columns = floatArrayOf(4f, 8f, 12f, 16f, 20f)
    val shapes = ArrayList<AidenActivityMarkShape>(10)
    // Strand b (phase 0.5) first, so strand a passes over it.
    for (strand in 0..1) {
        val phase = if (strand == 0) 0.5f else 0f
        val strandAlpha = if (strand == 0) params.strandBAlpha else 1f
        for ((column, x) in columns.withIndex()) {
            val delay = -(column * params.stepMs) - (phase * params.durationMs).toLong()
            val depthDelay = delay + params.durationMs / 4L
            val position = track(
                AidenActivityMarkProperty.TRANSLATE_Y,
                params.durationMs,
                delay,
                floatArrayOf(0f, 0.5f, 1f),
                floatArrayOf(-params.amp, params.amp, -params.amp),
                AidenActivityMarkEasings.IN_OUT,
            )
            val depthScale = track(
                AidenActivityMarkProperty.SCALE,
                params.durationMs,
                depthDelay,
                floatArrayOf(0f, 0.5f, 1f),
                floatArrayOf(params.zFront, params.zBack, params.zFront),
                AidenActivityMarkEasings.IN_OUT,
            )
            val depthOpacity = track(
                AidenActivityMarkProperty.OPACITY,
                params.durationMs,
                depthDelay,
                floatArrayOf(0f, 0.5f, 1f),
                floatArrayOf(1f, params.opacityBack, 1f),
                AidenActivityMarkEasings.IN_OUT,
            )
            val wave = if (params.secondWave) {
                track(
                    AidenActivityMarkProperty.TRANSLATE_Y,
                    durationMs = 2300L,
                    delayMs = column * -450L,
                    offsets = floatArrayOf(0f, 0.5f, 1f),
                    values = floatArrayOf(-1f, 1f, -1f),
                    easing = AidenActivityMarkEasings.IN_OUT,
                )
            } else {
                null
            }
            shapes += circle(
                cx = x,
                cy = 12f,
                r = 1.8f,
                strandAlpha = strandAlpha,
                tracks = arrayOf(position, depthScale, depthOpacity),
                secondWave = wave,
            )
        }
    }
    return AidenActivityMarkSpec(kind = kind, groups = emptyArray(), shapes = shapes.toTypedArray())
}

private fun helixFlat(): AidenActivityMarkSpec {
    val columns = floatArrayOf(4f, 8f, 12f, 16f, 20f)
    val shapes = ArrayList<AidenActivityMarkShape>(10)
    for (strand in 0..1) {
        for (x in columns) shapes += circle(cx = x, cy = 12f, r = 1.8f)
    }
    return AidenActivityMarkSpec(
        kind = AidenActivityMarkKind.HELIX_FLAT,
        groups = emptyArray(),
        shapes = shapes.toTypedArray(),
        overallAlpha = 0.45f,
    )
}
