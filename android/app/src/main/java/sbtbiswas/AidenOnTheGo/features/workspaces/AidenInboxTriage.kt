package sbtbiswas.AidenOnTheGo.features.workspaces

import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.models.AidenInbox
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
 * host's answer settles it, and a refusal puts it back. [isCurrent] is false
 * once the phone switched hosts, so a late answer never touches the new list.
 */
class AidenInboxTriage(
    private val row: (String) -> AidenChatSummary?,
    private val publish: suspend (AidenChatSummary) -> Unit,
    private val isCurrent: () -> Boolean,
    private val writeTriage: suspend (chatId: String, change: AidenChatTriageChange, ifRevision: Int) -> AidenChatTriageResult,
    private val writeRead: suspend (chatId: String) -> Unit,
    private val reload: suspend () -> Unit,
    private val now: () -> Instant = Instant::now
) {
    /** Mark read from a swipe. The dot clears at once and comes back if the host refuses. */
    suspend fun markRead(chatId: String): AidenInboxNotice? {
        val before = row(chatId)?.takeIf { it.unread } ?: return null
        publish(before.copy(unread = false).withoutHostPlacement())
        return try {
            writeRead(chatId)
            null
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            if (!isCurrent()) return null
            row(chatId)?.let { publish(it.copy(unread = true)) }
            AidenInboxNotice.MarkReadFailed()
        }
    }

    /**
     * Done, Snooze or their undo. Done on unseen failed output also reads it
     * when [readsFailures] (the host takes read markers), as on the desktop.
     * Returns the snackbar to show, if any.
     */
    suspend fun setTriage(
        chatId: String,
        change: AidenChatTriageChange,
        readsFailures: Boolean,
        offersUndo: Boolean = true
    ): AidenInboxNotice? {
        val before = row(chatId) ?: return null
        val alsoMarkRead = change.done == true && before.showsFailed && readsFailures
        publish(AidenInbox.applyingOptimisticTriage(change, before, now(), alsoMarkRead))
        val result = try {
            writeTriage(chatId, change, before.triageRevision ?: 0)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            if (!isCurrent()) return null
            row(chatId)?.let { current ->
                publish(
                    current.withInboxSignals(before).copy(
                        unread = before.unread,
                        inboxBucketWire = before.inboxBucketWire,
                        inboxSortAtWire = before.inboxSortAtWire
                    )
                )
            }
            if (AidenChatForkErrors.isRevisionConflict(error)) {
                reload()
                return AidenInboxNotice.Conflict()
            }
            return AidenInboxNotice.TriageFailed()
        }
        if (!isCurrent()) return null
        row(chatId)?.let { publish(AidenInbox.applyingTriageResult(result, it)) }
        if (alsoMarkRead) {
            try {
                writeRead(chatId)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                if (isCurrent()) row(chatId)?.let { publish(it.copy(unread = before.unread)) }
            }
        }
        val undo = change.undo
        return if (offersUndo && undo != null) AidenInboxNotice.Changed(change, chatId, undo) else null
    }
}
