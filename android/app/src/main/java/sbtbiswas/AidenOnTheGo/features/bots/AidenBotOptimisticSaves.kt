package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.map
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotIdentityPatch
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException

// R15: the slice-A Bot surfaces (create, model pick, Advanced Save, profile and memory edits)
// apply at once, never wait for the connection to show a change, and roll back on failure.

/**
 * What a Bot edit needs from its surroundings, bound to one pairing: the client at request
 * time, a wait for the connection, a scope that outlives the screen (so leaving mid-save
 * doesn't cancel the request), and the pinned cache: [show] for what the Mac hasn't confirmed
 * (memory only), [cache] for what it has (memory and disk).
 */
class AidenBotSaveHost(
    /** The pairing's client now, or null once that pairing is gone or the phone is offline. */
    val client: () -> AidenRemoteClient?,
    /** Suspends until the Mac is connected; false when it can't be (unpaired, another pairing). */
    val waitForConnection: suspend () -> Boolean,
    val launch: (suspend () -> Unit) -> Unit,
    /** Every screen shows this Bot now; a relaunch doesn't (an edit on its way, a rollback). */
    val show: (AidenBotDetail) -> Unit,
    /** The Mac sent or confirmed this Bot: kept, on disk too. */
    val cache: (AidenBotDetail) -> Unit,
    /** The Bot the cache holds now, to roll back only what nothing newer replaced. */
    val cached: (String) -> AidenBotDetail? = { null }
) {
    /** The client, or [AidenRemoteClientException.Disconnected] when there is none. */
    fun connected(): AidenRemoteClient = client() ?: throw AidenRemoteClientException.Disconnected()
}

/** The save host for the pairing in use now; nothing it saves reaches another pairing. */
fun AidenRemoteCoordinator.botSaveHost(): AidenBotSaveHost = pairingMemo("bot-save-host") {
    val pairing = activePairing
    fun samePairing() = holdsPairing(pairing)
    AidenBotSaveHost(
        client = { pairedClient(pairing) },
        waitForConnection = { samePairing() && aidenBotAwaitConnected(connectionState, client.map { pairedClient(pairing) }) && samePairing() },
        launch = { block -> launchDetached(block) },
        show = pinnedBotShow(),
        cache = pinnedBotCache(),
        cached = { id -> if (samePairing()) botCache.getBotDetail(id) else null }
    )
}

/** How long a save waits for the Mac to connect before it gives up (R15), as Chat activity does. */
const val AIDEN_BOT_SAVE_HOLD_MILLIS = AidenBotChatActivityController.CONNECTION_HOLD_MILLIS

/** The bound on each save request, as on iOS. */
const val AIDEN_BOT_SAVE_LIMIT_MILLIS = AidenBotChatActivityController.REQUEST_LIMIT_MILLIS

/**
 * Runs [request] once the Mac is connected (waiting up to [holdMillis]) and within
 * [limitMillis]. Throws [AidenBotChatActivityUnreachable] when the Mac never connected and
 * [AidenBotChatActivityTimeout] when the request outran its limit.
 */
suspend fun <T : Any> aidenBotHeldRequest(
    waitForConnection: (suspend () -> Boolean)?,
    holdMillis: Long = AIDEN_BOT_SAVE_HOLD_MILLIS,
    limitMillis: Long = AIDEN_BOT_SAVE_LIMIT_MILLIS,
    request: suspend () -> T
): T {
    if (waitForConnection != null && withTimeoutOrNull(holdMillis) { waitForConnection() } != true) {
        throw AidenBotChatActivityUnreachable()
    }
    return withTimeoutOrNull(limitMillis) { request() } ?: throw AidenBotChatActivityTimeout()
}

/** The words for a save that didn't stick. */
@androidx.annotation.StringRes
fun aidenBotSaveFailureText(failure: AidenBotChatActivityFailure): Int = when (failure) {
    AidenBotChatActivityFailure.GENERIC -> sbtbiswas.AidenOnTheGo.R.string.bot_save_failed
    AidenBotChatActivityFailure.OFFLINE -> sbtbiswas.AidenOnTheGo.R.string.bot_save_unreachable
    AidenBotChatActivityFailure.CONFLICT -> sbtbiswas.AidenOnTheGo.R.string.bot_chat_activity_save_conflict
}

/** Why a save didn't stick, in the person's terms. */
fun aidenBotSaveFailure(error: Throwable, macHoldsSomethingElse: Boolean = false): AidenBotChatActivityFailure = when {
    aidenBotIsRevisionConflict(error) || macHoldsSomethingElse -> AidenBotChatActivityFailure.CONFLICT
    aidenBotChatActivityMacUnreachable(error) -> AidenBotChatActivityFailure.OFFLINE
    else -> AidenBotChatActivityFailure.GENERIC
}

/** This Bot with [patch]'s identity fields in place; null leaves it as it is. */
fun AidenBotDetail.applying(patch: AidenBotIdentityPatch?): AidenBotDetail {
    patch ?: return this
    return copy(
        name = patch.name ?: name,
        purpose = patch.purpose ?: purpose,
        instructions = patch.instructions ?: instructions,
        avatar = patch.avatar?.let { avatar.copy(semantic = it) } ?: avatar,
        chatActivity = patch.chatActivity ?: chatActivity
    )
}

/** One patch with [next]'s fields over this one's: the later edit of a field wins. */
fun AidenBotIdentityPatch.then(next: AidenBotIdentityPatch) = AidenBotIdentityPatch(
    name = next.name ?: name,
    purpose = next.purpose ?: purpose,
    instructions = next.instructions ?: instructions,
    avatar = next.avatar ?: avatar,
    chatActivity = next.chatActivity ?: chatActivity
)

data class AidenBotIdentityEditState(
    /** What the page shows: the Mac's Bot with this phone's edits on top, saved or not. */
    val bot: AidenBotDetail,
    val isSaving: Boolean = false,
    /** Set when the last edit didn't stick (its fields went back); cleared by the next edit. */
    val failure: AidenBotChatActivityFailure? = null
)

/**
 * A Bot's name, subtitle, character and instructions edits from this phone (R15). Each applies
 * at once and saves in the background, in order, on the newest revision; edits made while one
 * saves go out together next. A failed edit's fields go back to what the Mac holds (edits made
 * since stay) and [AidenBotIdentityEditState.failure] says why. A stale revision or no answer
 * refreshes the Bot first, so an edit that landed late shows as saved.
 *
 * Nothing waits for the connection to show a change: a save waits for it, up to
 * [holdMillis], and each request is bounded by [limitMillis]. A request that has gone out
 * finishes, and reports through [onSaved], even if the caller leaves. Confined to one thread
 * (the UI's): the first caller of [edit] drives the saves; later callers return at once.
 */
class AidenBotIdentityEditor(
    bot: AidenBotDetail,
    private val save: suspend (saved: AidenBotDetail, patch: AidenBotIdentityPatch) -> AidenBotDetail,
    private val refresh: (suspend () -> AidenBotDetail)? = null,
    /** The Mac's Bot after a save or a refresh: tell the screens behind. */
    private val onSaved: (AidenBotDetail) -> Unit = {},
    /** What the page shows changed (an edit, a rollback, the Mac's Bot): every screen shows it at once, and only [onSaved]'s Bot is kept. */
    private val onShown: (AidenBotDetail) -> Unit = {},
    private val waitForConnection: (suspend () -> Boolean)? = null,
    private val holdMillis: Long = AIDEN_BOT_SAVE_HOLD_MILLIS,
    private val limitMillis: Long = AIDEN_BOT_SAVE_LIMIT_MILLIS
) {
    /** The last Bot the Mac confirmed. */
    private var saved = bot
    private var inFlight: AidenBotIdentityPatch? = null
    private var pending: AidenBotIdentityPatch? = null
    private var driving = false
    private var failure: AidenBotChatActivityFailure? = null

    private val _state = MutableStateFlow(AidenBotIdentityEditState(bot))
    val state: StateFlow<AidenBotIdentityEditState> = _state.asStateFlow()

    /** True while an edit is saving or waiting to. */
    val isBusy: Boolean get() = driving || pending != null

    private fun publish() {
        val shown = saved.applying(inFlight).applying(pending)
        val changed = shown != _state.value.bot
        _state.value = AidenBotIdentityEditState(shown, driving, failure)
        if (changed) onShown(shown)
    }

    /** A newer Bot from the Mac (a read, another screen's save). Taken only while nothing here is unsaved, and never an older one. */
    fun adopt(fresh: AidenBotDetail) {
        if (isBusy || fresh.id != saved.id || fresh.updatedAt < saved.updatedAt) return
        saved = fresh
        publish()
    }

    fun dismissError() {
        failure = null
        publish()
    }

    /** Shows [patch] at once and saves it. Returns once this call's saves have settled (or at once if another call drives). */
    suspend fun edit(patch: AidenBotIdentityPatch) {
        pending = pending?.then(patch) ?: patch
        failure = null
        publish()
        if (driving) return
        driving = true
        publish()
        try {
            while (true) {
                val next = pending ?: break
                pending = null
                inFlight = next
                publish()
                // The request, and the report that follows it, are not cancelled with the caller.
                withContext(NonCancellable) { send(next) }
                inFlight = null
                publish()
                currentCoroutineContext().ensureActive()
            }
        } finally {
            driving = false
            inFlight = null
            publish()
        }
    }

    private suspend fun send(patch: AidenBotIdentityPatch) {
        try {
            val fresh = aidenBotHeldRequest(waitForConnection, holdMillis, limitMillis) { save(saved, patch) }
            saved = fresh
            onSaved(fresh)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val refreshes = aidenBotIsRevisionConflict(error) || aidenBotChatActivityTransportFailure(error)
            val fresh = if (refreshes) adoptTheMacs() else null
            // No answer came, but the Mac holds the edit: it landed.
            if (fresh != null && fresh.applying(patch) == fresh) return
            failure = aidenBotSaveFailure(error)
        }
    }

    private suspend fun adoptTheMacs(): AidenBotDetail? {
        val refresh = refresh ?: return null
        val fresh = try {
            withTimeoutOrNull(limitMillis) { refresh() }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        } ?: return null
        saved = fresh
        onSaved(fresh)
        return fresh
    }
}

/**
 * An editor that saves through the Mac in [host]'s pairing. Every screen shows what it shows
 * at once ([AidenBotSaveHost.show]), and it goes back with a rollback; only the Mac's answer is
 * kept ([AidenBotSaveHost.cache]), so a relaunch mid-save shows the Mac's Bot (as iOS does).
 */
fun aidenBotIdentityEditor(
    bot: AidenBotDetail,
    host: AidenBotSaveHost,
    onSaved: (AidenBotDetail) -> Unit = {}
) = AidenBotIdentityEditor(
    bot,
    save = { saved, patch -> host.connected().updateBotIdentity(saved.id, saved.revision, patch) },
    refresh = { host.connected().bot(bot.id) },
    onSaved = { confirmed ->
        host.cache(confirmed)
        onSaved(confirmed)
    },
    onShown = host.show,
    waitForConnection = host.waitForConnection
)

/**
 * One editor per Bot for the pairing in use, shared by Profile and the Instructions editor so
 * their edits save in order on one revision. A later visit brings it the newest Bot it has.
 */
fun AidenRemoteCoordinator.botIdentityEditor(bot: AidenBotDetail): AidenBotIdentityEditor =
    pairingMemo("bot-identity-editor:${bot.id}") { aidenBotIdentityEditor(bot, botSaveHost()) }.also { it.adopt(bot) }
