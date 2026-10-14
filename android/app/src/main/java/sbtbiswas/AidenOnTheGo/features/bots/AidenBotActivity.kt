package sbtbiswas.AidenOnTheGo.features.bots

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkProperty
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.spec
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivity
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenServer

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
fun aidenBotChatActivity(server: AidenServer?, detail: AidenBotDetail?): AidenBotChatActivity? =
    if (server?.supportsBotActivity == true) detail?.chatActivity else null
