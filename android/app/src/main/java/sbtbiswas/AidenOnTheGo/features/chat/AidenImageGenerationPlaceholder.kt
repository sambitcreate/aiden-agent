package sbtbiswas.AidenOnTheGo.features.chat

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.withFrameMillis
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

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

    /**
     * Where the lens is in its pass, in [0, 1), after [elapsedMs]. The pass count
     * accumulates across the slow-down at [LONG_RUN_AFTER_SECONDS], so the lens keeps
     * its place instead of jumping when the period changes.
     */
    fun phase(elapsedMs: Long): Float {
        val elapsed = elapsedMs.coerceAtLeast(0).toDouble()
        val switchMs = LONG_RUN_AFTER_SECONDS * 1_000.0
        val passes = if (elapsed < switchMs) elapsed / PERIOD_MS
        else switchMs / PERIOD_MS + (elapsed - switchMs) / LONG_PERIOD_MS
        return (passes - kotlin.math.floor(passes)).toFloat()
    }

    /**
     * "Generating · 12s", then "Still generating · 1m 05s" after a minute, followed by
     * " · <provider> · <model>" when the host named the model.
     */
    fun caption(elapsedSeconds: Long, model: AidenImageGenerationModelLabel? = null): String {
        val seconds = elapsedSeconds.coerceAtLeast(0)
        val time = if (seconds < LONG_RUN_AFTER_SECONDS) "Generating · ${seconds}s"
        else "Still generating · ${seconds / 60}m ${(seconds % 60).toString().padStart(2, '0')}s"
        return if (model == null) time else "$time · ${model.provider} · ${model.model}"
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

/**
 * The provider and model a `generate_image` step names in its `target`
 * ("<provider>/<model id>", split on the first slash).
 */
internal data class AidenImageGenerationModelLabel(val provider: String, val model: String) {
    companion object {
        const val MAX_TARGET_LENGTH = 160

        fun fromTarget(target: String?): AidenImageGenerationModelLabel? {
            if (target.isNullOrEmpty() || target.length > MAX_TARGET_LENGTH) return null
            if (target.any { it.isISOControl() }) return null
            val slash = target.indexOf('/')
            if (slash < 0) return null
            val provider = target.substring(0, slash).trim()
            val model = target.substring(slash + 1).trim()
            if (provider.isEmpty() || model.isEmpty()) return null
            return AidenImageGenerationModelLabel(displayName(provider), model)
        }

        /** The desktop's provider names; an unknown provider shows as sent. */
        private fun displayName(provider: String): String = when (provider.lowercase()) {
            "openrouter" -> "OpenRouter"
            "replicate" -> "Replicate"
            "fal" -> "fal"
            else -> provider
        }
    }
}

internal data class AidenImageGenerationPlaceholderItem(
    val id: String,
    val aspectRatio: AidenImageAspectRatio,
    /**
     * Milliseconds the call had been running by the latest host time in its timeline.
     * Both ends are host timestamps, so a skewed phone clock does not shift it; the view
     * adds local time from when it first saw the item.
     */
    val elapsedAtObservationMs: Long,
    val model: AidenImageGenerationModelLabel? = null
)

internal object AidenImageGenerationPlaceholderState {
    const val TOOL_NAME = "generate_image"
    const val DISPLAY_IMAGE_TOOL_NAME = "display_image"

    /**
     * One placeholder per `generate_image` call that is running, or that finished while
     * the turn still streams: the image reaches the phone with the settled message, so
     * the placeholder holds until then. Approval-pending, failed, denied and cancelled
     * calls show none.
     */
    fun items(timeline: AidenGenerationTimeline?): List<AidenImageGenerationPlaceholderItem> {
        if (timeline == null || timeline.status != AidenGenerationTimelineStatus.RUNNING) return emptyList()
        val hostNow = latestHostTime(timeline)
        return timeline.steps.filter {
            it.isGenerateImage() &&
                (it.status == AidenAgentStepStatus.RUNNING || it.status == AidenAgentStepStatus.COMPLETED)
        }.map { step ->
            AidenImageGenerationPlaceholderItem(
                id = step.toolCallId ?: step.id,
                aspectRatio = AidenImageAspectRatio.fromDetail(step.detail),
                elapsedAtObservationMs = (hostNow - step.startedAt).coerceAtLeast(0.0).toLong(),
                model = AidenImageGenerationModelLabel.fromTarget(step.target)
            )
        }
    }

    /** The newest host timestamp the timeline carries (ms); elapsed time is measured against it. */
    fun latestHostTime(timeline: AidenGenerationTimeline): Double =
        timeline.steps.fold(maxOf(timeline.startedAt, timeline.finishedAt ?: 0.0)) { latest, step ->
            maxOf(latest, step.startedAt, step.updatedAt, step.finishedAt ?: 0.0)
        }

    /**
     * Updates the generations whose settled image plays the arrival reveal. A generation
     * is armed once one of its `generate_image` calls completes; while none has (still
     * running, failed, denied, cancelled) it is not armed, so a failed call never leaves
     * a reveal behind.
     */
    fun armedArrivalReveals(armed: Set<String>, timeline: AidenGenerationTimeline?): Set<String> {
        if (timeline == null) return armed
        return if (timeline.steps.any { it.isGenerateImage() && it.status == AidenAgentStepStatus.COMPLETED }) {
            armed + timeline.generationId
        } else {
            armed - timeline.generationId
        }
    }

    /**
     * The one attachment of a settled message that plays the arrival reveal: its first
     * listed image (visual snapshots excluded). Attachments carry no tool association, so
     * when the turn also completed a `display_image` call the generated image cannot be
     * told apart and nothing reveals.
     */
    fun arrivalRevealAttachmentId(message: AidenChatMessage): String? {
        if (message.role != AidenChatRole.ASSISTANT) return null
        val steps = message.timeline?.steps ?: return null
        if (steps.none { it.isGenerateImage() && it.status == AidenAgentStepStatus.COMPLETED }) return null
        if (steps.any {
                it.kind == AidenAgentStep.Kind.TOOL && it.toolName == DISPLAY_IMAGE_TOOL_NAME &&
                    it.status == AidenAgentStepStatus.COMPLETED
            }
        ) return null
        val visuals = message.visuals.orEmpty()
        val visible = aidenVisibleMessageAttachments(message.attachments.orEmpty(), visuals)
        return aidenEligibleImageAttachments(visible, visuals).firstOrNull()?.id
    }

    private fun AidenAgentStep.isGenerateImage(): Boolean =
        kind == AidenAgentStep.Kind.TOOL && toolName == TOOL_NAME
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
    // Local start of the call: first sighting minus the host-measured elapsed time. It only
    // moves earlier, so a later timeline update (or the call completing) never restarts it.
    var sinceMs by rememberSaveable(item.id) {
        mutableLongStateOf(System.currentTimeMillis() - item.elapsedAtObservationMs)
    }
    LaunchedEffect(item.elapsedAtObservationMs) {
        sinceMs = minOf(sinceMs, System.currentTimeMillis() - item.elapsedAtObservationMs)
    }
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
                // A frame clock read only inside the layer lambdas: frames never recompose,
                // and the phase is a continuous function of elapsed time.
                var frameMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
                LaunchedEffect(Unit) {
                    while (true) withFrameMillis { frameMs = System.currentTimeMillis() }
                }
                AidenScanLens(colors, heightPx) {
                    val phase = AidenImagePlaceholderSpec.phase(frameMs - sinceMs)
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
            AidenImageGenerationCaption(sinceMs = sinceMs, model = item.model, palette = palette)
        }
    }
}

/** The ticking caption, isolated so its once-a-second update recomposes only this text. */
@Composable
private fun AidenImageGenerationCaption(
    sinceMs: Long,
    model: AidenImageGenerationModelLabel?,
    palette: AidenPalette
) {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }
    Text(
        text = AidenImagePlaceholderSpec.caption((nowMs - sinceMs) / 1_000, model),
        style = MaterialTheme.typography.labelSmall,
        color = palette.secondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
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
        // One shot: leaving composition mid-reveal ends it too, so it never replays.
        try {
            progress.animateTo(
                1f,
                if (reduceMotion) tween(AidenImagePlaceholderSpec.REDUCED_ARRIVAL_MS)
                else tween(AidenImagePlaceholderSpec.ARRIVAL_MS, easing = AidenImagePlaceholderSpec.arrivalEasing)
            )
        } finally {
            onFinished()
        }
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
