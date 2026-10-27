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
import kotlinx.coroutines.withTimeoutOrNull
import androidx.annotation.StringRes
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.util.UUID

/** The routes a durable Bot chat uses. [AidenRemoteClient] provides them on a revision-25 Mac. */
interface AidenBotSessionTransport {
    suspend fun session(botId: String): AidenBotSession
    fun events(botId: String): Flow<AidenBotSessionEvent>
    /** `whenBusy` is Steer or Queue while the Bot works; only a Mac announcing `bot-activity-v1` takes it. */
    suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode? = null): AidenBotSessionSendResponse
    suspend fun resume(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun dismiss(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun stop(botId: String, key: UUID): AidenBotSessionStateView
    suspend fun answerQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        key: UUID
    ): AidenBotQuestionAnswerReceipt
    suspend fun requestConnection(botId: String, pluginId: String, key: UUID): AidenBotConnectionRequestReceipt
    /** The generic `POST /approvals/{waitId}/respond`; a Bot approval takes no scope. */
    suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, key: UUID): AidenApprovalResponse
    /** Revision 27 (`bot-proactive-v1`): Add routine or Not now on a proposal card. */
    suspend fun respondToRoutineProposal(
        botId: String,
        proposalId: String,
        decision: AidenBotRoutineProposalDecision,
        key: UUID
    ): AidenBotRoutineProposalRespondResult

    /**
     * Revision 37 (`bot:handoffs`): Done or Skip on a hand-off card. A transport that predates
     * hand-offs answers nothing: the card only shows to a phone the Mac sends hand-offs to.
     */
    suspend fun answerHandoff(
        botId: String,
        waitId: String,
        request: AidenBotHandoffAnswerRequest,
        key: UUID
    ): AidenBotHandoffAnswerReceipt = throw AidenRemoteClientException.InvalidResponse()

    /** Revision 37: Finish on your Mac for a sign-in hand-off. */
    suspend fun openHandoffOnMac(botId: String, waitId: String, key: UUID): AidenBotHandoffOpenOnMacReceipt =
        throw AidenRemoteClientException.InvalidResponse()

    /** Revision 37: lifts the person's pause (`DELETE /bots/{id}/pause`). */
    suspend fun unpause(botId: String, key: UUID): AidenBotSessionStateView =
        throw AidenRemoteClientException.InvalidResponse()

    /** Revision 41 (`bot:images`): the bytes of an image the Bot shared. A Mac without it has none to read. */
    suspend fun sharedImage(botId: String, entryId: String): ByteArray =
        throw AidenRemoteClientException.InvalidResponse()
}

/**
 * The Remote routes. A message goes out exactly as the controller froze it at its first attempt:
 * the controller decides `whenBusy` once (only for a Mac offering `bot-activity-v1`), so a retry
 * under the same Idempotency-Key is byte-identical even if the Mac's announcement changed since.
 */
class AidenRemoteBotSessionTransport(private val client: AidenRemoteClient) : AidenBotSessionTransport {
    override suspend fun session(botId: String) = client.botSession(botId)
    override fun events(botId: String) = client.botSessionEvents(botId)
    override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?) =
        client.sendBotMessage(botId, text, key, whenBusy, supportsBotActivity = whenBusy != null)
    override suspend fun resume(botId: String, key: UUID) = client.resumeBotSession(botId, key)
    override suspend fun dismiss(botId: String, key: UUID) = client.dismissBotSession(botId, key)
    override suspend fun stop(botId: String, key: UUID) = client.stopBotSession(botId, key)
    override suspend fun answerQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        key: UUID
    ) = client.answerBotQuestion(botId, waitId, request, key)
    override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) =
        client.requestBotConnection(botId, pluginId, key)
    override suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, key: UUID) =
        client.respondToApproval(waitId, decision, idempotencyKey = key)
    override suspend fun respondToRoutineProposal(
        botId: String,
        proposalId: String,
        decision: AidenBotRoutineProposalDecision,
        key: UUID
    ) = client.respondToBotRoutineProposal(botId, proposalId, decision, key)
    override suspend fun answerHandoff(
        botId: String,
        waitId: String,
        request: AidenBotHandoffAnswerRequest,
        key: UUID
    ) = client.answerBotHandoff(botId, waitId, request, key)
    override suspend fun openHandoffOnMac(botId: String, waitId: String, key: UUID) =
        client.openBotHandoffOnMac(botId, waitId, key)
    override suspend fun unpause(botId: String, key: UUID) = client.unpauseBot(botId, key)
    override suspend fun sharedImage(botId: String, entryId: String) = client.botSessionImage(botId, entryId)
}

/** One transcript row. Consecutive `memory_update` entries share one quiet caption. */
sealed class AidenBotSessionRow {
    abstract val key: String

    data class Entry(val entry: AidenBotSessionEntry) : AidenBotSessionRow() {
        override val key: String get() = entry.id
    }

    /** "Memory updated", standing for one or more back-to-back memory saves. */
    data class MemoryUpdated(val entryIds: List<String>) : AidenBotSessionRow() {
        override val key: String get() = "memory-${entryIds.first()}"
    }
}

/** The rows a session's entries render as, folding each run of memory updates into one caption. */
fun aidenBotSessionRows(entries: List<AidenBotSessionEntry>): List<AidenBotSessionRow> {
    val rows = mutableListOf<AidenBotSessionRow>()
    for (entry in entries) {
        if (entry is AidenBotSessionEntry.MemoryUpdate) {
            val last = rows.lastOrNull()
            if (last is AidenBotSessionRow.MemoryUpdated) {
                rows[rows.lastIndex] = last.copy(entryIds = last.entryIds + entry.id)
            } else {
                rows += AidenBotSessionRow.MemoryUpdated(listOf(entry.id))
            }
        } else {
            rows += AidenBotSessionRow.Entry(entry)
        }
    }
    return rows
}

/** Where this phone's answer to a routine proposal stands while the card is still pending. */
enum class AidenBotProposalPhase { SENDING, FAILED }

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
            // Only a newly appended assistant answer replaces the streaming text; a connect
            // card, notice or in-place update arriving mid-turn keeps it (matches iOS).
            val answered = existing < 0 &&
                payload.entry is AidenBotSessionEntry.Message &&
                payload.entry.role == AidenBotMessageRole.ASSISTANT
            AidenBotSessionEventOutcome.Applied(
                current.copy(
                    seq = event.seq,
                    partial = if (answered) null else current.partial,
                    entries = trimmed,
                    hasOlder = current.hasOlder || trimmed.size < entries.size
                )
            )
        }
        // A newer entry type this build can't show: keep the sequence, show nothing.
        is AidenBotSessionEventPayload.SkippedEntry -> AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq))
        is AidenBotSessionEventPayload.State -> AidenBotSessionEventOutcome.Applied(
            current.copy(
                seq = event.seq,
                state = payload.view.state,
                interrupted = payload.view.interrupted,
                blocked = payload.view.blocked
            )
        )
        is AidenBotSessionEventPayload.Question ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, question = payload.question))
        is AidenBotSessionEventPayload.Approval ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, approval = payload.approval))
        // Revision 30: the frame carries the whole new value, so it replaces the stored one.
        is AidenBotSessionEventPayload.Activity ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, activity = payload.activity))
        is AidenBotSessionEventPayload.Queued ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, queued = payload.queued))
        // Revision 37: the frame carries the whole hand-off, or null once it is settled.
        is AidenBotSessionEventPayload.Handoff ->
            AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, handoff = payload.handoff))
        AidenBotSessionEventPayload.Closed -> AidenBotSessionEventOutcome.Reconnect
        is AidenBotSessionEventPayload.Snapshot -> AidenBotSessionEventOutcome.Applied(payload.session)
    }
}

/**
 * Idempotency keys for one logical action. A retry after a lost connection reuses the key, so
 * the Mac replays the first outcome instead of acting twice. Once the Mac has answered (success
 * or an error response) the action is finished and the next tap gets a fresh key.
 */
class AidenBotActionKeys(private val newKey: () -> UUID = UUID::randomUUID) {
    private val keys = mutableMapOf<String, UUID>()

    @Synchronized
    fun key(action: String): UUID = keys.getOrPut(action, newKey)

    @Synchronized
    fun complete(action: String) {
        keys.remove(action)
    }

    /** Ends [action] when [error] is an answer from the Mac; keeps its key when the outcome is unknown. */
    fun failed(action: String, error: Exception) {
        if (aidenBotMacAnswered(error)) complete(action)
    }
}

/** The chat whose files a Bot's ••• menu opens: this Bot's canonical conversation, or null when it has none. */
fun aidenBotFilesChatId(botId: String, conversations: List<AidenBotConversationItem>): String? =
    aidenCanonicalBotConversations(conversations).firstOrNull { it.botId == botId }?.chatId

/** True when the Mac sent an HTTP answer, so a retry is a new action rather than a replay. */
fun aidenBotMacAnswered(error: Exception): Boolean = error is AidenRemoteClientException.Server

/** Where a connect card's action stands on this phone. */
enum class AidenBotConnectRequestPhase { IDLE, SENDING, SENT, FAILED }

/** Stop or Resume, from the tap until the Mac's own word stands for it (R14, R18). */
enum class AidenBotTurnIntent { NONE, REQUESTED, ACKNOWLEDGED }

/**
 * A notice about this phone's unsent messages, in the copy shared with iOS (`strings.xml`).
 * Unlike an action's error it stays until the person sends again or dismisses it.
 */
enum class AidenBotSessionNotice(@param:StringRes val text: Int) {
    /** "That message wasn’t sent. Please try again.": access ended with messages unsent. */
    ACCESS_LOST(R.string.bot_session_access_lost),
    /** "Too many messages are waiting. Send or remove some, then try again." */
    OUTBOX_FULL(R.string.bot_session_outbox_full),
    /** "Some unsent messages couldn’t be restored.": a previous launch's file was set aside (FR-I2). */
    OUTBOX_UNRESTORABLE(R.string.bot_session_outbox_unrestorable)
}

/** A Bot session request that got no answer within its limit (FR-I3): it may have reached the Mac. */
class AidenBotSessionTimeout : java.io.IOException("The Mac didn’t answer in time.")

/** True when a message request may have reached the Mac, so the next attempt must reuse its key. */
fun aidenBotMessageFailureIsAmbiguous(error: Exception): Boolean = when (error) {
    is AidenRemoteClientException.Server -> error.statusCode >= 500 || error.statusCode == 408 || error.statusCode == 429 ||
        // The Mac is still working on the first attempt: its outcome is unknown.
        (error.statusCode == 409 && error.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT)
    is AidenRemoteClientException.UnexpectedStatus -> error.statusCode >= 500 || error.statusCode == 408 || error.statusCode == 429
    is AidenRemoteClientException.MissingCredential,
    is AidenRemoteClientException.MissingTrustConfiguration,
    is AidenRemoteClientException.InstallationChanged,
    is AidenRemoteClientException.InvalidEndpoint -> false
    // A dropped connection or an unreadable answer: the Mac may have taken it.
    else -> true
}

/** 401 or 403, or a pairing that's gone: this phone no longer reaches this Bot. */
fun aidenBotLostAccess(error: Exception): Boolean = when (error) {
    is AidenRemoteClientException.Server -> error.isCredentialRevoked
    is AidenRemoteClientException.UnexpectedStatus -> error.statusCode == 401 || error.statusCode == 403
    is AidenRemoteClientException.MissingCredential, is AidenRemoteClientException.InstallationChanged -> true
    else -> false
}

/**
 * Which of `bot:cards`, `bot:activity`, `bot:handoffs`, `bot:handoff-notes` and `bot:images` [installation] holds. The Mac shapes a
 * Bot session feed by these (its cards, Chat activity, hand-offs and the paused state) when the
 * feed opens, and keeps that shape for the feed's life. A Bot chat can open from the pairing's
 * saved features while it connects, before this connection has negotiated a grant, so the chat
 * compares these once `/server` has answered and reopens a feed that opened without one
 * ([AidenBotSessionController.reopenFeed]).
 */
fun aidenBotSessionFeedGrants(installation: AidenInstallation?): Set<AidenRemoteCapability> =
    listOf(
        AidenRemoteCapability.BOT_CARDS,
        AidenRemoteCapability.BOT_ACTIVITY,
        AidenRemoteCapability.BOT_HANDOFFS,
        AidenRemoteCapability.BOT_HANDOFF_NOTES,
        AidenRemoteCapability.BOT_IMAGES
    )
        .filterTo(mutableSetOf()) { installation?.hasNegotiatedAccess(it) == true }

/** What the composer does with its text (revision 37). */
enum class AidenBotComposerMode {
    /** A message to the Bot. */
    MESSAGE,
    /** Done's note for the action hand-off the Bot is waiting on. */
    HANDOFF_NOTE,
    /** A sign-in hand-off waits: it is finished on the Mac, or skipped on its card. */
    HELD_FOR_SIGN_IN,
    /**
     * Revision 40: a card a password-or-code rule opened waits. It takes no note, so the composer
     * holds: a code typed here would reach the Bot. Done and Skip on the card answer it.
     */
    HELD_FOR_NO_NOTE,
    /** The person paused the Bot: nothing is sent until Resume. */
    PAUSED
}

/** The Mac's answer to Finish on your Mac: whether it brought the Bot's browser forward. */
data class AidenBotHandoffMacPrompt(val waitId: String, val opened: Boolean)

data class AidenBotSessionUiState(
    val session: AidenBotSession? = null,
    val isLoading: Boolean = true,
    val loadFailed: Boolean = false,
    /** The Mac no longer has this Bot (deleted elsewhere): the feed stops. */
    val botMissing: Boolean = false,
    /** The Mac refused this phone (401/403, or the pairing is gone): retrying can't help. */
    val accessLost: Boolean = false,
    /** A message request is on its way to the Mac. The composer doesn't wait for it (R14). */
    val isSending: Boolean = false,
    /** A Resume request is in flight. */
    val isResuming: Boolean = false,
    val isDismissing: Boolean = false,
    val isAnsweringQuestion: Boolean = false,
    val isRespondingToApproval: Boolean = false,
    /** Revision 37: Done or Skip on the hand-off card is on its way. */
    val isAnsweringHandoff: Boolean = false,
    /** Revision 37: Finish on your Mac is on its way. */
    val isFinishingHandoffOnMac: Boolean = false,
    /** What the Mac said after Finish on your Mac, for the card it was pressed on. */
    val handoffMacPrompt: AidenBotHandoffMacPrompt? = null,
    /** Revision 37: Resume on a paused Bot is on its way. */
    val isUnpausing: Boolean = false,
    val actionError: String? = null,
    /** A notice about unsent messages; shown in place of [actionError] until dismissed or the next send. */
    val notice: AidenBotSessionNotice? = null,
    val connectRequests: Map<String, AidenBotConnectRequestPhase> = emptyMap(),
    /** Routine proposal answers in flight or failed, by proposal id. A settled card has none. */
    val proposalResponses: Map<String, AidenBotProposalPhase> = emptyMap(),
    /** The Bot's state from the home list, used until the session loads. */
    val knownState: AidenBotSessionState? = null,
    /** Revision 30: the Mac announces `bot-activity-v1` and this phone holds `bot:activity`. */
    val activitySupported: Boolean = false,
    /** The Bot's Chat activity wording, from its detail. */
    val wording: AidenBotChatActivityWording = AidenBotChatActivityWording.FOLLOWS,
    /** The session feed dropped and is reconnecting. */
    val streamDown: Boolean = false,
    /** A snapshot from the Mac arrived; until then the chat shows its cached transcript or skeletons. */
    val hasLoaded: Boolean = false,
    /** What this chat last showed in this run of the app, until the Mac's snapshot replaces it. */
    val cachedEntries: List<AidenBotSessionEntry> = emptyList(),
    /** Messages sent from this phone that the Mac's transcript doesn't show yet, oldest first (R14). */
    val outbox: List<AidenBotOutgoingMessage> = emptyList(),
    /** Stop was tapped: "Stopping" until the Mac's word stands for it or the turn ends. */
    val stopIntent: AidenBotTurnIntent = AidenBotTurnIntent.NONE,
    /** Resume was tapped: "Picking up where it left off" until the Mac says what the run is doing. */
    val resumeIntent: AidenBotTurnIntent = AidenBotTurnIntent.NONE
) {
    val state: AidenBotSessionState? get() = session?.state ?: knownState
    val needsModel: Boolean get() = state == AidenBotSessionState.NEEDS_MODEL
    val isRunning: Boolean get() = state == AidenBotSessionState.RUNNING
    val isInterrupted: Boolean get() = session?.interrupted == true
    val isAccessBlocked: Boolean get() = session?.blocked == AidenBotSessionBlock.ACCESS_CHANGED
    /** Revision 37: the person paused this Bot. It takes no messages until Resume. */
    val isPaused: Boolean get() = state == AidenBotSessionState.PAUSED

    /** Revision 37: the step the Bot handed back, while it waits. */
    val handoff: AidenBotHandoff? get() = session?.handoff
    /** The composer's text goes to an action hand-off as Done's note, unless the card takes none. */
    val composerAnswersHandoff: Boolean get() = handoff?.kind == AidenBotHandoffKind.ACTION && handoff?.takesNote != false
    /** Revision 40: the waiting card takes no note, so the composer waits for Done or Skip. */
    val composerHeldForNoNote: Boolean get() = handoff?.kind == AidenBotHandoffKind.ACTION && handoff?.takesNote == false
    /** A sign-in hand-off is finished on the Mac: the composer waits for it (Skip still answers). */
    val composerHeldForSignIn: Boolean get() = handoff?.kind == AidenBotHandoffKind.SIGN_IN

    /** What Send does now: a paused Bot takes nothing; a waiting hand-off takes the text as its note. */
    val composerMode: AidenBotComposerMode
        get() = when {
            isPaused -> AidenBotComposerMode.PAUSED
            composerHeldForSignIn -> AidenBotComposerMode.HELD_FOR_SIGN_IN
            composerHeldForNoNote -> AidenBotComposerMode.HELD_FOR_NO_NOTE
            composerAnswersHandoff -> AidenBotComposerMode.HANDOFF_NOTE
            else -> AidenBotComposerMode.MESSAGE
        }

    /** The composer takes text: a message the Bot can take, or a hand-off note while none is on its way. */
    val composerEnabled: Boolean
        get() = when (composerMode) {
            AidenBotComposerMode.MESSAGE -> canSend
            AidenBotComposerMode.HANDOFF_NOTE -> !isAnsweringHandoff
            AidenBotComposerMode.HELD_FOR_SIGN_IN, AidenBotComposerMode.HELD_FOR_NO_NOTE, AidenBotComposerMode.PAUSED -> false
        }

    /** The transcript to draw: the Mac's, or the cached one while connecting. */
    val entries: List<AidenBotSessionEntry> get() = session?.entries ?: cachedEntries
    /** Nothing to show yet: skeleton bubbles, never a spinner. */
    val showsSkeleton: Boolean get() = !hasLoaded && entries.isEmpty()
    /** Not connected yet, or reconnecting: a quiet "Connecting…" hint, never a blocking screen. */
    val isConnecting: Boolean get() = !hasLoaded || streamDown
    /** Connected well enough to send now; otherwise messages wait in the outbox. */
    val isConnected: Boolean get() = hasLoaded && !streamDown

    /** The composer takes a message unless the Mac said this Bot can't; before the first snapshot it waits in the outbox. */
    val canSend: Boolean
        get() = !needsModel && !botMissing && state != AidenBotSessionState.UNAVAILABLE && !isPaused

    /** "Stopping" shows. */
    val isStopping: Boolean get() = stopIntent != AidenBotTurnIntent.NONE && isRunning
    /** "Picking up where it left off" shows. */
    val isPickingUp: Boolean get() = resumeIntent != AidenBotTurnIntent.NONE && isRunning

    /** The person's messages the Mac holds for the running turn (revision 30). */
    val queued: List<AidenBotQueuedMessage> get() = session?.queued.orEmpty()

    /** The outgoing messages to draw after the transcript and the Mac's Queued bubbles. */
    val outgoing: List<AidenBotOutgoingMessage> get() = outbox.filter { !it.echoed && !isShownAsQueued(it) }

    private fun isShownAsQueued(message: AidenBotOutgoingMessage): Boolean =
        message.queuedId != null && queued.any { it.submissionId == message.queuedId }

    /** A message was sent and the turn hasn't taken it yet. */
    val isAwaitingTurn: Boolean get() = outbox.any { it.status == AidenBotOutgoingStatus.SENDING }

    fun look(message: AidenBotOutgoingMessage): AidenBotOutgoingLook = when {
        message.status == AidenBotOutgoingStatus.FAILED -> AidenBotOutgoingLook.Failed
        // It left the Mac's queue: the turn took it in, and its entry is on the way.
        message.status == AidenBotOutgoingStatus.SENT && message.queuedId != null -> AidenBotOutgoingLook.Sent
        activitySupported && isRunning && message.enqueuedWhileRunning ->
            AidenBotOutgoingLook.Queued(message.mode ?: AidenStreamInputMode.QUEUE)
        message.status == AidenBotOutgoingStatus.SENDING -> AidenBotOutgoingLook.Sending
        else -> AidenBotOutgoingLook.Sent
    }

    /** Steer and Queue while the Bot works need `bot-activity-v1`. */
    val offersBusyModes: Boolean get() = activitySupported && isRunning

    /** Stop stays in the top bar while a turn runs, including while it waits on a question or approval card. */
    val canStopTurn: Boolean
        get() = isRunning ||
            ((session?.question != null || session?.approval != null || session?.handoff != null) && !isInterrupted && !isPaused)

    /** The failed turn Retry resends: only the newest entry, only with text, while sending is allowed and no Retry of it is on its way. */
    val retryableFailedTurn: AidenBotSessionEntry.FailedTurn?
        get() {
            val failed = session?.entries?.lastOrNull() as? AidenBotSessionEntry.FailedTurn ?: return null
            val text = failed.retryText ?: return null
            if (!canSend || text.isBlank() ||
                text.codePointCount(0, text.length) > AidenBotSessionWire.MAX_MESSAGE_LENGTH
            ) return null
            if (outbox.any { it.retryOf == failed.id && it.status != AidenBotOutgoingStatus.FAILED }) return null
            return failed
        }
}

/** What the Bot chat's status line shows (spec §12). */
data class AidenBotStatusLineState(val display: AidenBotActivityDisplay, val elapsed: String?)

/** Phases with no tool at work: while the reply's words stream in them, the words are the signal (§5.2). */
private val AIDEN_BOT_REPLY_PHASES = setOf("writing", "thinking")

/**
 * The status line now, or null when it is hidden. It shows on a Mac offering
 * `bot-activity-v1` while a turn runs, and at once after a send ("Getting ready"). It hides only
 * while the reply's text streams with no tool at work, as on the Mac (R7).
 */
fun aidenBotStatusLine(ui: AidenBotSessionUiState, nowMs: Long): AidenBotStatusLineState? {
    if (!ui.activitySupported || !(ui.isRunning || ui.isAwaitingTurn)) return null
    fun line(phase: String, elapsed: String? = null) =
        AidenBotStatusLineState(aidenBotActivityDisplay(phase, ui.wording, null), elapsed)
    // A message just sent says "Getting ready" before the Mac's state catches up.
    if (!ui.isRunning) return line(if (ui.streamDown) "reconnecting" else "preparing")
    val session = ui.session
    val activity = session?.activity
    val elapsed = activity?.let { aidenBotElapsedLabel(it.startedAt, nowMs) }
    if (ui.streamDown) return line("reconnecting", elapsed)
    if (ui.isStopping) return line("stopping", elapsed)
    if (ui.isPickingUp) return line("resuming", elapsed)
    // Narration can outlast its words into a tool call, so a tool at work keeps the line.
    val replyStreaming = !session?.partial.isNullOrBlank()
    if (replyStreaming && (activity == null || activity.phase in AIDEN_BOT_REPLY_PHASES)) return null
    // Sent, and the first activity frame is on its way.
    if (activity == null) return line("preparing")
    return AidenBotStatusLineState(aidenBotActivityDisplay(activity.phase, ui.wording, activity.app), elapsed)
}

/**
 * Drives one durable Bot chat: loads `GET /bots/{id}/session`, follows the event feed with the
 * `(epoch, seq)` rule, and sends turns and controls with stable idempotency keys.
 *
 * Every action applies at once and reconciles with the Mac later (R14, R18). A message shows
 * immediately and waits in an outbox until the Mac is reachable; it is settled by the Mac's
 * entry with its `submissionId` (text only where the entry has none), never removed while its
 * request is unsettled, and never overtaken by a later one. With [sessionKey] and [store] the
 * outbox outlives the screen and the process, and the chat opens on its last transcript.
 */
class AidenBotSessionController(
    val botId: String,
    private val transport: AidenBotSessionTransport,
    private val scope: CoroutineScope,
    knownState: AidenBotSessionState? = null,
    activitySupported: Boolean = false,
    private val keys: AidenBotActionKeys = AidenBotActionKeys(),
    private val reconnectDelayMillis: Long = 1_500,
    private val sessionKey: AidenBotSessionKey? = null,
    private val store: AidenBotSessionStore? = null,
    /** The waits between retries of a message whose request may not have arrived, while connected. */
    private val retryDelaysMillis: List<Long> = listOf(1_000, 4_000),
    /** A clean close reconnects at once; only one that stays down this long says "Reconnecting". */
    private val reconnectingDebounceMillis: Long = 2_000,
    /** Every request to the Mac gets an answer within this, or counts as one that may have arrived (FR-I3). */
    private val requestLimitMillis: Long = REQUEST_LIMIT_MILLIS,
    /** How long a taken message that nothing on the Mac shows stays before it goes (FR-m5). */
    private val unheldGraceMillis: Long = UNHELD_GRACE_MILLIS,
    /** Revision 41: how many bytes of shared images this chat keeps in memory. */
    sharedImageBudgetBytes: Long = AidenSharedImageBytes.DEFAULT_MAX_BYTES,
    private val nowMs: () -> Long = System::currentTimeMillis
) {
    private val _state: MutableStateFlow<AidenBotSessionUiState>
    val state: StateFlow<AidenBotSessionUiState>

    private var feedJob: Job? = null
    private var flushJob: Job? = null
    private var backoffJob: Job? = null
    private var downJob: Job? = null
    private var restoreJob: Job? = null
    /** Grace timers for taken messages nothing on the Mac shows, by key; and those whose grace ran out. */
    private val unheldTimers = mutableMapOf<UUID, Job>()
    private val unheldExpired = mutableSetOf<UUID>()
    /** What a previous launch left on disk has been read (or there is nothing to read): deliveries wait for it. */
    private var restored: Boolean
    /** Bumped by every access-loss purge: a disk restore that started before it is stale and is dropped, not merged. */
    private var purgeGeneration = 0
    private var released = false
    private var isFlushing = false
    private val inFlight = mutableSetOf<String>()
    private var pendingAnswer: Pair<String, AidenQuestionRespondRequest>? = null
    private var pendingApprovalDecision: Pair<String, AidenApprovalDecision>? = null
    private var pendingHandoffAnswer: Pair<String, AidenBotHandoffAnswerRequest>? = null
    /** How many times the Mac has written each field, so a failed action rolls back only what nothing newer replaced. */
    private var stateWrites = 0
    private var questionWrites = 0
    private var approvalWrites = 0
    private var handoffWrites = 0
    /** Transcript entries that already stand for an outgoing message, for the life of an epoch. */
    private val claimedEntries = mutableSetOf<String>()
    private var claimsEpoch: String? = null
    /** The run a Stop was pressed in, by its `startedAt`. */
    private var stopStartedAt: Long? = null
    /** Revision 41: images the Bot shared, kept in memory within a budget while this chat is open; never written to disk. */
    private val sharedImages = AidenSharedImageBytes(sharedImageBudgetBytes)

    init {
        val cached = sessionKey?.let { store?.transcript(it) }.orEmpty()
        // Memory only: a chat already read in this run of the app opens on its messages at once;
        // otherwise [start] reads the disk off the main thread.
        val held = sessionKey?.let { store?.adoptOutbox(it, this) }
        restored = sessionKey == null || store == null || held != null
        val now = nowMs()
        val adopted = held.orEmpty().map { it.adopted(now) }
        _state = MutableStateFlow(
            AidenBotSessionUiState(
                knownState = knownState,
                activitySupported = activitySupported,
                cachedEntries = cached,
                outbox = adopted
            )
        )
        state = _state.asStateFlow()
        if (held != null && adopted != held && sessionKey != null) store?.storeOutbox(sessionKey, this, adopted)
    }

    /**
     * Revision 37: called once for each hand-off this chat sees arrive (a new wait id), from the
     * feed or a snapshot, so the screen can alert a person who isn't looking (G24).
     */
    var onHandoffArrived: ((AidenBotHandoff) -> Unit)? = null

    fun setActivitySupported(supported: Boolean) {
        _state.update { it.copy(activitySupported = supported) }
    }

    fun setWording(wording: AidenBotChatActivityWording) {
        _state.update { it.copy(wording = wording) }
    }

    /** Starts restoring the outbox, loading and following the session; safe to call once per screen. */
    fun start() {
        released = false
        ensureRestored()
        if (feedJob?.isActive == true) return
        feedJob = scope.launch { follow() }
    }

    /**
     * The chat closed: the feed, retry timers and any delivery under way stop, and unsent
     * messages stay, key and body, for the next visit.
     */
    fun stopFollowing() {
        released = true
        feedJob?.cancel()
        feedJob = null
        flushJob?.cancel()
        backoffJob?.cancel()
        downJob?.cancel()
        restoreJob?.cancel()
        unheldTimers.values.forEach { it.cancel() }
        unheldTimers.clear()
        sharedImages.clear()
    }

    /**
     * Opens the feed again: a fresh read of the session, then a new feed whose first frame is a
     * snapshot. The Mac shapes a feed by this phone's grants when it opens, so a grant negotiated
     * after this chat's feed opened ([aidenBotSessionFeedGrants]) reaches it only on a new one.
     * Unsent messages, their keys and any answer on its way are left as they are. Does nothing
     * unless the feed is following.
     */
    fun reopenFeed() {
        if (released || feedJob?.isActive != true) return
        feedJob?.cancel()
        feedJob = scope.launch { follow() }
    }

    /** The notice was read. */
    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    /**
     * Revision 41 (`bot:images`): the bytes of an image the Bot shared, or null when the Mac can't
     * send them (it left the chat, or the phone is offline). Images are kept while this chat is open,
     * within a byte budget and only while the transcript still shows them; one that was dropped, or
     * whose read failed, is read again the next time it is drawn. An id the transcript doesn't show
     * is never asked for.
     */
    suspend fun sharedImageData(entryId: String): ByteArray? {
        sharedImages[entryId]?.let { return it }
        if (entryId !in shownSharedImageIds()) return null
        val data = try {
            bounded { transport.sharedImage(botId, entryId) }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            return null
        }
        sharedImages.retainOnly(shownSharedImageIds())
        sharedImages.put(entryId, data)
        return data
    }

    /**
     * The attachment the shared image viewer draws. Entry ids (`entry_7`) repeat across Bots and
     * Macs, and the viewer caches pictures for the whole app by attachment id, so the id it sees
     * names this Mac and Bot too. Reads still go to [sharedImageData] with the entry's own id.
     */
    fun sharedImageAttachment(image: AidenBotSessionEntry.SharedImage): AidenMessageAttachment =
        image.attachment.copy(id = "bot-image:$imageScope:${image.id}")

    private val imageScope: String by lazy {
        val owner = sessionKey?.let { "${it.instanceId}\u0000${it.deviceId}\u0000" }.orEmpty() + botId
        java.security.MessageDigest.getInstance("SHA-256").digest(owner.toByteArray())
            .take(12).joinToString("") { "%02x".format(it) }
    }

    private fun shownSharedImageIds(): Set<String> =
        _state.value.entries.filterIsInstance<AidenBotSessionEntry.SharedImage>().mapTo(HashSet()) { it.id }

    /** [block], or [AidenBotSessionTimeout] once it has run past [requestLimitMillis]. */
    private suspend fun <T : Any> bounded(block: suspend () -> T): T =
        withTimeoutOrNull(requestLimitMillis) { block() } ?: throw AidenBotSessionTimeout()

    /**
     * Reads what a previous launch left on disk, once, on the store's io thread. Those messages
     * are older than anything sent since, so they go first, and nothing is delivered before them.
     */
    private fun ensureRestored() {
        if (restored || restoreJob?.isActive == true) return
        val key = sessionKey ?: return
        val store = store ?: return
        val generation = purgeGeneration
        restoreJob = scope.launch {
            val restore = try {
                store.restoreOutbox(key, this@AidenBotSessionController)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The read itself failed: nothing came back, and the person hears so.
                AidenBotOutboxRestore(emptyList(), unreadable = true)
            }
            // Access ended while the disk was read: what came back is from before the purge. Merging it
            // would bring the purged text back into the outbox and onto disk, so it is dropped.
            if (generation != purgeGeneration) {
                wakeOutbox()
                return@launch
            }
            val now = nowMs()
            val stored = restore.messages
            val known = stored.mapTo(HashSet()) { it.key }
            restored = true
            val (merged, overflow) = capped(stored.map { it.adopted(now) } + _state.value.outbox.filterNot { it.key in known })
            setOutbox(merged, force = true)
            when {
                restore.unreadable -> _state.update { it.copy(notice = AidenBotSessionNotice.OUTBOX_UNRESTORABLE) }
                overflow -> _state.update { it.copy(notice = AidenBotSessionNotice.OUTBOX_FULL) }
            }
            reconcileOutbox(snapshot = false)
            wakeOutbox()
        }
    }

    /** Reloads `GET /bots/{id}/session`; returns false when it could not. One older than frames already shown is dropped. */
    suspend fun refetch(): Boolean {
        ensureRestored()
        return load(authoritative = false)
    }

    private suspend fun load(authoritative: Boolean): Boolean {
        // Try again shows at once that it is trying: "Connecting…" and shimmering skeletons.
        if (_state.value.session == null) _state.update { it.copy(isLoading = true, loadFailed = false) }
        return try {
            val session = bounded { transport.session(botId) }
            val current = _state.value.session
            if (!authoritative && current != null && session.epoch == current.epoch && session.seq < current.seq) {
                _state.update { it.copy(isLoading = false, loadFailed = false) }
            } else {
                applySnapshot(session)
            }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val missing = (error as? AidenRemoteClientException.Server)?.statusCode == 404
            val lost = aidenBotLostAccess(error)
            if (lost) purgeForAccessLoss()
            _state.update {
                it.copy(isLoading = false, loadFailed = it.session == null, botMissing = it.botMissing || missing, accessLost = it.accessLost || lost)
            }
            if (missing) failWaiting()
            false
        }
    }

    /** Applies one event; returns false when the feed should be reopened. */
    suspend fun handle(event: AidenBotSessionEvent): Boolean {
        return when (val outcome = aidenApplyBotSessionEvent(_state.value.session, event)) {
            is AidenBotSessionEventOutcome.Applied -> {
                apply(outcome.session, event.payload)
                true
            }
            AidenBotSessionEventOutcome.Ignored -> true
            // Keep showing what we have; a failed refetch reopens the feed, whose first
            // frame is a fresh snapshot.
            AidenBotSessionEventOutcome.Refetch -> load(authoritative = true)
            AidenBotSessionEventOutcome.Reconnect -> false
        }
    }

    private fun apply(session: AidenBotSession, payload: AidenBotSessionEventPayload) {
        if (payload is AidenBotSessionEventPayload.Snapshot) {
            applySnapshot(session)
            return
        }
        val previous = _state.value.session
        _state.update { it.copy(session = session, isLoading = false, loadFailed = false) }
        settleCards(session)
        when (payload) {
            is AidenBotSessionEventPayload.State -> afterStateWrite(previous)
            is AidenBotSessionEventPayload.Question -> questionWrites += 1
            is AidenBotSessionEventPayload.Approval -> approvalWrites += 1
            is AidenBotSessionEventPayload.Handoff -> handoffWritten(previous?.handoff, payload.handoff)
            is AidenBotSessionEventPayload.Activity -> activityArrived(payload.activity)
            is AidenBotSessionEventPayload.Entry -> storeTranscript()
            else -> Unit
        }
        reconcileOutbox(snapshot = false)
        scheduleFlush()
    }

    /** A snapshot replaces everything, and means the Mac is reachable: the outbox goes out. */
    private fun applySnapshot(session: AidenBotSession) {
        val previous = _state.value.session
        _state.update { it.copy(session = session, isLoading = false, loadFailed = false, hasLoaded = true, accessLost = false) }
        settleCards(session)
        questionWrites += 1
        approvalWrites += 1
        handoffWritten(previous?.handoff, session.handoff)
        if (session.activity != previous?.activity) activityArrived(session.activity)
        afterStateWrite(previous)
        storeTranscript()
        reconcileOutbox(snapshot = true)
        wakeOutbox()
    }

    /** The Mac wrote the hand-off: another card's Mac prompt goes, and a new card is announced once. */
    private fun handoffWritten(previous: AidenBotHandoff?, next: AidenBotHandoff?) {
        handoffWrites += 1
        _state.update { if (it.handoffMacPrompt != null && it.handoffMacPrompt.waitId != next?.waitId) it.copy(handoffMacPrompt = null) else it }
        if (next != null && next.waitId != previous?.waitId) onHandoffArrived?.invoke(next)
    }

    private fun settleCards(session: AidenBotSession) {
        session.entries.filterIsInstance<AidenBotSessionEntry.ConnectCard>()
            .filter { it.status != AidenBotConnectCardStatus.PENDING }
            .forEach { card -> _state.update { it.copy(connectRequests = it.connectRequests - card.pluginId) } }
        // A proposal settled on the Mac or another phone needs no answer from here.
        session.entries.filterIsInstance<AidenBotSessionEntry.RoutineProposal>()
            .filter { it.status != AidenBotRoutineProposalStatus.PENDING }
            .forEach { card -> _state.update { it.copy(proposalResponses = it.proposalResponses - card.proposalId) } }
    }

    /**
     * The Mac wrote the state. A turn that is no longer running takes its Stop, Resume and
     * activity with it, so the next turn never starts at "Stopping" or on a stale phase. A Bot
     * whose access changed loses what waited to go to it.
     */
    private fun afterStateWrite(previous: AidenBotSession?) {
        stateWrites += 1
        _state.update { current ->
            if (current.isRunning) return@update current
            val session = current.session
            current.copy(
                session = if (session?.activity != null) session.copy(activity = null) else session,
                stopIntent = AidenBotTurnIntent.NONE,
                resumeIntent = AidenBotTurnIntent.NONE
            )
        }
        val blocked = _state.value.session?.blocked == AidenBotSessionBlock.ACCESS_CHANGED
        if (blocked && previous?.blocked != AidenBotSessionBlock.ACCESS_CHANGED) purgeForAccessLoss()
    }

    /**
     * The Mac's own word now stands for a Stop or Resume it has heard, and a new run (another
     * `startedAt`, or a first activity after a Stop pressed before any) has nothing to stop. An
     * activity after a Resume tap says what the resumed run is doing; a cleared one says nothing.
     */
    private fun activityArrived(next: AidenBotSessionActivity?) {
        val stopRun = stopStartedAt
        _state.update { current ->
            val clearStop = current.stopIntent == AidenBotTurnIntent.ACKNOWLEDGED ||
                (next != null && (stopRun == null || next.startedAt != stopRun))
            current.copy(
                stopIntent = if (clearStop) AidenBotTurnIntent.NONE else current.stopIntent,
                resumeIntent = if (next != null) AidenBotTurnIntent.NONE else current.resumeIntent
            )
        }
    }

    private fun storeTranscript() {
        val key = sessionKey ?: return
        val current = _state.value
        val session = current.session ?: return
        if (current.isAccessBlocked) return
        store?.storeTranscript(key, session.entries)
    }

    private suspend fun follow() {
        load(authoritative = false)
        while (scope.isActive && !_state.value.botMissing) {
            var clean = true
            try {
                transport.events(botId).collect { event ->
                    streamUp()
                    if (!handle(event)) throw ReopenFeed(clean = event.payload is AidenBotSessionEventPayload.Closed)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (reopen: ReopenFeed) {
                clean = reopen.clean
            } catch (error: Exception) {
                // A deleted Bot has no feed to come back to.
                if ((error as? AidenRemoteClientException.Server)?.statusCode == 404) {
                    downJob?.cancel()
                    _state.update { it.copy(botMissing = true, isLoading = false, loadFailed = it.session == null) }
                    failWaiting()
                    return
                }
                // This phone isn't allowed to read the chat: retrying cannot help, and nothing unsent is kept.
                if (aidenBotLostAccess(error)) {
                    downJob?.cancel()
                    purgeForAccessLoss()
                    _state.update { it.copy(isLoading = false, loadFailed = it.session == null, accessLost = true) }
                    return
                }
                clean = false
            }
            // Closed or dropped: while a turn runs the line says "Reconnecting to your Mac". A
            // clean close usually comes straight back, so it says so only if it doesn't.
            if (clean) debounceStreamDown() else markStreamDown()
            delay(reconnectDelayMillis)
        }
    }

    private class ReopenFeed(val clean: Boolean) : Exception("reopen Bot session feed")

    private fun streamUp() {
        downJob?.cancel()
        downJob = null
        if (_state.value.streamDown) _state.update { it.copy(streamDown = false) }
    }

    private fun markStreamDown() {
        downJob?.cancel()
        downJob = null
        _state.update { it.copy(streamDown = true) }
    }

    private fun debounceStreamDown() {
        if (downJob?.isActive == true || _state.value.streamDown) return
        downJob = scope.launch {
            delay(reconnectingDebounceMillis)
            _state.update { it.copy(streamDown = true) }
        }
    }

    // --- Sending (R14, R16, R17) ---

    /**
     * Sends [text]. It shows at once as an outgoing message and goes out now when connected,
     * or from the outbox on the next connection, under one Idempotency-Key. A Bot that needs an
     * AI model takes nothing. While the Bot works on a Mac offering `bot-activity-v1`,
     * [whenBusy] says Steer or Queue (Queue by default); otherwise it is left off, because an
     * older Mac refuses it.
     *
     * Returns true when the message was taken (its bubble shows), false when refused.
     */
    suspend fun send(text: String, whenBusy: AidenStreamInputMode? = null): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.codePointCount(0, trimmed.length) > AidenBotSessionWire.MAX_MESSAGE_LENGTH) return false
        val current = _state.value
        if (!current.canSend) return false
        _state.update { it.copy(actionError = null, notice = null) }
        val mode = if (current.offersBusyModes) whenBusy ?: AidenStreamInputMode.QUEUE else null
        if (!enqueue(trimmed, mode, retryOf = null)) return false
        ensureRestored()
        flushNow()
        return true
    }

    /**
     * Adds a message, unless the chat already holds as many (or as much) as it can keep for a
     * later launch: then it says so, and nothing is stored that the next launch couldn't read.
     */
    private fun enqueue(text: String, mode: AidenStreamInputMode?, retryOf: String?): Boolean {
        val current = _state.value
        val next = current.outbox + AidenBotOutgoingMessage.create(text, mode, current.isRunning, retryOf, nowMs())
        if (!fits(next)) {
            _state.update { it.copy(notice = AidenBotSessionNotice.OUTBOX_FULL) }
            return false
        }
        setOutbox(next)
        return true
    }

    /** Whether [messages] fit what this chat keeps for a later launch. */
    private fun fits(messages: List<AidenBotOutgoingMessage>): Boolean =
        messages.size <= AidenBotSessionStore.MAX_MESSAGES && (sessionKey == null || store == null || store.fits(sessionKey, messages))

    /**
     * Restored messages and those sent before the disk was read can together run past the
     * limit. Nothing is dropped: the newest that never went out say "Couldn't send · Try
     * again", so the person sends or removes them. Returns whether any did.
     */
    private fun capped(messages: List<AidenBotOutgoingMessage>): Pair<List<AidenBotOutgoingMessage>, Boolean> {
        var fit = messages.size
        while (fit > 0 && !fits(messages.take(fit))) fit -= 1
        if (fit == messages.size) return messages to false
        val capped = messages.mapIndexed { index, message ->
            if (index >= fit && message.status == AidenBotOutgoingStatus.SENDING && !message.frozen) {
                message.copy(status = AidenBotOutgoingStatus.FAILED, keepsKey = false)
            } else {
                message
            }
        }
        return capped to (capped != messages)
    }

    /** Try again on a message that couldn't be sent. One the Mac may hold keeps its key, so the Mac replays its receipt. */
    suspend fun retrySend(id: String): Boolean {
        val message = _state.value.outbox.firstOrNull { it.id == id && it.status == AidenBotOutgoingStatus.FAILED } ?: return false
        // An outbox past its limit (after a restore) takes no more until some are sent or removed.
        if (!fits(_state.value.outbox)) {
            _state.update { it.copy(notice = AidenBotSessionNotice.OUTBOX_FULL) }
            return false
        }
        val base = if (message.keepsKey) message else message.copy(key = UUID.randomUUID(), frozen = false, sentMode = null, baseline = emptySet())
        val again = base.copy(
            status = AidenBotOutgoingStatus.SENDING,
            submissionId = null,
            // Try again starts its day again.
            createdAtMs = nowMs(),
            connectionAttempts = 0,
            deferred = false,
            echoed = false,
            echoEntryId = null,
            echoSubmissionId = null,
            queuedId = null,
            unheld = false
        )
        setOutbox(_state.value.outbox.map { if (it.id == id) again else it })
        flushNow()
        return true
    }

    /** Removes a message that couldn't be sent; nothing else is ever dropped silently. */
    fun discardSend(id: String) {
        setOutbox(_state.value.outbox.filterNot { it.id == id && it.status == AidenBotOutgoingStatus.FAILED })
    }

    /**
     * Sends the newest failed turn's text again through the outbox (R18): it shows at once and
     * goes out with the other messages. A Retry is its own submission with its own key, never
     * the original message's; a Retry that couldn't be sent is tried again under its key when
     * the Mac may hold it.
     */
    suspend fun retry(): Boolean {
        val current = _state.value
        if (!current.hasLoaded) return false
        val failed = current.retryableFailedTurn ?: return false
        val text = failed.retryText?.trim() ?: return false
        current.outbox.firstOrNull { it.retryOf == failed.id }?.let { return retrySend(it.id) }
        if (!enqueue(text, if (current.offersBusyModes) AidenStreamInputMode.QUEUE else null, retryOf = failed.id)) return false
        flushNow()
        return true
    }

    /**
     * Shows [next] and writes it through to the store, which holds it in memory until the disk
     * copy was read, so a message sent meanwhile never overwrites what a previous launch left. A store
     * that refuses the write (another controller adopted the chat, or the Mac was unpaired) ends
     * this controller's sending, like closing the chat.
     */
    private fun setOutbox(next: List<AidenBotOutgoingMessage>, force: Boolean = false) {
        if (!force && _state.value.outbox == next) return
        _state.update { it.copy(outbox = next) }
        val key = sessionKey ?: return
        val store = store ?: return
        if (!store.storeOutbox(key, this, next)) {
            released = true
            backoffJob?.cancel()
        }
    }

    /** Replaces the message with [key]; a null result removes it. */
    private fun updateMessage(key: UUID, change: (AidenBotOutgoingMessage) -> AidenBotOutgoingMessage?) {
        setOutbox(_state.value.outbox.mapNotNull { if (it.key == key) change(it) else it })
    }

    /**
     * Server truth replaces optimistic messages (R14, R16, R17). A taken message gives way to the
     * entry with its `submissionId`; text stands in only where the entry has none (an older
     * Mac), for a request still unsettled, or for a Queued bubble that beats the receipt. Each
     * entry settles one message for the life of the epoch. An unsettled message is never
     * removed: it hides and settles on its receipt. On a Mac that sends its queue, a taken
     * message that is neither queued nor in the transcript is marked unheld by a snapshot and
     * goes only once [unheldGraceMillis] have passed since (FR-m5, as on iOS): the Mac's Queued
     * list may be full, or may leave it out while it can't yet tell whose it is. Showing up
     * queued again clears the mark.
     */
    private fun reconcileOutbox(snapshot: Boolean) {
        val current = _state.value
        val epoch = current.session?.epoch
        if (claimsEpoch != epoch) {
            claimsEpoch = epoch
            claimedEntries.clear()
        }
        if (current.outbox.isEmpty()) return
        val entries = current.session?.entries.orEmpty()
        val owned = current.outbox.mapNotNull { it.submissionId }.toSet()
        val queuedIds = current.queued.map { it.submissionId }.toSet()
        val claimedQueued = owned.toMutableSet()
        val kept = mutableListOf<AidenBotOutgoingMessage>()
        for (original in current.outbox) {
            var message = original
            if (!message.mayHaveReachedMac) {
                kept += message
                continue
            }
            if (!message.echoed) {
                val echo = echoEntry(message, owned, entries)
                if (echo != null) {
                    claimedEntries += echo.id
                    // Settled: the Mac's entry stands for it now.
                    if (message.status != AidenBotOutgoingStatus.SENDING) continue
                    message = message.copy(echoed = true, echoEntryId = echo.id, echoSubmissionId = echo.submissionId)
                }
            }
            if (!message.echoed) {
                val id = message.submissionId
                if (id != null) {
                    if (id in queuedIds) {
                        message = message.copy(queuedId = id, unheld = false)
                    } else if (current.activitySupported) {
                        // Taken, not queued and not in the transcript: nothing on the Mac shows it.
                        // Marked on a snapshot; it goes once its 10 s grace ran out ([unheldTimers]), as on iOS.
                        when {
                            message.unheld && message.key in unheldExpired -> continue
                            snapshot && !message.unheld -> message = message.copy(unheld = true)
                        }
                    }
                } else if (message.queuedId == null) {
                    // The Queued frame can beat the receipt.
                    val match = current.queued.firstOrNull { it.submissionId !in claimedQueued && it.text == message.text }
                    if (match != null) {
                        claimedQueued += match.submissionId
                        message = message.copy(queuedId = match.submissionId)
                    }
                }
            }
            kept += message
        }
        setOutbox(kept)
        trackUnheld()
    }

    /**
     * One grace timer per taken message that nothing on the Mac shows (FR-m5): when it runs
     * out and the message is still unheld, the message goes. One the Mac shows again, or that
     * settled, loses its timer.
     */
    private fun trackUnheld() {
        val unheld = _state.value.outbox.filter { it.unheld }.mapTo(HashSet()) { it.key }
        (unheldTimers.keys - unheld).forEach { unheldTimers.remove(it)?.cancel() }
        unheldExpired.retainAll(unheld)
        for (key in unheld) {
            if (key in unheldTimers || key in unheldExpired) continue
            unheldTimers[key] = scope.launch {
                delay(unheldGraceMillis)
                unheldTimers.remove(key)
                unheldExpired += key
                reconcileOutbox(snapshot = false)
            }
        }
    }

    /** The unclaimed user entry that stands for [message], if any. */
    private fun echoEntry(
        message: AidenBotOutgoingMessage,
        owned: Set<String>,
        entries: List<AidenBotSessionEntry>
    ): AidenBotSessionEntry.Message? {
        var byText: AidenBotSessionEntry.Message? = null
        for (entry in entries) {
            val sent = entry as? AidenBotSessionEntry.Message ?: continue
            if (sent.role != AidenBotMessageRole.USER || sent.id in claimedEntries) continue
            if (message.submissionId != null && sent.submissionId == message.submissionId) return sent
            if (byText != null || sent.id in message.baseline || sent.text.trim() != message.text) continue
            // An entry that names its submission belongs to that submission. Only a request still
            // unsettled may wait on one (its receipt says whose it is); a failed one never takes it.
            val theirs = sent.submissionId
            if (theirs != null &&
                (message.submissionId != null || theirs in owned || message.status == AidenBotOutgoingStatus.FAILED)
            ) continue
            byText = sent
        }
        return byText
    }

    /** The Mac is reachable again: deferred messages get another try. */
    private fun wakeOutbox() {
        setOutbox(_state.value.outbox.map { if (it.deferred) it.copy(deferred = false) else it })
        scheduleFlush()
    }

    /**
     * Sends the outbox in its own job beside whatever called this (a frame, a snapshot, a
     * backoff), never holding up the feed; [stopFollowing] cancels it mid-request.
     */
    private fun scheduleFlush() {
        if (released || isFlushing || nextToDeliver() == null) return
        flushJob = scope.launch { flushOutbox() }
    }

    /** Sends now and waits until the outbox has gone as far as it can. */
    private suspend fun flushNow() {
        scheduleFlush()
        flushJob?.join()
    }

    /**
     * The oldest unsettled message, unless it waits for a retry: nothing overtakes it, so
     * messages arrive in order. Nothing goes before a previous launch's messages are read.
     */
    private fun nextToDeliver(): UUID? {
        val current = _state.value
        if (!current.isConnected || released || !restored) return null
        val head = current.outbox.firstOrNull { it.status == AidenBotOutgoingStatus.SENDING } ?: return null
        return if (head.deferred) null else head.key
    }

    /** One sender at a time: a caller that finds one under way leaves the new message to it. */
    private suspend fun flushOutbox() {
        if (isFlushing) return
        isFlushing = true
        try {
            while (true) {
                val key = nextToDeliver() ?: break
                deliver(key)
            }
        } finally {
            isFlushing = false
        }
    }

    private suspend fun deliver(key: UUID) {
        val current = _state.value
        val message = current.outbox.firstOrNull { it.key == key } ?: return
        // A paused Bot (revision 37) takes nothing either: the message waits as "Couldn't send · Try again".
        if (current.needsModel || current.state == AidenBotSessionState.UNAVAILABLE || current.isPaused || current.botMissing) {
            // A frozen request may have reached the Mac: Try again replays its key. Any entry it
            // waited on goes back to the others.
            message.echoEntryId?.let { claimedEntries -= it }
            updateMessage(key) {
                it.copy(status = AidenBotOutgoingStatus.FAILED, keepsKey = it.frozen, echoed = false, echoEntryId = null, echoSubmissionId = null)
            }
            return
        }
        if (message.isExpired(nowMs())) {
            // Unsent for a day: it says so instead of going out late, and lets go of any entry it held.
            message.echoEntryId?.let { claimedEntries -= it }
            updateMessage(key) { it.expired().copy(echoEntryId = null, echoSubmissionId = null) }
            return
        }
        val request = if (message.frozen) message else message.copy(
            frozen = true,
            sentMode = if (current.offersBusyModes) message.mode else null,
            baseline = current.session?.entries?.map { it.id }?.toSet().orEmpty()
        )
        if (request != message) updateMessage(key) { request }
        // The store refused the frozen request (another controller took the chat, or an unpair).
        if (released) return
        val writes = stateWrites
        _state.update { it.copy(isSending = true) }
        try {
            val receipt = bounded { transport.send(botId, request.text, key, request.sentMode) }
            if (stateWrites == writes) applyStateView(receipt.stateView)
            updateMessage(key) { latest ->
                var settled = latest
                if (settled.echoed && settled.echoSubmissionId != null && settled.echoSubmissionId != receipt.submissionId) {
                    // The entry it waited on was another submission's: give it back.
                    settled.echoEntryId?.let { claimedEntries -= it }
                    settled = settled.copy(echoed = false, echoEntryId = null, echoSubmissionId = null)
                }
                if (settled.echoed) {
                    null
                } else {
                    settled.copy(
                        status = AidenBotOutgoingStatus.SENT,
                        submissionId = receipt.submissionId,
                        deferred = false,
                        keepsKey = false
                    )
                }
            }
            reconcileOutbox(snapshot = false)
        } catch (error: CancellationException) {
            // A closed chat leaves the message as it was, key and body, for the next visit.
            throw error
        } catch (error: Exception) {
            if (released) return
            val latest = _state.value.outbox.firstOrNull { it.key == key } ?: return
            if (aidenBotLostAccess(error)) {
                purgeForAccessLoss()
                return
            }
            if (!aidenBotMessageFailureIsAmbiguous(error)) {
                // Refused outright: it never reached the Mac, and Try again is a new request.
                updateMessage(key) { it.copy(status = AidenBotOutgoingStatus.FAILED, keepsKey = false, echoed = false) }
                return
            }
            val attempts = latest.connectionAttempts + 1
            if (attempts < MAX_CONNECTION_ATTEMPTS) {
                // It keeps its place and key: the next connection, or a short wait while
                // connected, tries again. Nothing behind it overtakes it.
                updateMessage(key) { it.copy(keepsKey = true, connectionAttempts = attempts, deferred = true) }
                scheduleBackoff(attempts)
            } else {
                updateMessage(key) {
                    if (it.echoed && it.echoSubmissionId == null) {
                        // An untagged entry of its text already shows it.
                        null
                    } else {
                        // An entry naming another submission is not its echo: "Couldn't send · Try
                        // again" with its key, and the entry goes back to whoever it belongs to.
                        it.echoEntryId?.let { entry -> claimedEntries -= entry }
                        it.copy(
                            status = AidenBotOutgoingStatus.FAILED,
                            keepsKey = true,
                            connectionAttempts = attempts,
                            echoed = false,
                            echoEntryId = null,
                            echoSubmissionId = null
                        )
                    }
                }
            }
        } finally {
            _state.update { it.copy(isSending = false) }
        }
    }

    private fun scheduleBackoff(attempts: Int) {
        if (!_state.value.isConnected || retryDelaysMillis.isEmpty()) return
        val wait = retryDelaysMillis[minOf(attempts - 1, retryDelaysMillis.lastIndex)]
        backoffJob?.cancel()
        backoffJob = scope.launch {
            delay(wait)
            if (!released) wakeOutbox()
        }
    }

    /** Access ended: nothing unsent is kept for this chat, in memory or on disk, and the person is told. */
    private fun purgeForAccessLoss() {
        val hadUnsent = _state.value.outbox.any { it.status != AidenBotOutgoingStatus.SENT }
        // A disk restore still under way is stale from here on, and the chat has nothing on disk left to wait for.
        purgeGeneration += 1
        restoreJob?.cancel()
        restored = true
        backoffJob?.cancel()
        setOutbox(emptyList())
        sessionKey?.let { store?.purge(it) }
        if (hadUnsent) _state.update { it.copy(notice = AidenBotSessionNotice.ACCESS_LOST) }
    }

    /** The Bot is gone: what waited to go to it says it couldn't be sent. */
    private fun failWaiting() {
        setOutbox(_state.value.outbox.map {
            if (it.status == AidenBotOutgoingStatus.SENDING) it.copy(status = AidenBotOutgoingStatus.FAILED, echoed = false) else it
        })
    }

    // --- Turn controls (R14, R18): each applies at once and goes back only if nothing newer replaced it ---

    /** Resume shows "Picking up where it left off" at once and goes back if the Mac didn't take it. A second tap sends nothing. */
    suspend fun resume(): Boolean {
        val current = _state.value
        val before = current.session ?: return false
        if (!current.isInterrupted || current.isAccessBlocked || RESUME in inFlight) return false
        inFlight += RESUME
        val writes = stateWrites
        _state.update {
            it.copy(
                session = it.session?.copy(state = AidenBotSessionState.RUNNING, interrupted = false, blocked = null, activity = null),
                resumeIntent = AidenBotTurnIntent.REQUESTED,
                isResuming = true,
                actionError = null
            )
        }
        return try {
            val view = bounded { transport.resume(botId, keys.key(RESUME)) }
            keys.complete(RESUME)
            if (stateWrites == writes) applyStateView(view)
            _state.update {
                if (it.resumeIntent == AidenBotTurnIntent.REQUESTED) it.copy(resumeIntent = AidenBotTurnIntent.ACKNOWLEDGED) else it
            }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(RESUME, error)
            _state.update {
                it.copy(
                    session = if (stateWrites == writes) it.session?.restoringState(before) else it.session,
                    resumeIntent = AidenBotTurnIntent.NONE,
                    actionError = UNREACHABLE
                )
            }
            false
        } finally {
            inFlight -= RESUME
            _state.update { it.copy(isResuming = false) }
        }
    }

    /** Dismiss clears the paused card at once and brings it back if the Mac didn't take it. */
    suspend fun dismiss(): Boolean {
        val current = _state.value
        val before = current.session ?: return false
        if (!current.isInterrupted || DISMISS in inFlight) return false
        inFlight += DISMISS
        val writes = stateWrites
        _state.update {
            it.copy(
                session = it.session?.copy(state = AidenBotSessionState.IDLE, interrupted = false, blocked = null, activity = null),
                isDismissing = true,
                actionError = null
            )
        }
        return try {
            val view = bounded { transport.dismiss(botId, keys.key(DISMISS)) }
            keys.complete(DISMISS)
            if (stateWrites == writes) applyStateView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(DISMISS, error)
            _state.update {
                it.copy(
                    session = if (stateWrites == writes) it.session?.restoringState(before) else it.session,
                    actionError = UNREACHABLE
                )
            }
            false
        } finally {
            inFlight -= DISMISS
            _state.update { it.copy(isDismissing = false) }
        }
    }

    /**
     * Stop says "Stopping" at once (R14) and goes back if the Mac didn't take it. Once the Mac
     * took it, "Stopping" holds until its next activity frame or the turn ends. Pressed with
     * nothing running (a card waiting), it says nothing, so the next turn never starts at "Stopping".
     */
    suspend fun stop(): Boolean {
        val current = _state.value
        if (!current.canStopTurn || STOP in inFlight) return false
        inFlight += STOP
        if (current.isRunning) {
            stopStartedAt = current.session?.activity?.startedAt
            _state.update { it.copy(stopIntent = AidenBotTurnIntent.REQUESTED, actionError = null) }
        } else {
            _state.update { it.copy(actionError = null) }
        }
        val writes = stateWrites
        return try {
            val view = bounded { transport.stop(botId, keys.key(STOP)) }
            keys.complete(STOP)
            if (stateWrites == writes) applyStateView(view)
            _state.update {
                if (it.stopIntent == AidenBotTurnIntent.REQUESTED) it.copy(stopIntent = AidenBotTurnIntent.ACKNOWLEDGED) else it
            }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(STOP, error)
            _state.update { it.copy(stopIntent = AidenBotTurnIntent.NONE, actionError = UNREACHABLE) }
            false
        } finally {
            inFlight -= STOP
        }
    }

    /**
     * Answers the waiting A–E question once. The card goes at once and comes back with an error
     * if the answer didn't reach the Mac, unless the Mac has since shown another (R18). A failed
     * answer keeps its key, so retrying the same answer replays the Mac's receipt; a different
     * answer gets a new key. A second tap while one is in flight sends nothing.
     */
    suspend fun answerQuestion(response: AidenQuestionRespondRequest): Boolean {
        val question = _state.value.session?.question ?: return false
        if (_state.value.isAnsweringQuestion) return false
        val action = "$ANSWER_QUESTION:${question.waitId}"
        if (pendingAnswer != action to response) {
            keys.complete(action)
            pendingAnswer = action to response
        }
        val writes = questionWrites
        _state.update {
            it.copy(isAnsweringQuestion = true, actionError = null, session = it.session?.copy(question = null))
        }
        return try {
            bounded { transport.answerQuestion(botId, question.waitId, response, keys.key(action)) }
            keys.complete(action)
            pendingAnswer = null
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            if (aidenBotMacAnswered(error)) pendingAnswer = null
            _state.update { current ->
                val session = current.session
                current.copy(
                    session = if (questionWrites == writes && session?.question == null) session?.copy(question = question) else session,
                    actionError = ANSWER_FAILED
                )
            }
            false
        } finally {
            _state.update { it.copy(isAnsweringQuestion = false) }
        }
    }

    /**
     * Allows or denies the waiting tool approval once. The card goes at once and comes back with
     * an error if the decision didn't reach the Mac, unless the Mac has since changed it (R18).
     * Allow is refused when the approval cannot be allowed from a phone. An unanswered attempt
     * keeps its key, so retrying the same decision replays the Mac's outcome; the other decision
     * gets a new key. An expired or already-settled approval stays gone.
     */
    suspend fun respondToApproval(decision: AidenApprovalDecision): Boolean {
        val approval = _state.value.session?.approval ?: return false
        if (decision == AidenApprovalDecision.ALLOW && !approval.canAllow) return false
        var claimed = false
        val writes = approvalWrites
        _state.update { current ->
            if (current.isRespondingToApproval) current else {
                claimed = true
                current.copy(isRespondingToApproval = true, actionError = null, session = current.session?.copy(approval = null))
            }
        }
        if (!claimed) return false
        val action = "$RESPOND_APPROVAL:${approval.waitId}"
        if (pendingApprovalDecision != action to decision) {
            keys.complete(action)
            pendingApprovalDecision = action to decision
        }
        return try {
            bounded { transport.respondToApproval(approval.waitId, decision, keys.key(action)) }
            keys.complete(action)
            pendingApprovalDecision = null
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            if (aidenBotMacAnswered(error)) pendingApprovalDecision = null
            when ((error as? AidenRemoteClientException.Server)?.body?.code) {
                AidenRemoteErrorCode.APPROVAL_EXPIRED -> _state.update { it.copy(actionError = "That request expired.") }
                // Settled elsewhere, on the Mac or another phone: nothing is waiting any more.
                AidenRemoteErrorCode.APPROVAL_ALREADY_RESOLVED -> Unit
                else -> _state.update { current ->
                    val session = current.session
                    current.copy(
                        session = if (approvalWrites == writes && session?.approval == null) session?.copy(approval = approval) else session,
                        actionError = SEND_FAILED
                    )
                }
            }
            false
        } finally {
            _state.update { it.copy(isRespondingToApproval = false) }
        }
    }

    /**
     * Revision 37: answers the hand-off once, Done (with an optional note the Bot reads) or Skip.
     * The card goes at once and comes back with an error if the answer didn't reach the Mac,
     * unless the Mac has since shown another (R18). A sign-in can only be skipped from a phone.
     * An unanswered attempt keeps its key, so retrying the same answer replays the Mac's
     * receipt; another answer gets a new key. A card answered elsewhere (`handoff_expired`)
     * stays gone. A second tap while one is in flight sends nothing.
     */
    suspend fun answerHandoff(outcome: AidenBotHandoffOutcome, note: String? = null): Boolean {
        val handoff = _state.value.session?.handoff ?: return false
        if (outcome == AidenBotHandoffOutcome.DONE && handoff.kind == AidenBotHandoffKind.SIGN_IN) return false
        val trimmed = note?.trim()?.takeIf { it.isNotEmpty() }
        // A card that takes no note (revision 40) is answered bare: a code typed as a note never leaves the phone.
        if (trimmed != null && !handoff.takesNote) return false
        if (trimmed != null && trimmed.codePointCount(0, trimmed.length) > AidenBotHandoffWire.MAX_NOTE_LENGTH) {
            _state.update { it.copy(actionError = HANDOFF_NOTE_TOO_LONG) }
            return false
        }
        val request = AidenBotHandoffAnswerRequest(outcome, trimmed)
        var claimed = false
        val writes = handoffWrites
        _state.update { current ->
            if (current.isAnsweringHandoff) current else {
                claimed = true
                current.copy(
                    isAnsweringHandoff = true,
                    actionError = null,
                    handoffMacPrompt = null,
                    session = current.session?.copy(handoff = null)
                )
            }
        }
        if (!claimed) return false
        val action = "$ANSWER_HANDOFF:${handoff.waitId}"
        if (pendingHandoffAnswer != action to request) {
            keys.complete(action)
            pendingHandoffAnswer = action to request
        }
        return try {
            bounded { transport.answerHandoff(botId, handoff.waitId, request, keys.key(action)) }
            keys.complete(action)
            pendingHandoffAnswer = null
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            if (aidenBotMacAnswered(error)) pendingHandoffAnswer = null
            if ((error as? AidenRemoteClientException.Server)?.body?.code == AidenRemoteErrorCode.HANDOFF_EXPIRED) {
                // Answered on the Mac or another phone, or withdrawn: nothing waits any more.
                _state.update { it.copy(actionError = HANDOFF_EXPIRED) }
            } else {
                _state.update { current ->
                    val session = current.session
                    current.copy(
                        session = if (handoffWrites == writes && session?.handoff == null) session?.copy(handoff = handoff) else session,
                        actionError = HANDOFF_NOT_SENT
                    )
                }
            }
            false
        } finally {
            _state.update { it.copy(isAnsweringHandoff = false) }
        }
    }

    /**
     * Revision 37: Finish on your Mac, for a sign-in hand-off. The card stays; it then says
     * whether the Mac brought the Bot's browser forward. A retry after an unknown outcome reuses
     * the key.
     */
    suspend fun finishHandoffOnMac(): Boolean {
        val handoff = _state.value.session?.handoff ?: return false
        if (handoff.kind != AidenBotHandoffKind.SIGN_IN) return false
        var claimed = false
        _state.update { current ->
            if (current.isFinishingHandoffOnMac) current else {
                claimed = true
                current.copy(isFinishingHandoffOnMac = true, actionError = null)
            }
        }
        if (!claimed) return false
        val action = "$OPEN_HANDOFF_ON_MAC:${handoff.waitId}"
        return try {
            val receipt = bounded { transport.openHandoffOnMac(botId, handoff.waitId, keys.key(action)) }
            keys.complete(action)
            _state.update {
                if (it.session?.handoff?.waitId == handoff.waitId) {
                    it.copy(handoffMacPrompt = AidenBotHandoffMacPrompt(handoff.waitId, receipt.opened))
                } else it
            }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            if ((error as? AidenRemoteClientException.Server)?.body?.code == AidenRemoteErrorCode.HANDOFF_EXPIRED) {
                _state.update { current ->
                    val session = current.session
                    current.copy(
                        session = if (session?.handoff?.waitId == handoff.waitId) session.copy(handoff = null) else session,
                        actionError = HANDOFF_EXPIRED
                    )
                }
            } else {
                _state.update { it.copy(actionError = UNREACHABLE) }
            }
            false
        } finally {
            _state.update { it.copy(isFinishingHandoffOnMac = false) }
        }
    }

    /**
     * Revision 37: Resume on a paused Bot. The Mac's answer stands, so nothing is shown before
     * it: a reply the pause cut short comes back interrupted, with its own Resume and Dismiss.
     */
    suspend fun unpause(): Boolean {
        val current = _state.value
        if (!current.isPaused || UNPAUSE in inFlight) return false
        inFlight += UNPAUSE
        _state.update { it.copy(isUnpausing = true, actionError = null) }
        val writes = stateWrites
        return try {
            val view = bounded { transport.unpause(botId, keys.key(UNPAUSE)) }
            keys.complete(UNPAUSE)
            if (stateWrites == writes) applyStateView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(UNPAUSE, error)
            _state.update { it.copy(actionError = UNREACHABLE) }
            false
        } finally {
            inFlight -= UNPAUSE
            _state.update { it.copy(isUnpausing = false) }
        }
    }

    suspend fun requestConnection(pluginId: String) {
        val phase = _state.value.connectRequests[pluginId]
        if (phase == AidenBotConnectRequestPhase.SENDING || phase == AidenBotConnectRequestPhase.SENT) return
        val action = "connect:$pluginId"
        _state.update { it.copy(connectRequests = it.connectRequests + (pluginId to AidenBotConnectRequestPhase.SENDING)) }
        val next = try {
            bounded { transport.requestConnection(botId, pluginId, keys.key(action)) }
            keys.complete(action)
            AidenBotConnectRequestPhase.SENT
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            AidenBotConnectRequestPhase.FAILED
        }
        _state.update { it.copy(connectRequests = it.connectRequests + (pluginId to next)) }
    }

    /**
     * Answers a pending routine proposal once. The card settles at once ("Added ✓" or "Not
     * added") and the Mac's answer replaces it; a failure puts Add routine and Not now back so
     * the person can try again, with the same key for the same choice (R18). A proposal the Mac
     * no longer has reloads the session. A second tap while one is in flight sends nothing.
     */
    suspend fun respondToProposal(proposalId: String, decision: AidenBotRoutineProposalDecision): Boolean {
        val card = _state.value.session?.entries
            ?.filterIsInstance<AidenBotSessionEntry.RoutineProposal>()
            ?.firstOrNull { it.proposalId == proposalId }
            ?: return false
        if (card.status != AidenBotRoutineProposalStatus.PENDING) return false
        var claimed = false
        _state.update { current ->
            if (current.proposalResponses[proposalId] == AidenBotProposalPhase.SENDING) current else {
                claimed = true
                current.copy(proposalResponses = current.proposalResponses + (proposalId to AidenBotProposalPhase.SENDING))
            }
        }
        if (!claimed) return false
        val optimistic = card.copy(
            status = if (decision == AidenBotRoutineProposalDecision.ACCEPT) {
                AidenBotRoutineProposalStatus.ACCEPTED
            } else {
                AidenBotRoutineProposalStatus.DISMISSED
            },
            routineId = null
        )
        replaceProposal(proposalId) { if (it == card) optimistic else it }
        val action = "$RESPOND_PROPOSAL:$proposalId:${decision.name}"
        return try {
            val result = bounded { transport.respondToRoutineProposal(botId, proposalId, decision, keys.key(action)) }
            keys.complete(action)
            settleProposal(proposalId, result)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            replaceProposal(proposalId) { if (it == optimistic) card else it }
            _state.update { it.copy(proposalResponses = it.proposalResponses + (proposalId to AidenBotProposalPhase.FAILED)) }
            val server = error as? AidenRemoteClientException.Server
            if (server?.statusCode == 404 && server.body.code == AidenRemoteErrorCode.ROUTINE_PROPOSAL_NOT_FOUND) {
                _state.update { it.copy(proposalResponses = it.proposalResponses - proposalId) }
                refetch()
            }
            false
        }
    }

    private fun replaceProposal(
        proposalId: String,
        change: (AidenBotSessionEntry.RoutineProposal) -> AidenBotSessionEntry.RoutineProposal
    ) {
        _state.update { current ->
            val session = current.session ?: return@update current
            current.copy(session = session.copy(entries = session.entries.map { entry ->
                if (entry is AidenBotSessionEntry.RoutineProposal && entry.proposalId == proposalId) change(entry) else entry
            }))
        }
    }

    private fun settleProposal(proposalId: String, result: AidenBotRoutineProposalRespondResult) {
        val status = when (result.status) {
            AidenBotRoutineProposalOutcome.ACCEPTED -> AidenBotRoutineProposalStatus.ACCEPTED
            AidenBotRoutineProposalOutcome.DISMISSED -> AidenBotRoutineProposalStatus.DISMISSED
        }
        replaceProposal(proposalId) { it.copy(status = status, routineId = result.routineId) }
        _state.update { it.copy(proposalResponses = it.proposalResponses - proposalId) }
    }

    /** The Mac's own answer to an action: its state replaces the local one. */
    private fun applyStateView(view: AidenBotSessionStateView) {
        val previous = _state.value.session
        _state.update { current ->
            val session = current.session ?: return@update current.copy(knownState = view.state)
            current.copy(session = session.copy(state = view.state, interrupted = view.interrupted, blocked = view.blocked))
        }
        afterStateWrite(previous)
    }

    private fun AidenBotSession.restoringState(before: AidenBotSession) =
        copy(state = before.state, interrupted = before.interrupted, blocked = before.blocked, activity = before.activity)

    companion object {
        const val RESUME = "resume"
        const val DISMISS = "dismiss"
        const val STOP = "stop"
        const val ANSWER_QUESTION = "answerQuestion"
        const val RESPOND_APPROVAL = "respondApproval"
        const val RESPOND_PROPOSAL = "respondProposal"
        const val ANSWER_HANDOFF = "answerHandoff"
        const val OPEN_HANDOFF_ON_MAC = "openHandoffOnMac"
        const val UNPAUSE = "unpause"
        /** Tries a message gets on a connection that keeps failing before it says "Couldn't send". */
        const val MAX_CONNECTION_ATTEMPTS = 3
        const val SEND_FAILED = "Aiden couldn’t send that. Try again."
        const val UNREACHABLE = "Aiden couldn’t reach your Mac. Try again."
        const val ANSWER_FAILED = "Aiden couldn’t send that answer. Try again."
        /** Revision 37 copy, shared with iOS and desktop. */
        const val HANDOFF_EXPIRED = "That card was already answered or closed."
        const val HANDOFF_NOT_SENT = "That answer wasn’t sent. Please try again."
        const val HANDOFF_NOTE_TOO_LONG = "Keep the note under 4,000 characters."
        /** The bound on each request to the Mac (FR-I3), the same as iOS. */
        const val REQUEST_LIMIT_MILLIS = 12_000L
        /** How long a taken message nothing on the Mac shows waits for a second look (FR-m5). */
        const val UNHELD_GRACE_MILLIS = 10_000L
    }
}

/**
 * Bot row copy built by the JVM-tested [AidenBotHomeRow] presentation. Screen copy lives in
 * `strings.xml` (`bot_session_*`).
 */
object AidenBotSessionCopy {
    const val NEEDS_MODEL = "Needs an AI model"
    /** A reply that stopped before it finished (a quit, a crash, or a lifted pause). */
    const val INTERRUPTED_ROW = "Interrupted — tap to resume"
    /** Revision 37: the person paused the Bot (G2, the same words as iOS and desktop). */
    const val PAUSED_ROW = "Paused"
}
