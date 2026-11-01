package sbtbiswas.AidenOnTheGo.features.workspaces

import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.models.AidenInbox
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.time.Instant
import java.util.UUID

/** One Inbox snackbar after a swipe. The screen words it. */
sealed interface AidenInboxNotice {
    val id: UUID

    /** The change landed; [undo] puts it back. */
    data class Changed(
        val change: AidenChatTriageChange,
        val chatId: String,
        val undo: AidenChatTriageChange?,
        override val id: UUID = UUID.randomUUID()
    ) : AidenInboxNotice

    /** The host refused the change; the row is back where it was. */
    data class TriageFailed(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    /** The row's triage changed elsewhere; the list was reloaded. */
    data class Conflict(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    /** Mark read failed; the unread dot is back. */
    data class MarkReadFailed(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice
}

/**
 * The Inbox's optimistic writes, as on iOS: the row moves at once, the
 * host's answer settles it, and a refusal puts back only what the write
 * changed. [row] and [publish] address the host the write was sent to, so a
 * refusal that arrives after a switch to another host still puts that
 * host's saved row back. [isCurrent] is false once the phone switched hosts:
 * a late answer then shows no snackbar and starts no reload.
 */
class AidenInboxTriage(
    private val row: (String) -> AidenChatSummary?,
    private val publish: suspend (AidenChatSummary) -> Unit,
    private val isCurrent: () -> Boolean,
    private val writeTriage: suspend (
        chatId: String, change: AidenChatTriageChange, ifRevision: Int, idempotencyKey: UUID
    ) -> AidenChatTriageResult,
    private val writeRead: suspend (chatId: String) -> Unit,
    private val reload: suspend () -> Unit,
    private val now: () -> Instant = Instant::now
) {
    /** Mark read from a swipe. The dot clears at once and comes back if the host refuses. */
    suspend fun markRead(chatId: String): AidenInboxNotice? {
        val before = row(chatId)?.takeIf { it.unread } ?: return null
        val optimistic = before.copy(unread = false).withoutHostPlacement()
        publish(optimistic)
        return try {
            writeRead(chatId)
            null
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            rollBack(chatId, optimistic, before)
            if (isCurrent()) AidenInboxNotice.MarkReadFailed() else null
        }
    }

    /**
     * Done, Snooze or their undo. Done or Snooze on unseen failed output
     * (not the open chat) also reads it, as on the desktop, so when the host
     * takes no read markers ([readsFailures] false) nothing is written.
     * A stale revision is sent once more from the host's revision with a new
     * idempotency key before it counts as a refusal. Returns the snackbar.
     */
    suspend fun setTriage(
        chatId: String,
        change: AidenChatTriageChange,
        readsFailures: Boolean,
        isOpen: Boolean = false,
        offersUndo: Boolean = true
    ): AidenInboxNotice? {
        val before = row(chatId) ?: return null
        val at = now()
        val alsoMarkRead = change.hidesRow && AidenInbox.alsoMarksRead(before, isOpen)
        if (alsoMarkRead && !readsFailures) return null
        val optimistic = AidenInbox.applyingOptimisticTriage(change, before, at, alsoMarkRead)
        publish(optimistic)
        val result = try {
            sendTriage(chatId, change, before.triageRevision ?: 0)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            rollBack(chatId, optimistic, before)
            if (!isCurrent()) return null
            if (AidenChatForkErrors.isRevisionConflict(error)) {
                reload()
                return AidenInboxNotice.Conflict()
            }
            return AidenInboxNotice.TriageFailed()
        }
        row(chatId)?.let { publish(AidenInbox.applyingTriageResult(result, it)) }
        if (alsoMarkRead) {
            try {
                writeRead(chatId)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                row(chatId)?.takeIf { !it.unread }?.let { publish(it.copy(unread = before.unread)) }
            }
        }
        if (!isCurrent() || !offersUndo) return null
        return AidenInbox.undo(change, before, at)?.let { AidenInboxNotice.Changed(change, chatId, it) }
    }

    private suspend fun sendTriage(chatId: String, change: AidenChatTriageChange, ifRevision: Int): AidenChatTriageResult =
        try {
            writeTriage(chatId, change, ifRevision, UUID.randomUUID())
        } catch (error: AidenRemoteClientException.Server) {
            val current = error.body.details?.currentRevision?.toIntOrNull()?.takeIf { it >= 0 }
            if (!AidenChatForkErrors.isRevisionConflict(error) || current == null || !isCurrent()) throw error
            writeTriage(chatId, change, current, UUID.randomUUID())
        }

    private suspend fun rollBack(chatId: String, optimistic: AidenChatSummary, before: AidenChatSummary) {
        val current = row(chatId) ?: return
        val restored = AidenInbox.rollingBack(current, optimistic, before)
        if (restored != current) publish(restored)
    }
}
