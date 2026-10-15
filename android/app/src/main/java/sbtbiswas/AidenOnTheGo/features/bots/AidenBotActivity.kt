package sbtbiswas.AidenOnTheGo.features.bots

import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMark
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkProperty
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.spec
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivity
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotQueuedMessage
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/**
 * The status line's words and marks (spec §5), in §5's order. Kept in step with
 * `renderer/shared/bot-activity.ts` and iOS by the shared fixture's `botActivity.phases`.
 */
enum class AidenBotActivityPhase(val id: String, @StringRes val word: Int, val mark: AidenActivityMarkKind) {
    PREPARING("preparing", R.string.bot_activity_preparing, AidenActivityMarkKind.BOUNCE),
    THINKING("thinking", R.string.bot_activity_thinking, AidenActivityMarkKind.TRI_STEP),
    READING("reading", R.string.bot_activity_reading, AidenActivityMarkKind.SCAN_GRID),
    PHOTO("photo", R.string.bot_activity_photo, AidenActivityMarkKind.SCAN_GRID),
    SEARCHING("searching", R.string.bot_activity_searching, AidenActivityMarkKind.SCAN_GRID),
    COMMAND("command", R.string.bot_activity_command, AidenActivityMarkKind.QUAD_SHUFFLE),
    EDITING("editing", R.string.bot_activity_editing, AidenActivityMarkKind.QUAD_SHUFFLE),
    APP("app", R.string.bot_activity_app, AidenActivityMarkKind.QUAD_SHUFFLE),
    HELPER("helper", R.string.bot_activity_helper, AidenActivityMarkKind.QUAD_SHUFFLE),
    COMPUTER("computer", R.string.bot_activity_computer, AidenActivityMarkKind.QUAD_SHUFFLE),
    REMEMBERING("remembering", R.string.bot_activity_remembering, AidenActivityMarkKind.COMPOSE),
    ROUTINE("routine", R.string.bot_activity_routine, AidenActivityMarkKind.TRI_STEP),
    WORKING("working", R.string.bot_activity_working, AidenActivityMarkKind.QUAD_SHUFFLE),
    WRITING("writing", R.string.bot_activity_writing, AidenActivityMarkKind.COMPOSE),
    WAITING("waiting", R.string.bot_activity_waiting, AidenActivityMarkKind.GLANCE),
    TIDYING("tidying", R.string.bot_activity_tidying, AidenActivityMarkKind.BOUNCE),
    STOPPING("stopping", R.string.bot_activity_stopping, AidenActivityMarkKind.BOUNCE),
    RESUMING("resuming", R.string.bot_activity_resuming, AidenActivityMarkKind.BOUNCE),
    RECONNECTING("reconnecting", R.string.bot_activity_reconnecting, AidenActivityMarkKind.BOUNCE);

    companion object {
        private val byId = entries.associateBy { it.id }

        /** An id this build doesn't know reads as Working (§5.2). */
        fun of(id: String): AidenBotActivityPhase = byId[id] ?: WORKING
    }
}

/** These change what the person should do, so Always "Thinking" keeps them. */
private val KEEPS_ITS_WORD = setOf(AidenBotActivityPhase.WAITING, AidenBotActivityPhase.STOPPING, AidenBotActivityPhase.RECONNECTING)

/** What the line shows: a phase plus, for "Using {app}", the connection's label. */
data class AidenBotActivityDisplay(val phase: AidenBotActivityPhase, val app: String?) {
    val mark: AidenActivityMarkKind get() = phase.mark
}

fun aidenBotActivityDisplay(phase: String, wording: AidenBotChatActivityWording, app: String?): AidenBotActivityDisplay {
    val known = AidenBotActivityPhase.of(phase)
    val shown = if (wording == AidenBotChatActivityWording.THINKING && known !in KEEPS_ITS_WORD) AidenBotActivityPhase.THINKING else known
    return AidenBotActivityDisplay(shown, if (shown == AidenBotActivityPhase.APP) app?.takeIf { it.isNotBlank() } else null)
}

@Composable
fun AidenBotActivityDisplay.word(): String =
    if (app != null) stringResource(R.string.bot_activity_app_named, app) else stringResource(phase.word)

const val AIDEN_BOT_ELAPSED_AFTER_MS = 20_000L

/** "18s", "1m 12s", "2m", "1h 2m": the Mac's wording (a JVM-tested presentation helper, like `AidenTurnElapsed`). */
fun aidenBotDurationLabel(ms: Long): String {
    val seconds = maxOf(1L, ms / 1_000)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    val rest = seconds % 60
    if (minutes < 60) return if (rest > 0) "${minutes}m ${rest}s" else "${minutes}m"
    val hours = minutes / 60
    val remainder = minutes % 60
    return if (remainder > 0) "${hours}h ${remainder}m" else "${hours}h"
}

/** Null before 20 seconds, and while this phone's clock reads behind the Mac's. */
fun aidenBotElapsedLabel(startedAt: Long, nowMs: Long): String? {
    val elapsed = nowMs - startedAt
    return if (elapsed >= AIDEN_BOT_ELAPSED_AFTER_MS) aidenBotDurationLabel(elapsed) else null
}

data class AidenBotAnnouncement(val text: String, val atMs: Long)

/** [shown] is what to announce now; [retryInMs] says when to offer the newest text again. */
data class AidenBotAnnouncementStep(val shown: AidenBotAnnouncement?, val retryInMs: Long?)

/** Screen readers hear a status change at most once every [gapMs] (§14). */
fun aidenBotNextAnnouncement(current: AidenBotAnnouncement?, text: String, nowMs: Long, gapMs: Long = 2_000): AidenBotAnnouncementStep {
    if (current != null && current.text == text) return AidenBotAnnouncementStep(current, null)
    if (current == null || nowMs - current.atMs >= gapMs) return AidenBotAnnouncementStep(AidenBotAnnouncement(text, nowMs), null)
    return AidenBotAnnouncementStep(current, gapMs - (nowMs - current.atMs))
}

/** The canonical face's glance (docs/activity-marks.md `glance`): [dxFraction] of the avatar's size; [blink] scales the eyes. */
data class AidenBotFaceGlance(val dxFraction: Float, val blink: Float)

private val GLANCE = AidenActivityMarkKind.GLANCE.spec()

fun aidenBotFaceGlance(timeMs: Long): AidenBotFaceGlance {
    val dx = GLANCE.groups[0].track(AidenActivityMarkProperty.TRANSLATE_X)?.valueAt(timeMs) ?: 0f
    val blink = GLANCE.shapes[0].track(AidenActivityMarkProperty.SCALE_Y)?.valueAt(timeMs) ?: 1f
    // The mark's view box is 24 wide.
    return AidenBotFaceGlance(dx / 24f, blink)
}

/**
 * A Bot's Chat activity as this phone may use it: only while the Mac announces
 * `bot-activity-v1` and this phone holds `bot:activity` now. A detail cached from another
 * pairing or before an older Mac was restored never decides what the chat shows.
 */
fun aidenBotChatActivity(server: AidenServer?, detail: AidenBotDetail?, cachedSupport: Boolean = false): AidenBotChatActivity? =
    if (aidenBotActivitySupported(server, cachedSupport)) detail?.chatActivity else null

// --- The chat's presentation (R14, R19): pure, so the JVM suite can hold it ---

/** The quiet hint above a Bot chat's composer while the Mac isn't reachable (R14). */
enum class AidenBotConnectionHint {
    /** "Connecting…": no snapshot yet, or the feed dropped. */
    CONNECTING,
    /** The first read failed: say so with Try again. The chat stays usable and keeps reconnecting. */
    UNREACHABLE,
    /** The Mac refused this phone (401/403) on the first read: no "Mac nearby", and no Try again. */
    NO_ACCESS
}

/**
 * The hint to show, or null when connected. While a turn runs the status line already says
 * "Reconnecting to your Mac", so the hint stays out of its way; a Bot gone from the Mac says
 * that instead.
 */
fun aidenBotConnectionHint(ui: AidenBotSessionUiState, nowMs: Long): AidenBotConnectionHint? {
    if (ui.botMissing || !ui.isConnecting) return null
    if (aidenBotStatusLine(ui, nowMs)?.display?.phase == AidenBotActivityPhase.RECONNECTING) return null
    return when {
        !ui.hasLoaded && ui.accessLost -> AidenBotConnectionHint.NO_ACCESS
        !ui.hasLoaded && ui.loadFailed -> AidenBotConnectionHint.UNREACHABLE
        else -> AidenBotConnectionHint.CONNECTING
    }
}

/** Transcript placeholders while a chat opens with nothing cached. */
enum class AidenBotSkeletonLook { HIDDEN, SHIMMERING, STILL }

/** Skeletons shimmer while the first read is on its way and hold still once it has failed, never a spinner. */
fun aidenBotSkeletonLook(ui: AidenBotSessionUiState): AidenBotSkeletonLook = when {
    !ui.showsSkeleton || ui.botMissing -> AidenBotSkeletonLook.HIDDEN
    ui.loadFailed -> AidenBotSkeletonLook.STILL
    else -> AidenBotSkeletonLook.SHIMMERING
}

/** The small line under a bubble the Mac's transcript doesn't hold yet. */
enum class AidenBotPendingCaption { QUEUED, SENDING, FAILED }

/** How a waiting bubble draws: [faded] for one not yet in the reply, with an optional caption. */
data class AidenBotPendingBubble(val faded: Boolean, val caption: AidenBotPendingCaption?)

/** A Queued message waits for the reply; a steer has already joined it, so it reads as sent. */
fun aidenBotQueuedBubble(mode: AidenStreamInputMode): AidenBotPendingBubble =
    if (mode == AidenStreamInputMode.QUEUE) AidenBotPendingBubble(true, AidenBotPendingCaption.QUEUED)
    else AidenBotPendingBubble(false, null)

fun aidenBotOutgoingBubble(look: AidenBotOutgoingLook): AidenBotPendingBubble = when (look) {
    AidenBotOutgoingLook.Sending -> AidenBotPendingBubble(true, AidenBotPendingCaption.SENDING)
    AidenBotOutgoingLook.Sent -> AidenBotPendingBubble(false, null)
    is AidenBotOutgoingLook.Queued -> aidenBotQueuedBubble(look.mode)
    AidenBotOutgoingLook.Failed -> AidenBotPendingBubble(false, AidenBotPendingCaption.FAILED)
}

data class AidenBotBubbleColors(val container: Color, val content: Color)

/**
 * The Bot screens' quiet text: [caption] for "Sending…", "Queued" and the connection hint,
 * [link] for Try again, [error] for an inline error ("Couldn't save", a destructive menu label).
 * All come from the scheme and read at 4.5:1 or better in every theme where they are drawn: the
 * accent alone doesn't in some light themes, and neither does the danger colour (about 3:1).
 */
data class AidenBotChatTextColors(val caption: Color, val link: Color, val error: Color)

fun aidenBotChatTextColors(scheme: ColorScheme): AidenBotChatTextColors = AidenBotChatTextColors(
    caption = scheme.onSurfaceVariant,
    link = scheme.secondary,
    // The page, its cards and sheets, and an error's own tint.
    error = aidenReadableInk(
        scheme.error,
        toward = scheme.onSurface,
        on = listOf(scheme.background, scheme.surface, scheme.surfaceContainer, scheme.surfaceBright, scheme.errorContainer)
    )
)

/**
 * [ink] moved toward [toward] just far enough to read at [ratio] on every colour in [on], so it
 * keeps as much of its own colour as it can. [toward] itself if nothing short of it does.
 */
fun aidenReadableInk(ink: Color, toward: Color, on: List<Color>, ratio: Float = 4.5f): Color {
    val steps = 40
    for (step in 0..steps) {
        val candidate = androidx.compose.ui.graphics.lerp(ink, toward, step / steps.toFloat())
        if (on.all { AidenPalette.contrastRatio(candidate, it) >= ratio }) return candidate
    }
    return toward
}

/** [AidenBotChatTextColors.error] for the theme in use: inline error text on the Bot screens. */
@Composable
fun aidenBotErrorTextColor(): Color {
    val scheme = MaterialTheme.colorScheme
    return remember(scheme) { aidenBotChatTextColors(scheme).error }
}

/**
 * Whether new rows should scroll the chat to its end: only when the person is already at (or
 * within [slack] rows of) the end, or just sent something themselves. Reading back stays put.
 */
fun aidenBotFollowsTranscriptEnd(lastVisibleIndex: Int, totalCount: Int, justSent: Boolean, slack: Int = 2): Boolean =
    justSent || totalCount == 0 || lastVisibleIndex >= totalCount - 1 - slack

/**
 * The person's bubble: the accent fill once it's in the reply, the tonal accent container
 * while it waits. The container pair is opaque, so the words keep their contrast; the bubble
 * is never dimmed with alpha.
 */
fun aidenBotUserBubbleColors(scheme: ColorScheme, faded: Boolean): AidenBotBubbleColors =
    if (faded) AidenBotBubbleColors(scheme.primaryContainer, scheme.onPrimaryContainer)
    else AidenBotBubbleColors(scheme.primary, scheme.onPrimary)

/** The Steer/Queue choice: the person's pick while the Bot works, Queue again once the turn ends. */
fun aidenBotBusyMode(current: AidenStreamInputMode, isRunning: Boolean): AidenStreamInputMode =
    if (isRunning) current else AidenStreamInputMode.QUEUE

/**
 * How a Bot's avatar says it is working (R8, R19). A canonical face glances; a photo can't,
 * and a face held still by Reduce Motion or battery saver can't either, so both wear the
 * glance badge instead, which holds its still pose when motion is off. Nothing moves while
 * the app isn't in front.
 */
data class AidenBotFaceMotion(val glances: Boolean, val badge: Boolean, val badgeAnimates: Boolean)

fun aidenBotFaceMotion(
    working: Boolean,
    photo: Boolean,
    reduceMotion: Boolean,
    powerSave: Boolean,
    resumed: Boolean
): AidenBotFaceMotion {
    if (!working) return AidenBotFaceMotion(glances = false, badge = false, badgeAnimates = false)
    val still = reduceMotion || powerSave
    val badge = photo || still
    return AidenBotFaceMotion(glances = !photo && !still && resumed, badge = badge, badgeAnimates = badge && !still && resumed)
}

/** True while the app is in front; marks, faces and shimmers hold still otherwise. */
@Composable
internal fun aidenBotIsResumed(): Boolean {
    val state by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    return state.isAtLeast(Lifecycle.State.RESUMED)
}

/** Holds the last line shown, so the line fades out with its words rather than blank. */
private class AidenBotLastLine(var line: AidenBotStatusLineState? = null)

/** Tags for UI tests. */
object AidenBotStatusLineTags {
    const val LINE = "bot_status_line"
}

/**
 * The status line while a Bot works (spec §12): a native activity mark and the shared word,
 * plus the elapsed time after 20 seconds. No steps and no Stop (Stop stays in the top bar).
 * Its accessible name is the word alone and the elapsed time is its state (as iOS's
 * accessibility value, FR-m8). The word is announced at most once every 2 seconds, and the
 * elapsed time never is; the announcer starts over each time the line hides.
 */
@Composable
fun AidenBotStatusLine(ui: AidenBotSessionUiState) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val resumed = aidenBotIsResumed()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val startedAt = ui.session?.activity?.startedAt
    // Elapsed ticks once a second while a run has a start time, and rests in the background.
    LaunchedEffect(startedAt, resumed) {
        if (startedAt == null || !resumed) return@LaunchedEffect
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val line = aidenBotStatusLine(ui, now)
    val last = remember { AidenBotLastLine() }
    if (line != null) last.line = line
    val word = line?.display?.word()
    var announced by remember { mutableStateOf<AidenBotAnnouncement?>(null) }
    val view = LocalView.current
    // An explicit announcement, like iOS: the line's own node changes every second with its elapsed state.
    LaunchedEffect(announced?.text) {
        @Suppress("DEPRECATION")
        announced?.text?.let { view.announceForAccessibility(it) }
    }
    LaunchedEffect(word) {
        if (word == null) {
            announced = null
            return@LaunchedEffect
        }
        val step = aidenBotNextAnnouncement(announced, word, System.currentTimeMillis())
        announced = step.shown
        step.retryInMs?.let {
            delay(it)
            announced = aidenBotNextAnnouncement(announced, word, System.currentTimeMillis()).shown
        }
    }
    AnimatedVisibility(
        visible = line != null,
        enter = fadeIn(AidenMotion.short(reduceMotion)) + expandVertically(AidenMotion.spatial(reduceMotion)),
        exit = fadeOut(AidenMotion.short(reduceMotion)) + shrinkVertically(AidenMotion.spatial(reduceMotion))
    ) {
        val shown = line ?: last.line ?: return@AnimatedVisibility
        val shownWord = shown.display.word()
        // The mark grows with the person's text size.
        val markSize = 18.dp * LocalDensity.current.fontScale
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp)
                .testTag(AidenBotStatusLineTags.LINE)
                .clearAndSetSemantics {
                    contentDescription = shownWord
                    shown.elapsed?.let { stateDescription = it }
                }
        ) {
            AidenActivityMark(mark = shown.display.mark, size = markSize, active = resumed, color = palette.secondary)
            Text(
                text = shown.elapsed?.let { stringResource(R.string.bot_activity_status_elapsed, shownWord, it) } ?: shownWord,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary
            )
        }
    }
}

/** A person's bubble the Mac's transcript doesn't hold yet, aligned like their sent ones. */
@Composable
private fun AidenBotPendingBubbleView(
    text: String,
    faded: Boolean,
    modifier: Modifier = Modifier,
    caption: @Composable () -> Unit = {}
) {
    val colors = aidenBotUserBubbleColors(MaterialTheme.colorScheme, faded)
    Column(horizontalAlignment = Alignment.End, modifier = modifier.fillMaxWidth()) {
        Surface(color = colors.container, shape = AidenBotUserBubbleShape, modifier = Modifier.widthIn(max = 320.dp)) {
            Text(
                text,
                style = MaterialTheme.typography.bodyLarge,
                color = colors.content,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)
            )
        }
        caption()
    }
}

@Composable
private fun AidenBotPendingCaptionText(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = aidenBotChatTextColors(MaterialTheme.colorScheme).caption,
        modifier = Modifier.padding(top = 2.dp, end = 4.dp)
    )
}

/** The person's waiting message: faded with "Queued", or a steer shown as a normal bubble. */
@Composable
fun AidenBotQueuedBubble(message: AidenBotQueuedMessage) {
    AidenBotQueuedLook(message.text, message.mode)
}

@Composable
private fun AidenBotQueuedLook(text: String, mode: AidenStreamInputMode) {
    val look = aidenBotQueuedBubble(mode)
    val hint = stringResource(R.string.bot_session_queued_hint)
    val queued = look.caption == AidenBotPendingCaption.QUEUED
    AidenBotPendingBubbleView(
        text = text,
        faded = look.faded,
        modifier = Modifier.semantics(mergeDescendants = true) { if (queued) stateDescription = hint }
    ) {
        if (queued) AidenBotPendingCaptionText(stringResource(R.string.bot_session_queued))
    }
}

/**
 * A message the person sent from this phone, before the Mac's transcript shows it (R14):
 * faded with "Sending…", Queued while the Bot works, or "Couldn't send" with Try again and
 * remove, each a full touch target.
 */
@Composable
fun AidenBotOutgoingBubble(
    message: AidenBotOutgoingMessage,
    look: AidenBotOutgoingLook,
    canRetry: Boolean,
    onRetry: () -> Unit,
    onRemove: () -> Unit
) {
    val palette = AidenTheme.palette
    if (look is AidenBotOutgoingLook.Queued) {
        AidenBotQueuedLook(message.text, look.mode)
        return
    }
    val bubble = aidenBotOutgoingBubble(look)
    val text = aidenBotChatTextColors(MaterialTheme.colorScheme)
    when (bubble.caption) {
        AidenBotPendingCaption.FAILED -> {
            val failed = stringResource(R.string.bot_session_send_failed)
            Column(Modifier.fillMaxWidth()) {
                // TalkBack reads the message with its state, then offers Try again and remove.
                AidenBotPendingBubbleView(
                    message.text,
                    faded = bubble.faded,
                    modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = failed }
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.align(Alignment.End)) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = palette.danger, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(failed, style = MaterialTheme.typography.labelMedium, color = text.caption, modifier = Modifier.clearAndSetSemantics {})
                Text(
                    stringResource(R.string.bot_session_send_failed_separator),
                    style = MaterialTheme.typography.labelMedium,
                    color = text.caption,
                    modifier = Modifier.padding(start = 4.dp).clearAndSetSemantics {}
                )
                TextButton(
                    onClick = onRetry,
                    enabled = canRetry,
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget)
                ) {
                    Text(stringResource(R.string.bot_session_try_again), style = MaterialTheme.typography.labelLarge, color = if (canRetry) text.link else text.caption)
                }
                IconButton(onClick = onRemove, modifier = Modifier.size(AidenUi.MinimumTouchTarget)) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.bot_session_remove_message), tint = text.caption, modifier = Modifier.size(18.dp))
                }
                }
            }
        }
        AidenBotPendingCaption.SENDING -> AidenBotPendingBubbleView(
            message.text,
            faded = bubble.faded,
            modifier = Modifier.semantics(mergeDescendants = true) {}
        ) {
            AidenBotPendingCaptionText(stringResource(R.string.bot_session_sending))
        }
        else -> AidenBotPendingBubbleView(message.text, faded = bubble.faded)
    }
}

/**
 * A quiet line above the composer while the Mac isn't reachable, never a blocking screen (R14).
 * It slides in and out; Try again shows it is trying at once (the hint goes back to "Connecting…").
 */
@Composable
fun AidenBotConnectionHintRow(hint: AidenBotConnectionHint?, onTryAgain: () -> Unit) {
    val reduceMotion = aidenReduceMotion()
    // Holds the last hint so the row fades out with its words rather than blank.
    var shown by remember { mutableStateOf(hint) }
    if (hint != null) shown = hint
    AnimatedVisibility(
        visible = hint != null,
        enter = fadeIn(AidenMotion.short(reduceMotion)) + expandVertically(AidenMotion.spatial(reduceMotion)),
        exit = fadeOut(AidenMotion.short(reduceMotion)) + shrinkVertically(AidenMotion.spatial(reduceMotion))
    ) {
        shown?.let { AidenBotConnectionHintContent(it, onTryAgain) }
    }
}

@Composable
private fun AidenBotConnectionHintContent(hint: AidenBotConnectionHint, onTryAgain: () -> Unit) {
    val text = aidenBotChatTextColors(MaterialTheme.colorScheme)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .heightIn(min = 24.dp)
            .semantics { liveRegion = LiveRegionMode.Polite }
    ) {
        when (hint) {
            AidenBotConnectionHint.CONNECTING -> Text(
                stringResource(R.string.bot_session_connecting),
                style = MaterialTheme.typography.labelMedium,
                color = text.caption
            )
            AidenBotConnectionHint.NO_ACCESS -> Text(
                stringResource(R.string.bot_session_load_no_access),
                style = MaterialTheme.typography.labelMedium,
                color = text.caption,
                textAlign = TextAlign.Center
            )
            AidenBotConnectionHint.UNREACHABLE -> {
                Text(
                    stringResource(R.string.bot_session_load_failed),
                    style = MaterialTheme.typography.labelMedium,
                    color = text.caption,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f, fill = false)
                )
                TextButton(
                    onClick = onTryAgain,
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget)
                ) {
                    Text(stringResource(R.string.bot_session_try_again), style = MaterialTheme.typography.labelLarge, color = text.link)
                }
            }
        }
    }
}
