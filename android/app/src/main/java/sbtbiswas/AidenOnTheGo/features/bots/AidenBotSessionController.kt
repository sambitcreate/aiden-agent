package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.util.UUID

/** The routes a durable Bot chat uses. [AidenRemoteClient] provides them on a revision-26 Mac. */
interface AidenBotSessionTransport {
    suspend fun session(botId: String): AidenBotSession
    fun events(botId: String): Flow<AidenBotSessionEvent>
    suspend fun send(botId: String, text: String, key: UUID): AidenBotSessionSendResponse
    suspend fun resume(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun dismiss(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun stop(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun requestConnection(botId: String, pluginId: String, key: UUID): AidenBotConnectionRequestReceipt
}

class AidenRemoteBotSessionTransport(private val client: AidenRemoteClient) : AidenBotSessionTransport {
    override suspend fun session(botId: String) = client.botSession(botId)
    override fun events(botId: String) = client.botSessionEvents(botId)
    override suspend fun send(botId: String, text: String, key: UUID) = client.sendBotMessage(botId, text, key)
    override suspend fun resume(botId: String, key: UUID) = client.resumeBotSession(botId, key)
    override suspend fun dismiss(botId: String, key: UUID) = client.dismissBotSession(botId, key)
    override suspend fun stop(botId: String, key: UUID) = client.stopBotSession(botId, key)
    override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) =
        client.requestBotConnection(botId, pluginId, key)
}

/** What applying one live event to the known session means. */
sealed class AidenBotSessionEventOutcome {
    data class Applied(val session: AidenBotSession) : AidenBotSessionEventOutcome()
    /** A replayed or stale frame from the current epoch. */
    object Ignored : AidenBotSessionEventOutcome()
    /** The epoch changed or a sequence number was skipped: discard and refetch. */
    object Refetch : AidenBotSessionEventOutcome()
    /** The host closed the session: reconnect for a new epoch. */
    object Reconnect : AidenBotSessionEventOutcome()
}

/**
 * The `(epoch, seq)` rule. A snapshot always replaces. Otherwise an event from another epoch,
 * or one that is not exactly `seq + 1`, means local state can no longer be trusted; events at
 * or below the known `seq` in the same epoch are replays and are ignored.
 */
fun aidenApplyBotSessionEvent(current: AidenBotSession?, event: AidenBotSessionEvent): AidenBotSessionEventOutcome {
    val payload = event.payload
    if (payload is AidenBotSessionEventPayload.Snapshot) return AidenBotSessionEventOutcome.Applied(payload.session)
    if (current == null || event.epoch != current.epoch) return AidenBotSessionEventOutcome.Refetch
    if (event.seq <= current.seq) return AidenBotSessionEventOutcome.Ignored
    if (event.seq != current.seq + 1) return AidenBotSessionEventOutcome.Refetch
    return when (payload) {
        is AidenBotSessionEventPayload.Partial ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, partial = payload.text.ifEmpty { null }))
        is AidenBotSessionEventPayload.Entry -> {
            val existing = current.entries.indexOfFirst { it.id == payload.entry.id }
            val entries = if (existing >= 0) {
                current.entries.toMutableList().also { it[existing] = payload.entry }
            } else {
                current.entries + payload.entry
            }
            val trimmed = entries.takeLast(AidenBotSessionWire.MAX_ENTRIES)
            AidenBotSessionEventOutcome.Applied(
                current.copy(
                    seq = event.seq,
                    partial = null,
                    entries = trimmed,
                    hasOlder = current.hasOlder || trimmed.size < entries.size
                )
            )
        }
        is AidenBotSessionEventPayload.State -> AidenBotSessionEventOutcome.Applied(
            current.copy(
                seq = event.seq,
                state = payload.view.state,
                interrupted = payload.view.interrupted,
                blocked = payload.view.blocked
            )
        )
        AidenBotSessionEventPayload.Closed -> AidenBotSessionEventOutcome.Reconnect
        is AidenBotSessionEventPayload.Snapshot -> AidenBotSessionEventOutcome.Applied(payload.session)
    }
}

/**
 * Idempotency keys for one logical action. A retry of the same action reuses its key until
 * the action succeeds, so the Mac replays the first outcome instead of acting twice.
 */
class AidenBotActionKeys(private val newKey: () -> UUID = UUID::randomUUID) {
    private val keys = mutableMapOf<String, UUID>()

    @Synchronized
    fun key(action: String): UUID = keys.getOrPut(action, newKey)

    @Synchronized
    fun complete(action: String) {
        keys.remove(action)
    }
}

/** Where a connect card's action stands on this phone. */
enum class AidenBotConnectRequestPhase { IDLE, SENDING, SENT, FAILED }

data class AidenBotSessionUiState(
    val session: AidenBotSession? = null,
    val isLoading: Boolean = true,
    val loadFailed: Boolean = false,
    val isSending: Boolean = false,
    val isResuming: Boolean = false,
    val isDismissing: Boolean = false,
    val isStopping: Boolean = false,
    val actionError: String? = null,
    val connectRequests: Map<String, AidenBotConnectRequestPhase> = emptyMap(),
    /** The Bot's state from the home list, used until the session loads. */
    val knownState: AidenBotSessionState? = null
) {
    val state: AidenBotSessionState? get() = session?.state ?: knownState
    val needsModel: Boolean get() = state == AidenBotSessionState.NEEDS_MODEL
    val isRunning: Boolean get() = state == AidenBotSessionState.RUNNING
    val isInterrupted: Boolean get() = session?.interrupted == true
    val canSend: Boolean
        get() = !needsModel && !isSending && state != AidenBotSessionState.UNAVAILABLE && session != null
}

/**
 * Drives one durable Bot chat: loads `GET /bots/{id}/session`, follows the event feed with the
 * `(epoch, seq)` rule, and sends turns and controls with stable idempotency keys.
 */
class AidenBotSessionController(
    val botId: String,
    private val transport: AidenBotSessionTransport,
    private val scope: CoroutineScope,
    knownState: AidenBotSessionState? = null,
    private val keys: AidenBotActionKeys = AidenBotActionKeys(),
    private val reconnectDelayMillis: Long = 1_500
) {
    private val _state = MutableStateFlow(AidenBotSessionUiState(knownState = knownState))
    val state: StateFlow<AidenBotSessionUiState> = _state.asStateFlow()
    private var feedJob: Job? = null
    private var pendingSendText: String? = null

    /** Starts loading and following the session; safe to call once per screen. */
    fun start() {
        if (feedJob?.isActive == true) return
        feedJob = scope.launch { follow() }
    }

    fun stopFollowing() {
        feedJob?.cancel()
        feedJob = null
    }

    suspend fun refetch() {
        try {
            val session = transport.session(botId)
            _state.update { it.copy(session = session, isLoading = false, loadFailed = false) }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            _state.update { it.copy(isLoading = false, loadFailed = it.session == null) }
        }
    }

    /** Applies one event; returns false when the feed should be reopened. */
    suspend fun handle(event: AidenBotSessionEvent): Boolean {
        return when (val outcome = aidenApplyBotSessionEvent(_state.value.session, event)) {
            is AidenBotSessionEventOutcome.Applied -> {
                _state.update { it.copy(session = outcome.session, isLoading = false, loadFailed = false) }
                outcome.session.entries.filterIsInstance<AidenBotSessionEntry.ConnectCard>()
                    .filter { it.status != AidenBotConnectCardStatus.PENDING }
                    .forEach { card -> _state.update { it.copy(connectRequests = it.connectRequests - card.pluginId) } }
                true
            }
            AidenBotSessionEventOutcome.Ignored -> true
            AidenBotSessionEventOutcome.Refetch -> {
                _state.update { it.copy(session = null) }
                refetch()
                true
            }
            AidenBotSessionEventOutcome.Reconnect -> false
        }
    }

    private suspend fun follow() {
        refetch()
        while (scope.isActive) {
            try {
                transport.events(botId).collect { event ->
                    if (!handle(event)) throw ReopenFeed()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // Closed or dropped feed: wait, then reconnect; the next snapshot restores state.
            }
            delay(reconnectDelayMillis)
        }
    }

    private class ReopenFeed : Exception("reopen Bot session feed")

    /**
     * Sends [text]. Nothing is sent while the Bot needs an AI model or another send is in
     * flight. A failed send keeps its key, so retrying the same text cannot post twice.
     */
    suspend fun send(text: String): Boolean {
        val trimmed = text.trim()
        val current = _state.value
        if (trimmed.isEmpty() || !current.canSend) return false
        if (pendingSendText != trimmed) {
            keys.complete(SEND)
            pendingSendText = trimmed
        }
        val key = keys.key(SEND)
        _state.update { it.copy(isSending = true, actionError = null) }
        return try {
            val receipt = transport.send(botId, trimmed, key)
            keys.complete(SEND)
            pendingSendText = null
            applyStateView(receipt.stateView)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            _state.update { it.copy(actionError = "Aiden couldn’t send that. Try again.") }
            false
        } finally {
            _state.update { it.copy(isSending = false) }
        }
    }

    /** Resume a paused turn. A second tap while one is in flight sends nothing. */
    suspend fun resume() = control(
        RESUME,
        inFlight = { it.isResuming },
        mark = { s, v -> s.copy(isResuming = v) },
        call = { key -> transport.resume(botId, key) }
    )

    suspend fun dismiss() = control(
        DISMISS,
        inFlight = { it.isDismissing },
        mark = { s, v -> s.copy(isDismissing = v) },
        call = { key -> transport.dismiss(botId, key) }
    )

    suspend fun stop() = control(
        STOP,
        inFlight = { it.isStopping },
        mark = { s, v -> s.copy(isStopping = v) },
        call = { key -> transport.stop(botId, key) }
    )

    suspend fun requestConnection(pluginId: String) {
        val phase = _state.value.connectRequests[pluginId]
        if (phase == AidenBotConnectRequestPhase.SENDING || phase == AidenBotConnectRequestPhase.SENT) return
        val action = "connect:$pluginId"
        _state.update { it.copy(connectRequests = it.connectRequests + (pluginId to AidenBotConnectRequestPhase.SENDING)) }
        val next = try {
            transport.requestConnection(botId, pluginId, keys.key(action))
            keys.complete(action)
            AidenBotConnectRequestPhase.SENT
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            AidenBotConnectRequestPhase.FAILED
        }
        _state.update { it.copy(connectRequests = it.connectRequests + (pluginId to next)) }
    }

    private suspend fun control(
        action: String,
        inFlight: (AidenBotSessionUiState) -> Boolean,
        mark: (AidenBotSessionUiState, Boolean) -> AidenBotSessionUiState,
        call: suspend (UUID) -> AidenBotSessionStateView
    ): Boolean {
        var claimed = false
        _state.update { current ->
            if (inFlight(current)) current else {
                claimed = true
                mark(current, true).copy(actionError = null)
            }
        }
        if (!claimed) return false
        return try {
            val view = call(keys.key(action))
            keys.complete(action)
            applyStateView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            _state.update { it.copy(actionError = "Aiden couldn’t reach your Mac. Try again.") }
            false
        } finally {
            _state.update { mark(it, false) }
        }
    }

    private fun applyStateView(view: AidenBotSessionStateView) {
        _state.update { current ->
            val session = current.session ?: return@update current.copy(knownState = view.state)
            current.copy(session = session.copy(state = view.state, interrupted = view.interrupted, blocked = view.blocked))
        }
    }

    companion object {
        const val SEND = "send"
        const val RESUME = "resume"
        const val DISMISS = "dismiss"
        const val STOP = "stop"
    }
}

/** Interrupted-card copy (exact). */
object AidenBotSessionCopy {
    const val INTERRUPTED = "I got interrupted while working on this."
    const val RESUME = "Resume"
    const val DISMISS = "Dismiss"
    const val ACCESS_CHANGED = "This Bot's access changed. Review it on your Mac."
    const val NEEDS_MODEL = "Needs an AI model"
    const val NEEDS_MODEL_HINT = "Set up on your Mac"
    const val PAUSED_ROW = "Paused — tap to resume"
    const val SESSION_RESET = "This chat was restarted."
    const val FINISH_ON_MAC = "Finish on your Mac"
    const val CHECK_MAC = "Check your Mac to finish."
    const val FINISH_READ_ONLY = "Finish this on your Mac."
    const val CONNECTED = "Connected ✓"

    fun connectTitle(name: String) = "Connect $name"
}
