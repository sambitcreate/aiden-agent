package sbtbiswas.AidenOnTheGo.features.workspaces

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.time.Instant
import java.util.UUID

class AidenInboxTriageTest {
    private val now = Instant.parse("2026-09-09T12:00:00Z")

    private class Host(initial: AidenChatSummary) {
        val rows = mutableMapOf(initial.id to initial)
        val published = mutableListOf<AidenChatSummary>()
        val triageWrites = mutableListOf<Triple<String, AidenChatTriageChange, Int>>()
        val idempotencyKeys = mutableListOf<UUID>()
        val readWrites = mutableListOf<String>()
        var reloads = 0
        var current = true
        var triageAnswer: suspend (AidenChatTriageChange) -> AidenChatTriageResult = { error("unset") }
        var readAnswer: suspend () -> Unit = {}
        var viewStamp = 0L

        fun triage(now: Instant) = AidenInboxTriage(
            row = { rows[it] },
            publish = { rows[it.id] = it; published += it },
            isCurrent = { current },
            writeTriage = { id, change, revision, key ->
                triageWrites += Triple(id, change, revision)
                idempotencyKeys += key
                triageAnswer(change)
            },
            writeRead = { readWrites += it; readAnswer() },
            reload = { reloads += 1 },
            viewStamp = { viewStamp },
            now = { now }
        )
    }

    private fun row(unread: Boolean = false, failed: Boolean = false, revision: Int? = 2) = AidenChatSummary(
        id = "chat-1",
        workspaceId = "ws",
        title = "Chat",
        titlePending = false,
        createdAt = now.minusSeconds(3600),
        updatedAt = now.minusSeconds(60),
        revision = "rev",
        activity = AidenChatSummaryActivity.IDLE,
        unread = unread,
        lastRunFailed = failed,
        inboxBucketWire = if (failed) "needs_you" else "earlier",
        inboxSortAtWire = now.minusSeconds(60),
        triageRevision = revision
    )

    private fun conflict(currentRevision: String? = null) = AidenRemoteClientException.Server(
        409,
        AidenRemoteErrorEnvelope.Body(
            AidenRemoteErrorCode.REVISION_CONFLICT, "Changed.", "req_1", false,
            details = currentRevision?.let { AidenRemoteErrorEnvelope.Details(currentRevision = it) }
        )
    )

    @Test
    fun doneMovesTheRowBeforeTheHostAnswersAndOffersUndo() = runBlocking {
        val host = Host(row())
        val gate = CompletableDeferred<Unit>()
        host.triageAnswer = { gate.await(); AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        val pending = async { host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true) }
        yield()
        // Optimistic: Done is on the row while the write is in flight.
        assertEquals(now, host.rows.getValue("chat-1").doneAt)
        assertNull(host.rows.getValue("chat-1").inboxBucket)
        gate.complete(Unit)
        val notice = pending.await() as AidenInboxNotice.Changed
        assertEquals(AidenChatTriageChange.done(false), notice.undo)
        assertEquals(listOf(Triple("chat-1", AidenChatTriageChange.done(true), 2)), host.triageWrites)
        assertEquals(3, host.rows.getValue("chat-1").triageRevision)
        // Done on a row with no unseen failure never writes a read marker.
        assertTrue(host.readWrites.isEmpty())

        // Undo writes the reverse and offers no second Undo.
        host.triageAnswer = { AidenChatTriageResult("chat-1", 4, now) }
        assertNull(host.triage(now).setTriage("chat-1", notice.undo!!, readsFailures = true, offersUndo = false))
        assertEquals(3, host.triageWrites.last().third)
        assertNull(host.rows.getValue("chat-1").doneAt)
    }

    @Test
    fun aChatWithNoTriageYetWritesAgainstRevisionZero() = runBlocking {
        val host = Host(row(revision = null))
        host.triageAnswer = { AidenChatTriageResult("chat-1", 1, now, doneAt = now) }
        host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = false)
        assertEquals(0, host.triageWrites.single().third)
    }

    @Test
    fun aRefusedWritePutsTheRowBackAndAConflictReloads() = runBlocking {
        val original = row(unread = true, failed = true)
        val host = Host(original)
        host.triageAnswer = { throw IOException("offline") }
        val failed = host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
        assertTrue(failed is AidenInboxNotice.TriageFailed)
        val restored = host.rows.getValue("chat-1")
        assertNull(restored.doneAt)
        assertTrue(restored.unread)
        assertEquals(original.inboxBucket, restored.inboxBucket)
        assertEquals(0, host.reloads)
        assertTrue(host.readWrites.isEmpty())

        host.triageAnswer = { throw conflict() }
        val conflicted = host.triage(now).setTriage("chat-1", AidenChatTriageChange.snooze(now.plusSeconds(600)), readsFailures = true)
        assertTrue(conflicted is AidenInboxNotice.Conflict)
        assertEquals(1, host.reloads)
        assertNull(host.rows.getValue("chat-1").snoozedUntil)
    }

    @Test
    fun doneOnAnUnseenFailureAlsoReadsItWhenTheHostTakesReadMarkers() = runBlocking {
        val host = Host(row(unread = true, failed = true))
        host.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
        assertEquals(listOf("chat-1"), host.readWrites)
        assertFalse(host.rows.getValue("chat-1").unread)

        // Without read markers Done would hide a failure nobody saw, so
        // nothing is written and the row stays where it was.
        val older = Host(row(unread = true, failed = true))
        older.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        assertNull(older.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = false))
        assertTrue(older.triageWrites.isEmpty())
        assertTrue(older.published.isEmpty())
        assertNull(older.rows.getValue("chat-1").doneAt)

        // The open chat's failure is already seen: Done needs no read marker.
        older.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = false, isOpen = true)
        assertEquals(1, older.triageWrites.size)
        assertTrue(older.readWrites.isEmpty())

        // A refused read marker brings the dot back.
        val refused = Host(row(unread = true, failed = true))
        refused.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        refused.readAnswer = { throw IOException("offline") }
        refused.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
        assertTrue(refused.rows.getValue("chat-1").unread)
        assertEquals(now, refused.rows.getValue("chat-1").doneAt)
    }

    @Test
    fun markReadClearsTheDotAndRestoresItWhenRefused() = runBlocking {
        val host = Host(row(unread = true))
        assertNull(host.triage(now).markRead("chat-1"))
        assertFalse(host.rows.getValue("chat-1").unread)
        assertNull(host.triage(now).markRead("chat-1")) // already read: no write
        assertEquals(1, host.readWrites.size)

        val refused = Host(row(unread = true))
        refused.readAnswer = { throw IOException("offline") }
        assertTrue(refused.triage(now).markRead("chat-1") is AidenInboxNotice.MarkReadFailed)
        assertTrue(refused.rows.getValue("chat-1").unread)
    }

    @Test
    fun aStaleRevisionIsSentOnceMoreFromTheHostsRevisionWithANewKey() = runBlocking {
        val host = Host(row())
        var calls = 0
        host.triageAnswer = {
            calls += 1
            if (calls == 1) throw conflict(currentRevision = "7")
            AidenChatTriageResult("chat-1", 8, now, doneAt = now)
        }
        // The row's `before` predates the other device's write, so an Undo
        // built from it could erase that write: a retried write offers none.
        assertNull(host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true))
        assertEquals(now, host.rows.getValue("chat-1").doneAt)
        assertEquals(listOf(2, 7), host.triageWrites.map { it.third })
        assertEquals(2, host.idempotencyKeys.toSet().size)
        assertEquals(8, host.rows.getValue("chat-1").triageRevision)
        assertEquals(0, host.reloads)

        // A second conflict is a real one: the row goes back and the list reloads.
        val again = Host(row())
        again.triageAnswer = { throw conflict(currentRevision = "9") }
        assertTrue(again.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
            is AidenInboxNotice.Conflict)
        assertEquals(listOf(2, 9), again.triageWrites.map { it.third })
        assertEquals(1, again.reloads)
        assertNull(again.rows.getValue("chat-1").doneAt)
    }

    @Test
    fun aRefusalPutsBackOnlyWhatTheWriteStillHolds() = runBlocking {
        val host = Host(row())
        val gate = CompletableDeferred<Unit>()
        host.triageAnswer = { gate.await(); throw IOException("offline") }
        val pending = async {
            host.triage(now).setTriage("chat-1", AidenChatTriageChange.snooze(now.plusSeconds(3600)), readsFailures = true)
        }
        yield()
        // A reply and a pin land while the snooze is in flight.
        val reply = now.plusSeconds(5)
        host.rows["chat-1"] = host.rows.getValue("chat-1").copy(lastAssistantAt = reply, pinnedAt = now)
        gate.complete(Unit)
        assertTrue(pending.await() is AidenInboxNotice.TriageFailed)
        val restored = host.rows.getValue("chat-1")
        assertNull(restored.snoozedUntil)
        assertEquals(reply, restored.lastAssistantAt)
        assertEquals(now, restored.pinnedAt)
        // The row is not as the host placed it, so its old bucket stays dropped.
        assertNull(restored.inboxBucket)
    }

    @Test
    fun undoPutsBackWhatTheRowHeldBefore() = runBlocking {
        val earlierSnooze = now.plusSeconds(1800)
        val host = Host(row().copy(snoozedUntil = earlierSnooze))
        host.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, snoozedUntil = now.plusSeconds(7200)) }
        val notice = host.triage(now).setTriage("chat-1", AidenChatTriageChange.snooze(now.plusSeconds(7200)), readsFailures = true)
            as AidenInboxNotice.Changed
        // Undo returns to the snooze that was still running, not to awake.
        assertEquals(AidenChatTriageChange.snooze(earlierSnooze), notice.undo)

        // Done on a row whose earlier Done ended (a newer reply) undoes to not done.
        val reopened = Host(row().copy(doneAt = now.minusSeconds(600), lastAssistantAt = now.minusSeconds(60)))
        reopened.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        val done = reopened.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
            as AidenInboxNotice.Changed
        assertEquals(AidenChatTriageChange.done(false), done.undo)
    }

    @Test
    fun aLateRefusalAfterSwitchingHostsStillPutsBackThatHostsRow() = runBlocking {
        // [Host.rows] stands for the first host's saved rows, which the write keeps addressing.
        val host = Host(row())
        host.triageAnswer = { host.current = false; throw IOException("gone") }
        assertNull(host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true))
        assertNull(host.rows.getValue("chat-1").doneAt)
        assertEquals(row().inboxBucket, host.rows.getValue("chat-1").inboxBucket)
        // No snackbar and no reload for a host the phone has left.
        assertEquals(0, host.reloads)
    }

    @Test
    fun aChatViewedWhileItsWriteWasOutStaysReadWhenTheHostRefuses() = runBlocking {
        // Mark read refused after the chat was opened: the dot stays off.
        val read = Host(row(unread = true))
        read.readAnswer = { read.viewStamp += 1; throw IOException("offline") }
        assertTrue(read.triage(now).markRead("chat-1") is AidenInboxNotice.MarkReadFailed)
        assertFalse(read.rows.getValue("chat-1").unread)

        // Done on an unseen failure refused after the chat was opened: Done
        // goes back, the read stays.
        val done = Host(row(unread = true, failed = true))
        done.triageAnswer = { done.viewStamp += 1; throw IOException("offline") }
        assertTrue(done.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
            is AidenInboxNotice.TriageFailed)
        assertNull(done.rows.getValue("chat-1").doneAt)
        assertFalse(done.rows.getValue("chat-1").unread)

        // Its read marker refused after the chat was opened: still read.
        val marker = Host(row(unread = true, failed = true))
        marker.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        marker.readAnswer = { marker.viewStamp += 1; throw IOException("offline") }
        marker.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true)
        assertFalse(marker.rows.getValue("chat-1").unread)
    }

    @Test
    fun aWriteThatLandsAfterSwitchingHostsStillSendsItsReadMarker() = runBlocking {
        val host = Host(row(unread = true, failed = true))
        host.triageAnswer = { host.current = false; AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        // No snackbar for a host the phone has left, but the old host still
        // learns the failure was read, so it doesn't stay unseen there.
        assertNull(host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true))
        assertEquals(listOf("chat-1"), host.readWrites)
    }

    @Test
    fun aConfirmationGoesStaleAfterTheDesktopsUndoWindow() {
        val notice = AidenInboxNotice.Changed(AidenChatTriageChange.done(true), "chat-1", AidenChatTriageChange.done(false), postedAt = now)
        assertFalse(notice.isStale(now.plusMillis(4_999)))
        // The desktop's window closes at five seconds exactly.
        assertTrue(notice.isStale(now.plusSeconds(5)))
    }
}
