package sbtbiswas.AidenOnTheGo.features.chat

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import java.time.Duration
import java.time.Instant

/**
 * The "Lens" scan placeholder numbers. They mirror the desktop spec module
 * `renderer/shared/image-generation/placeholder-spec.ts`; change them there and in
 * iOS `AidenImageGenerationPlaceholder.swift` together.
 */
internal object AidenImagePlaceholderSpec {
    const val DOT_PITCH_DP = 12f
    const val DIM_DOT_RADIUS_DP = 1f
    const val LIT_DOT_RADIUS_DP = 1.1f
    /** Lens window height as a fraction of the placeholder height. */
    const val LENS_HEIGHT_FRACTION = 0.34f
    const val PERIOD_MS = 2_800
    /** After [LONG_RUN_AFTER_SECONDS] the pass slows and the caption says "Still generating". */
    const val LONG_PERIOD_MS = 5_200
    const val LONG_RUN_AFTER_SECONDS = 60L
    /** The lens travels during the first 78% of a period, then rests. */
    const val TRAVEL_FRACTION = 0.78f
    val travelEasing = CubicBezierEasing(0.55f, 0.06f, 0.3f, 1f)
    /** Still pose: the lens window's top sits at 80% of its own height (lens rests ~40%). */
    const val STILL_LENS_TOP_FRACTION = 0.8f
    const val EDGE_GLOW_DP = 10f
    const val EDGE_INSET_FRACTION = 0.06f
    const val ARRIVAL_MS = 720
    val arrivalEasing = CubicBezierEasing(0.65f, 0.05f, 0.25f, 1f)
    const val REDUCED_ARRIVAL_MS = 260
    const val CORNER_RADIUS_DP = 16f

    fun periodMs(elapsedSeconds: Long): Int =
        if (elapsedSeconds >= LONG_RUN_AFTER_SECONDS) LONG_PERIOD_MS else PERIOD_MS

    /** "Generating · 12s", then "Still generating · 1m 05s" after a minute. */
    fun caption(elapsedSeconds: Long): String {
        val seconds = elapsedSeconds.coerceAtLeast(0)
        if (seconds < LONG_RUN_AFTER_SECONDS) return "Generating · ${seconds}s"
        return "Still generating · ${seconds / 60}m ${(seconds % 60).toString().padStart(2, '0')}s"
    }

    /** Lens travel progress (0 at the top, 1 past the bottom) for a phase in [0, 1). */
    fun lensProgress(phase: Float): Float {
        val clamped = phase.coerceIn(0f, 1f)
        if (clamped >= TRAVEL_FRACTION) return 1f
        return travelEasing.transform(clamped / TRAVEL_FRACTION)
    }

    /** Top of the lens window: just above the placeholder at 0, just below it at 1. */
    fun lensTop(progress: Float, height: Float): Float {
        val lens = height * LENS_HEIGHT_FRACTION
        return -lens + progress * (height + lens)
    }

    fun stillLensTop(height: Float): Float = height * LENS_HEIGHT_FRACTION * STILL_LENS_TOP_FRACTION
}

/** The shapes `generate_image` accepts (desktop `IMAGE_ASPECT_RATIOS`). */
internal enum class AidenImageAspectRatio(val wire: String, val widthOverHeight: Float, val maxWidthDp: Int) {
    SQUARE("1:1", 1f, 300),
    LANDSCAPE_16_9("16:9", 16f / 9f, 360),
    PORTRAIT_9_16("9:16", 9f / 16f, 190),
    LANDSCAPE_4_3("4:3", 4f / 3f, 340),
    PORTRAIT_3_4("3:4", 3f / 4f, 240),
    LANDSCAPE_3_2("3:2", 3f / 2f, 360),
    PORTRAIT_2_3("2:3", 2f / 3f, 220);

    companion object {
        /** The host projects only the requested ratio into `detail`; else square. */
        fun fromDetail(detail: String?): AidenImageAspectRatio =
            entries.firstOrNull { it.wire == detail } ?: SQUARE
    }
}

internal enum class AidenImagePlaceholderMotion {
    ANIMATED,
    STILL;

    companion object {
        fun resolve(reduceMotion: Boolean, powerSaveMode: Boolean): AidenImagePlaceholderMotion =
            if (reduceMotion || powerSaveMode) STILL else ANIMATED
    }
}

internal data class AidenImageGenerationPlaceholderItem(
    val id: String,
    val aspectRatio: AidenImageAspectRatio,
    /** Host time of the step's last status change (when it started running). */
    val runningSince: Instant
)

internal object AidenImageGenerationPlaceholderState {
    const val TOOL_NAME = "generate_image"

    /**
     * One placeholder per `generate_image` call that is running, or that finished while
     * the turn still streams: the image reaches the phone with the settled message, so
     * the placeholder holds until then. Approval-pending, failed, denied and cancelled
     * calls show none.
     */
    fun items(timeline: AidenGenerationTimeline?): List<AidenImageGenerationPlaceholderItem> {
        if (timeline == null || timeline.status != AidenGenerationTimelineStatus.RUNNING) return emptyList()
        return timeline.steps.filter { it.isWatchedImageGeneration() }.map { step ->
            AidenImageGenerationPlaceholderItem(
                id = step.toolCallId ?: step.id,
                aspectRatio = AidenImageAspectRatio.fromDetail(step.detail),
                runningSince = Instant.ofEpochMilli(step.updatedAt.toLong())
            )
        }
    }

    /** The generation whose settled image plays the arrival reveal. */
    fun arrivalRevealGenerationId(timeline: AidenGenerationTimeline?): String? =
        timeline?.takeIf { t -> t.steps.any { it.isWatchedImageGeneration() } }?.generationId

    private fun AidenAgentStep.isWatchedImageGeneration(): Boolean =
        kind == AidenAgentStep.Kind.TOOL && toolName == TOOL_NAME &&
            (status == AidenAgentStepStatus.RUNNING || status == AidenAgentStepStatus.COMPLETED)
}

/** True while Android battery saver is on; tracks changes while composed. */
@Composable
internal fun aidenPowerSaveMode(): Boolean {
    val context = LocalContext.current
    val powerManager = remember(context) { context.getSystemService(PowerManager::class.java) }
    var powerSave by remember { mutableStateOf(powerManager?.isPowerSaveMode == true) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                powerSave = powerManager?.isPowerSaveMode == true
            }
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        onDispose { context.unregisterReceiver(receiver) }
    }
    return powerSave
}

private class AidenScanColors(palette: AidenPalette) {
    private val dark = palette.canvas.luminance() < 0.5f
    val canvas = palette.canvas
    val fill = palette.foreground.copy(alpha = if (dark) 0.06f else 0.07f)
    val dot = palette.foreground.copy(alpha = if (dark) 0.10f else 0.16f)
    val litDot = palette.foreground.copy(alpha = if (dark) 0.62f else 0.55f)
    val beam = if (dark) palette.foreground.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.55f)
    val vignette = if (dark) Color.Black.copy(alpha = 0.18f) else palette.foreground.copy(alpha = 0.05f)
    val edge = palette.accent
}

private fun DrawScope.drawDots(color: Color, radiusDp: Float) {
    val pitch = AidenImagePlaceholderSpec.DOT_PITCH_DP.dp.toPx()
    val radius = radiusDp.dp.toPx()
    var y = pitch / 2
    while (y < size.height) {
        var x = pitch / 2
        while (x < size.width) {
            drawCircle(color, radius, Offset(x, y))
            x += pitch
        }
        y += pitch
    }
}

/** Static layers, drawn once per size: canvas fill, dim dot grid and vignette. */
private fun Modifier.aidenScanBase(colors: AidenScanColors): Modifier = drawWithCache {
    val vignette = Brush.radialGradient(
        0.55f to Color.Transparent,
        1f to colors.vignette,
        center = Offset(size.width / 2, size.height * 0.4f),
        radius = maxOf(size.width, size.height) * 0.75f
    )
    onDrawBehind {
        drawRect(colors.canvas)
        drawRect(colors.fill)
        drawDots(colors.dot, AidenImagePlaceholderSpec.DIM_DOT_RADIUS_DP)
        drawRect(vignette)
    }
}

private fun DrawScope.drawEdge(color: Color, y: Float) {
    val inset = size.width * AidenImagePlaceholderSpec.EDGE_INSET_FRACTION
    val glow = AidenImagePlaceholderSpec.EDGE_GLOW_DP.dp.toPx()
    val line = Brush.horizontalGradient(
        0f to Color.Transparent, 0.22f to color, 0.78f to color, 1f to Color.Transparent,
        startX = inset, endX = size.width - inset
    )
    drawRect(
        Brush.verticalGradient(
            0f to Color.Transparent, 0.5f to color.copy(alpha = 0.3f), 1f to Color.Transparent,
            startY = y - glow / 2, endY = y + glow / 2
        ),
        topLeft = Offset(inset, y - glow / 2),
        size = Size(size.width - 2 * inset, glow)
    )
    drawRect(line, topLeft = Offset(inset, y - 1.dp.toPx()), size = Size(size.width - 2 * inset, 1.dp.toPx()), alpha = 0.85f)
}

/**
 * The lens: a window whose layers are drawn once per size (beam glow, top-fade mask,
 * accent edge) and moved only through `graphicsLayer.translationY`. Inside it, a
 * full-height bright dot grid counter-translates by the same amount, so the dots stay
 * fixed and light up as the window passes. [top] is read only in layer blocks, so an
 * animation frame never recomposes or redraws.
 */
@Composable
private fun AidenScanLens(colors: AidenScanColors, heightPx: Float, top: () -> Float) {
    val density = LocalDensity.current
    val placeholderHeight = with(density) { heightPx.toDp() }
    val lensHeight = with(density) { (heightPx * AidenImagePlaceholderSpec.LENS_HEIGHT_FRACTION).toDp() }
    Box(
        Modifier
            .fillMaxWidth()
            .height(lensHeight)
            .graphicsLayer { translationY = top() }
    ) {
        Box(
            Modifier
                .matchParentSize()
                .graphicsLayer {
                    clip = true
                    compositingStrategy = CompositingStrategy.Offscreen
                }
                .drawWithCache {
                    val glow = Brush.verticalGradient(listOf(Color.Transparent, colors.beam))
                    val mask = Brush.verticalGradient(
                        0f to Color.Transparent, 0.7f to Color.Black, 0.96f to Color.Black, 1f to Color.Transparent
                    )
                    onDrawWithContent {
                        drawRect(glow)
                        drawContent()
                        drawRect(mask, blendMode = BlendMode.DstIn)
                    }
                }
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .wrapContentHeight(Alignment.Top, unbounded = true)
                    .height(placeholderHeight)
                    .graphicsLayer { translationY = -top() }
                    .drawWithCache {
                        onDrawBehind { drawDots(colors.litDot, AidenImagePlaceholderSpec.LIT_DOT_RADIUS_DP) }
                    }
            )
        }
        Box(
            Modifier
                .matchParentSize()
                .drawWithCache { onDrawBehind { drawEdge(colors.edge, size.height) } }
        )
    }
}

/** Live placeholder for one running `generate_image` call. */
@Composable
internal fun AidenImageGenerationPlaceholder(
    item: AidenImageGenerationPlaceholderItem,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    val motion = AidenImagePlaceholderMotion.resolve(aidenReduceMotion(), aidenPowerSaveMode())
    val colors = remember(palette) { AidenScanColors(palette) }
    // The first observed start; a later status change must not restart the clock.
    val since = rememberSaveable(item.id) { item.runningSince.toEpochMilli() }
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(since) {
        while (true) {
            now = Instant.now()
            delay(1_000)
        }
    }
    val elapsed = Duration.between(Instant.ofEpochMilli(since), now).seconds.coerceAtLeast(0)
    val description = stringResource(R.string.chat_image_generation_placeholder, item.aspectRatio.wire)

    Column(
        verticalArrangement = Arrangement.spacedBy(7.dp),
        modifier = modifier
            .widthIn(max = item.aspectRatio.maxWidthDp.dp)
            .fillMaxWidth()
            .testTag("aiden.imageGeneration.placeholder")
            .clearAndSetSemantics { contentDescription = description }
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(item.aspectRatio.widthOverHeight)
                .clip(RoundedCornerShape(AidenImagePlaceholderSpec.CORNER_RADIUS_DP.dp))
                .aidenScanBase(colors)
        ) {
            val heightPx = constraints.maxHeight.toFloat()
            if (motion == AidenImagePlaceholderMotion.STILL) {
                val still = AidenImagePlaceholderSpec.stillLensTop(heightPx)
                AidenScanLens(colors, heightPx) { still }
            } else {
                val periodMs = AidenImagePlaceholderSpec.periodMs(elapsed)
                val transition = rememberInfiniteTransition(label = "aiden_image_scan")
                val phase by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(tween(periodMs, easing = LinearEasing), RepeatMode.Restart),
                    label = "aiden_image_scan_phase"
                )
                // Read only inside the layer/draw lambdas, so a frame never recomposes.
                AidenScanLens(colors, heightPx) {
                    AidenImagePlaceholderSpec.lensTop(AidenImagePlaceholderSpec.lensProgress(phase), heightPx)
                }
            }
            Text(
                text = item.aspectRatio.wire,
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(10.dp)
                    .background(palette.canvas.copy(alpha = 0.7f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).background(palette.accent.copy(alpha = 0.9f), CircleShape))
            Text(
                text = AidenImagePlaceholderSpec.caption(elapsed),
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary
            )
        }
    }
}

/** The live turn's image placeholders, each spaced below the activity above it. */
@Composable
internal fun AidenImageGenerationPlaceholderList(
    items: List<AidenImageGenerationPlaceholderItem>,
    palette: AidenPalette
) {
    items.forEach { item ->
        key(item.id) {
            AidenImageGenerationPlaceholder(item, palette, Modifier.padding(top = 8.dp, bottom = 4.dp))
        }
    }
}

/**
 * One-shot reveal over a freshly delivered generated image: the scan cover slides down
 * beneath an accent edge, or the image fades in under Reduce Motion.
 */
internal fun Modifier.aidenImageArrivalReveal(
    active: Boolean,
    palette: AidenPalette,
    onFinished: () -> Unit
): Modifier = composed {
    if (!active) return@composed this
    val reduceMotion = aidenReduceMotion()
    val colors = remember(palette) { AidenScanColors(palette) }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(
            1f,
            if (reduceMotion) tween(AidenImagePlaceholderSpec.REDUCED_ARRIVAL_MS)
            else tween(AidenImagePlaceholderSpec.ARRIVAL_MS, easing = AidenImagePlaceholderSpec.arrivalEasing)
        )
        onFinished()
    }
    if (reduceMotion) {
        graphicsLayer { alpha = progress.value }
    } else {
        drawWithCache {
            val vignette = Brush.radialGradient(
                0.55f to Color.Transparent,
                1f to colors.vignette,
                center = Offset(size.width / 2, size.height * 0.4f),
                radius = maxOf(size.width, size.height) * 0.75f
            )
            onDrawWithContent {
                drawContent()
                val offset = size.height * progress.value
                if (offset < size.height) {
                    clipRect(top = offset) {
                        translate(top = offset) {
                            drawRect(colors.canvas)
                            drawRect(colors.fill)
                            drawDots(colors.dot, AidenImagePlaceholderSpec.DIM_DOT_RADIUS_DP)
                            drawRect(vignette)
                        }
                    }
                    if (progress.value > 0f) drawEdge(colors.edge, offset)
                }
            }
        }
    }
}
