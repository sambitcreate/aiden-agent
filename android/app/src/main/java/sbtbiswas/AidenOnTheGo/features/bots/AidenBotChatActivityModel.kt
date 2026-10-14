package sbtbiswas.AidenOnTheGo.features.bots

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivity
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityLevel
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotIdentityPatch
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode

// Advanced → Chat activity (spec §7, contract revision 30): the model behind the page.
// The screen itself is `AidenBotChatActivityScreen.kt`; the looping preview is `AidenBotChatActivityPreviewCard.kt`.

@get:StringRes
val AidenBotChatActivityLevel.label: Int
    get() = when (this) {
        AidenBotChatActivityLevel.QUIET -> R.string.bot_chat_activity_level_quiet
        AidenBotChatActivityLevel.SUMMARY -> R.string.bot_chat_activity_level_summary
        AidenBotChatActivityLevel.DETAILED -> R.string.bot_chat_activity_level_detailed
    }

@get:StringRes
val AidenBotChatActivityLevel.detail: Int
    get() = when (this) {
        AidenBotChatActivityLevel.QUIET -> R.string.bot_chat_activity_level_quiet_detail
        AidenBotChatActivityLevel.SUMMARY -> R.string.bot_chat_activity_level_summary_detail
        AidenBotChatActivityLevel.DETAILED -> R.string.bot_chat_activity_level_detailed_detail
    }

@get:StringRes
val AidenBotChatActivityWording.label: Int
    get() = when (this) {
        AidenBotChatActivityWording.FOLLOWS -> R.string.bot_chat_activity_wording_follows
        AidenBotChatActivityWording.THINKING -> R.string.bot_chat_activity_wording_thinking
    }

@get:StringRes
val AidenBotChatActivityWording.detail: Int
    get() = when (this) {
        AidenBotChatActivityWording.FOLLOWS -> R.string.bot_chat_activity_wording_follows_detail
        AidenBotChatActivityWording.THINKING -> R.string.bot_chat_activity_wording_thinking_detail
    }

/** Advanced's trailing value: "Quiet · Follows the work". */
@Composable
fun aidenBotChatActivitySummary(value: AidenBotChatActivity?): String {
    val resolved = value ?: AidenBotChatActivity.DEFAULT
    return stringResource(R.string.bot_chat_activity_value, stringResource(resolved.level.label), stringResource(resolved.wording.label))
}

/**
 * Whether the Mac offers Bot activity (`bot-activity-v1`) and this phone holds `bot:activity`.
 * Before `/server` has answered (a cold start, or offline), what the pairing last saw stands in
 * (R21): the feature token `/server` announced and the grant it holds, both persisted. Once
 * `/server` answers it decides.
 */
fun aidenBotActivitySupported(server: AidenServer?, cachedSupport: Boolean): Boolean =
    server?.supportsBotActivity ?: cachedSupport

/**
 * Advanced offers Chat activity on a Mac that announces `bot-activity-v1` to a phone that
 * holds `bot:activity`, once a Bot's detail (cached or fresh) is on screen.
 */
fun aidenBotShowsChatActivity(server: AidenServer?, hasBaseline: Boolean, cachedSupport: Boolean = false): Boolean =
    hasBaseline && aidenBotActivitySupported(server, cachedSupport)

// --- The previews' script: what each level shows on the Mac ---

/** One frame of the scripted turn, as a level shows it on the Mac. */
data class AidenBotChatActivityPreviewFrame(
    /** The status line's phase id, or null on the reply frame. */
    val phase: String?,
    /** Finished step rows, as string ids: Detailed while live, or the open recap after the reply. */
    val steps: List<Int>,
    /** The step in progress, listed while the line says its phase (Detailed only). */
    @param:StringRes val running: Int?,
    val recapShown: Boolean,
    val recapOpen: Boolean
)

/** Think, read, search, edit, reply: the desktop page's script and timings. */
object AidenBotChatActivityPreview {
    val FRAME_MILLIS = longArrayOf(1_400, 1_600, 1_600, 1_400, 2_800)

    /** The reply frame: the last one. */
    val REPLY_FRAME: Int get() = FRAME_MILLIS.size - 1

    /** Frames that show the line mid-turn; the reply is [REPLY_FRAME]. */
    private const val MID_TURN_FRAME = 2

    private val PHASES = listOf("thinking", "reading", "searching", "editing", null)
    private val STEPS = listOf(
        R.string.bot_chat_activity_preview_step_read,
        R.string.bot_chat_activity_preview_step_search,
        R.string.bot_chat_activity_preview_step_edit
    )
    private val RUNNING = listOf(
        R.string.bot_activity_reading,
        R.string.bot_activity_searching,
        R.string.bot_activity_editing
    )

    /**
     * The frame a preview holds when it doesn't move (Reduce Motion). Summary's whole point is
     * the recap above the reply, so it holds the reply; Quiet and Detailed hold the line
     * (and Detailed's steps) mid-turn.
     */
    fun stillFrame(level: AidenBotChatActivityLevel): Int =
        if (level == AidenBotChatActivityLevel.SUMMARY) REPLY_FRAME else MID_TURN_FRAME

    fun frameIndex(elapsedMs: Long): Int {
        val total = FRAME_MILLIS.sum()
        var time = ((elapsedMs % total) + total) % total
        FRAME_MILLIS.forEachIndexed { index, duration ->
            if (time < duration) return index
            time -= duration
        }
        return REPLY_FRAME
    }

    fun frame(index: Int, level: AidenBotChatActivityLevel): AidenBotChatActivityPreviewFrame {
        val clamped = index.coerceIn(0, PHASES.size - 1)
        val phase = PHASES[clamped]
        if (phase != null) {
            val live = level == AidenBotChatActivityLevel.DETAILED && clamped >= 1
            return AidenBotChatActivityPreviewFrame(
                phase = phase,
                steps = if (live) STEPS.take(clamped - 1) else emptyList(),
                running = if (live) RUNNING[clamped - 1] else null,
                recapShown = false,
                recapOpen = false
            )
        }
        return when (level) {
            AidenBotChatActivityLevel.QUIET -> AidenBotChatActivityPreviewFrame(null, emptyList(), null, recapShown = false, recapOpen = false)
            AidenBotChatActivityLevel.SUMMARY -> AidenBotChatActivityPreviewFrame(null, emptyList(), null, recapShown = true, recapOpen = false)
            AidenBotChatActivityLevel.DETAILED -> AidenBotChatActivityPreviewFrame(null, STEPS, null, recapShown = true, recapOpen = true)
        }
    }

    /** Whether a preview advances: never under Reduce Motion, and only while it is in front and visible. */
    fun plays(reduceMotion: Boolean, resumed: Boolean, onScreen: Boolean): Boolean = !reduceMotion && resumed && onScreen

    /**
     * The frame to show. Reduce Motion holds [stillFrame]; a preview that is paused (app in
     * the background, scrolled out of view) keeps the frame it had; otherwise the shared
     * clock decides, so every preview on the page is on the same step of the turn.
     */
    fun shownFrame(level: AidenBotChatActivityLevel, reduceMotion: Boolean, playing: Boolean, current: Int, nowMs: Long): Int = when {
        reduceMotion -> stillFrame(level)
        playing -> frameIndex(nowMs)
        else -> current
    }
}

// --- The controller: picks apply at once and save in the background ---

/** Why a pick didn't stick, so the page can say so in the right words. */
enum class AidenBotChatActivityFailure {
    /** The Mac refused or failed the save. */
    GENERIC,
    /** The phone couldn't reach the Mac: offline, disconnected, or too slow. */
    OFFLINE,
    /** The Bot changed on the Mac; the page now shows what the Mac holds. */
    CONFLICT
}

data class AidenBotChatActivityUiState(
    /** What the page shows: the last pick, saved or not. */
    val value: AidenBotChatActivity,
    /** The last choice the Mac confirmed. A failed save returns [value] to this. */
    val saved: AidenBotChatActivity,
    /** The revision the next save goes out on. */
    val revision: String,
    val isSaving: Boolean = false,
    /** Set when the last pick didn't stick; cleared by the next pick or [AidenBotChatActivityController.dismissError]. */
    val saveFailure: AidenBotChatActivityFailure? = null
) {
    val saveFailed: Boolean get() = saveFailure != null
}

/** A save that outran its limit; the pick returns to the saved choice. */
class AidenBotChatActivityTimeout : Exception("The save took too long.")

/** The Mac stayed unreachable for the whole hold. */
class AidenBotChatActivityUnreachable : Exception("The Mac could not be reached.")

/** The save may or may not have reached the Mac: no answer came. A late success is possible. */
fun aidenBotChatActivityTransportFailure(error: Throwable): Boolean =
    error is AidenBotChatActivityTimeout || error is java.io.IOException

/** The save never got an answer from the Mac: offline, disconnected, or too slow. */
fun aidenBotChatActivityMacUnreachable(error: Throwable): Boolean =
    aidenBotChatActivityTransportFailure(error) || error is AidenBotChatActivityUnreachable ||
        error is AidenRemoteClientException.Disconnected

/** The Bot changed on the Mac since this phone read it (a stale `If-Match`). */
fun aidenBotIsRevisionConflict(error: Throwable): Boolean =
    (error as? AidenRemoteClientException.Server)?.let { it.statusCode == 409 || it.body.code == AidenRemoteErrorCode.REVISION_CONFLICT } == true

/**
 * Applies each pick at once and saves it with no Save button, like the Mac page.
 *
 * - A failed save returns to the last choice the Mac confirmed ([AidenBotChatActivityUiState.saved]).
 * - A pick made while a save is in flight shows at once and goes out next (the last pick wins),
 *   on the revision that save returned. Picking back to the saved value is not special: the Mac
 *   ends on whatever was picked last.
 * - A stale revision, a timeout or a transport failure refreshes the Bot and adopts the Mac's
 *   revision and choice, tells [onSaved], and rolls back to what the Mac holds. A save that
 *   landed late therefore shows as saved, with no error.
 * - A request that has gone out finishes, and reports through [onSaved], even if the caller
 *   leaves meanwhile: the Mac took it, so the screens behind must hear. Leaving only stops the
 *   picks queued behind it.
 * - While [waitForConnection] says the Mac is still connecting, a pick is held for up to
 *   [connectionHoldMillis], then sent or rolled back. Nothing is queued durably.
 * - Each request is bounded by [requestLimitMillis]: the phone's HTTP stack waits for
 *   connectivity much longer than a settings pick should.
 *
 * Confined to one thread (the UI's): [pick] suspends only inside a save, and the first
 * caller drives later picks, so later callers return at once.
 */
class AidenBotChatActivityController(
    bot: AidenBotDetail,
    private val save: suspend (AidenBotChatActivity, String) -> AidenBotDetail,
    private val refresh: (suspend () -> AidenBotDetail)? = null,
    private val onSaved: (AidenBotDetail) -> Unit = {},
    private val waitForConnection: (suspend () -> Boolean)? = null,
    private val connectionHoldMillis: Long = CONNECTION_HOLD_MILLIS,
    private val requestLimitMillis: Long = REQUEST_LIMIT_MILLIS,
    /** The saves a pick started have all settled (reported or rolled back). */
    private val onSettled: () -> Unit = {}
) {
    private val _state = MutableStateFlow(
        (bot.chatActivity ?: AidenBotChatActivity.DEFAULT).let {
            AidenBotChatActivityUiState(value = it, saved = it, revision = bot.revision)
        }
    )
    val state: StateFlow<AidenBotChatActivityUiState> = _state.asStateFlow()

    /** The newest pick made while a save was in flight. */
    private var pending: AidenBotChatActivity? = null

    suspend fun pick(next: AidenBotChatActivity) {
        val current = _state.value
        if (next == current.value) return
        _state.value = current.copy(value = next, saveFailure = null)
        if (current.isSaving) {
            pending = next
            return
        }
        _state.update { it.copy(isSaving = true) }
        try {
            saveUntilSettled(next)
        } finally {
            pending = null
            _state.update { it.copy(isSaving = false, value = it.saved) }
            onSettled()
        }
    }

    fun dismissError() {
        _state.update { it.copy(saveFailure = null) }
    }

    private suspend fun saveUntilSettled(first: AidenBotChatActivity) {
        var target = first
        while (true) {
            // The request, and the report that follows it, are not cancelled with the caller.
            // A caller that left stops here, so the picks queued behind the request aren't sent.
            val saved = withContext(NonCancellable) { send(target) }
            currentCoroutineContext().ensureActive()
            if (!saved) return
            val following = pending ?: return
            pending = null
            if (following == _state.value.saved) return
            target = following
        }
    }

    /** One save: true when the Mac holds [target] afterwards; false when the pick didn't stick. */
    private suspend fun send(target: AidenBotChatActivity): Boolean {
        val detail = try {
            holdForConnection()
            val revision = _state.value.revision
            withTimeoutOrNull(requestLimitMillis) { save(target, revision) } ?: throw AidenBotChatActivityTimeout()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val refreshes = aidenBotIsRevisionConflict(error) || aidenBotChatActivityTransportFailure(error)
            val before = _state.value.saved
            val fresh = if (refreshes) adoptTheMacsChoice() else null
            val macHolds = fresh?.let { it.chatActivity ?: AidenBotChatActivity.DEFAULT }
            if (macHolds == target) return true
            val failure = when {
                aidenBotIsRevisionConflict(error) -> AidenBotChatActivityFailure.CONFLICT
                // The answer never came, but the Mac now holds something nobody here picked.
                macHolds != null && macHolds != before -> AidenBotChatActivityFailure.CONFLICT
                aidenBotChatActivityMacUnreachable(error) -> AidenBotChatActivityFailure.OFFLINE
                else -> AidenBotChatActivityFailure.GENERIC
            }
            _state.update { it.copy(value = it.saved, saveFailure = failure) }
            return false
        }
        _state.update { it.copy(revision = detail.revision, saved = detail.chatActivity ?: target) }
        onSaved(detail)
        return true
    }

    private suspend fun holdForConnection() {
        val wait = waitForConnection ?: return
        if (withTimeoutOrNull(connectionHoldMillis) { wait() } != true) throw AidenBotChatActivityUnreachable()
    }

    /** The Mac may hold something else now: take its revision and choice, so the next pick can save. */
    private suspend fun adoptTheMacsChoice(): AidenBotDetail? {
        val refresh = refresh ?: return null
        val fresh = try {
            withTimeoutOrNull(requestLimitMillis) { refresh() }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        } ?: return null
        _state.update { it.copy(revision = fresh.revision, saved = fresh.chatActivity ?: AidenBotChatActivity.DEFAULT) }
        onSaved(fresh)
        return fresh
    }

    companion object {
        const val CONNECTION_HOLD_MILLIS = 8_000L
        const val REQUEST_LIMIT_MILLIS = 12_000L
    }
}

/**
 * A controller that saves through the Mac. [client] is read at each request, so a pick made
 * before the connection is up still goes out on the client that exists by then.
 *
 * The patch is sent with `supportsBotActivity = true`: the page is offered only to a phone
 * that holds `bot:activity` on a Mac that announces the feature, and the client refuses a
 * `chatActivity` patch otherwise.
 */
fun aidenBotChatActivityController(
    bot: AidenBotDetail,
    client: () -> AidenRemoteClient?,
    onSaved: (AidenBotDetail) -> Unit = {},
    waitForConnection: (suspend () -> Boolean)? = null,
    onSettled: () -> Unit = {}
): AidenBotChatActivityController {
    fun connected(): AidenRemoteClient = client() ?: throw AidenRemoteClientException.Disconnected()
    return AidenBotChatActivityController(
        bot,
        save = { next, revision ->
            connected().updateBotIdentity(bot.id, revision, AidenBotIdentityPatch(chatActivity = next), supportsBotActivity = true)
        },
        refresh = { connected().bot(bot.id) },
        onSaved = onSaved,
        waitForConnection = waitForConnection,
        onSettled = onSettled
    )
}
