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

class AidenInboxTriageTest {
    private val now = Instant.parse("2026-09-09T12:00:00Z")

    private class Host(initial: AidenChatSummary) {
        val rows = mutableMapOf(initial.id to initial)
        val published = mutableListOf<AidenChatSummary>()
        val triageWrites = mutableListOf<Triple<String, AidenChatTriageChange, Int>>()
        val readWrites = mutableListOf<String>()
        var reloads = 0
        var current = true
        var triageAnswer: suspend (AidenChatTriageChange) -> AidenChatTriageResult = { error("unset") }
        var readAnswer: suspend () -> Unit = {}

        fun triage(now: Instant) = AidenInboxTriage(
            row = { rows[it] },
            publish = { rows[it.id] = it; published += it },
            isCurrent = { current },
            writeTriage = { id, change, revision -> triageWrites += Triple(id, change, revision); triageAnswer(change) },
            writeRead = { readWrites += it; readAnswer() },
            reload = { reloads += 1 },
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

    private fun conflict() = AidenRemoteClientException.Server(
        409, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.REVISION_CONFLICT, "Changed.", "req_1", false)
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

        // Without read markers the failure stays unseen.
        val older = Host(row(unread = true, failed = true))
        older.triageAnswer = { AidenChatTriageResult("chat-1", 3, now, doneAt = now) }
        older.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = false)
        assertTrue(older.readWrites.isEmpty())
        assertTrue(older.rows.getValue("chat-1").unread)

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
    fun aLateAnswerAfterSwitchingHostsLeavesTheNewListAlone() = runBlocking {
        val host = Host(row())
        host.triageAnswer = { host.current = false; throw IOException("gone") }
        assertNull(host.triage(now).setTriage("chat-1", AidenChatTriageChange.done(true), readsFailures = true))
        // Only the optimistic publish happened; no rollback was written into the new host's list.
        assertEquals(1, host.published.size)
    }
}
