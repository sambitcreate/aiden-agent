package sbtbiswas.AidenOnTheGo.features.workspaces

import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.models.AidenInbox
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** One Inbox snackbar after a swipe. The screen words it. */
sealed interface AidenInboxNotice {
    val id: UUID

    /**
     * The change landed; [undo] puts it back. Undo is meant for right after
     * the swipe, as on the desktop: a notice still unshown (or shown again
     * on returning to the screen) once [UNDO_WINDOW] passed is dropped.
     */
    data class Changed(
        val change: AidenChatTriageChange,
        val chatId: String,
        val undo: AidenChatTriageChange?,
        val postedAt: Instant = Instant.now(),
        override val id: UUID = UUID.randomUUID()
    ) : AidenInboxNotice {
        fun isStale(now: Instant): Boolean = !now.isBefore(staleAt)

        /** When the Undo window closes. */
        val staleAt: Instant get() = postedAt.plus(UNDO_WINDOW)
    }

    /** The host refused the change; the row is back where it was. */
    data class TriageFailed(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    /** The row's triage changed elsewhere; the list was reloaded. */
    data class Conflict(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    /**
     * An Undo met a newer write from another device, so it was not sent
     * again: the row was left as that write made it and the list reloaded.
     */
    data class UndoConflict(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    /** Mark read failed; the unread dot is back. */
    data class MarkReadFailed(override val id: UUID = UUID.randomUUID()) : AidenInboxNotice

    companion object {
        /** The desktop's Undo window (`INBOX_TRIAGE_UNDO_MS`). */
        val UNDO_WINDOW: Duration = Duration.ofSeconds(5)
    }
}

/**
 * The Inbox's optimistic writes, as on iOS: the row moves at once, the
 * host's answer settles it, and a refusal puts back only what the write
 * changed. [row] and [publish] address the host the write was sent to, so a
 * refusal that arrives after a switch to another host still puts that
 * host's saved row back. [isCurrent] is false once the phone switched hosts:
 * a late answer then shows no snackbar and starts no reload. [viewStamp]
 * changes each time the chat is viewed: a chat viewed while its write was out
 * is read, so a refusal never brings its unread dot back.
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
    private val viewStamp: (String) -> Long = { 0L },
    private val now: () -> Instant = Instant::now
) {
    /**
     * Mark read from a swipe. The dot clears at once and comes back if the
     * host refuses. A host without read markers ([readsState] false) is not
     * written to and the dot stays.
     */
    suspend fun markRead(chatId: String, readsState: Boolean): AidenInboxNotice? {
        if (!readsState) return null
        val before = row(chatId)?.takeIf { it.unread } ?: return null
        val viewed = viewStamp(chatId)
        val optimistic = before.copy(unread = false).withoutHostPlacement()
        publish(optimistic)
        return try {
            writeRead(chatId)
            null
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            rollBack(chatId, optimistic, before, viewed)
            if (isCurrent()) AidenInboxNotice.MarkReadFailed() else null
        }
    }

    /**
     * Done, Snooze or their undo. Done or Snooze on unseen failed output
     * (not the open chat) also reads it, as on the desktop, so when the host
     * takes no read markers ([readsFailures] false) nothing is written.
     * A swipe's stale revision is sent once more from the host's revision
     * with a new idempotency key before it counts as a refusal; a write that
     * landed that way offers no Undo, since [before] may no longer be what
     * the host held (the desktop never retries). An Undo ([offersUndo]
     * false) is never retried: its revision is the one its own write left,
     * so a conflict means another device changed the chat since, and the
     * Undo leaves it as that device made it. Returns the snackbar.
     */
    suspend fun setTriage(
        chatId: String,
        change: AidenChatTriageChange,
        readsFailures: Boolean,
        isOpen: Boolean = false,
        offersUndo: Boolean = true
    ): AidenInboxNotice? {
        val before = row(chatId) ?: return null
        val viewed = viewStamp(chatId)
        val at = now()
        val alsoMarkRead = change.hidesRow && AidenInbox.alsoMarksRead(before, isOpen)
        if (alsoMarkRead && !readsFailures) return null
        val optimistic = AidenInbox.applyingOptimisticTriage(change, before, at, alsoMarkRead)
        publish(optimistic)
        val (result, retried) = try {
            sendTriage(chatId, change, before.triageRevision ?: 0, retriesConflict = offersUndo)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            rollBack(chatId, optimistic, before, viewed)
            if (!isCurrent()) return null
            if (AidenChatForkErrors.isRevisionConflict(error)) {
                reload()
                return if (offersUndo) AidenInboxNotice.Conflict() else AidenInboxNotice.UndoConflict()
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
                if (viewStamp(chatId) == viewed) {
                    row(chatId)?.takeIf { !it.unread }?.let { publish(it.copy(unread = before.unread)) }
                }
            }
        }
        if (!isCurrent() || !offersUndo || retried) return null
        return AidenInbox.undo(change, before, at)?.let { AidenInboxNotice.Changed(change, chatId, it, postedAt = now()) }
    }

    /** The host's answer, and whether it came from the one retry. */
    private suspend fun sendTriage(
        chatId: String, change: AidenChatTriageChange, ifRevision: Int, retriesConflict: Boolean
    ): Pair<AidenChatTriageResult, Boolean> =
        try {
            writeTriage(chatId, change, ifRevision, UUID.randomUUID()) to false
        } catch (error: AidenRemoteClientException.Server) {
            val current = error.body.details?.currentRevision?.toIntOrNull()?.takeIf { it >= 0 }
            if (!retriesConflict || !AidenChatForkErrors.isRevisionConflict(error) || current == null || !isCurrent()) throw error
            writeTriage(chatId, change, current, UUID.randomUUID()) to true
        }

    private suspend fun rollBack(chatId: String, optimistic: AidenChatSummary, before: AidenChatSummary, viewed: Long) {
        val current = row(chatId) ?: return
        val restored = AidenInbox.rollingBack(current, optimistic, before, restoresUnread = viewStamp(chatId) == viewed)
        if (restored != current) publish(restored)
    }
}
